import { createHash } from 'node:crypto';

/**
 * SSH 公钥与授权命令
 *
 * 这个模块只做四件事：解析公钥、算指纹、生成命令文本、预检危险操作。
 * 它不碰数据库、不发网络请求 —— 因为它是整套 SSH 管理里最该有测试的一段，
 * 而带副作用的代码测起来总是要先搭一堆脚手架。
 *
 * ——————————————————————————————————————————————
 *
 * 三条贯穿始终的规矩：
 *
 * 1. **面板不改 sshd_config，也不重启 sshd。** authorized_keys 是即时生效、
 *    无需重启的，这正是它可以被安全操作的原因。改配置再重启则是另一个量级：
 *    写错一个字母，sshd 起不来，没有救援控制台这台机器就废了。
 *
 * 2. **只管自己写的 key。** 写进去的每一行 comment 都带 `sonar:` 前缀，
 *    删除时只认这个前缀。手工加的、别的工具加的，一律不碰。
 *
 * 3. **公钥原文只在生成命令时用，从机器上扫回来的实况只存指纹。**
 *    公钥本身不是秘密，但"哪些公钥能进哪些机器"的完整地图对定向攻击极有价值。
 */

// ————————————————————————————————————————————————————————
// 公钥解析
// ————————————————————————————————————————————————————————

/**
 * 认得的公钥类型。
 *
 * 白名单而不是"能解析就行"：不在这张表上的类型，要么是早该淘汰的（ssh-dss 在
 * OpenSSH 7.0 起默认就关了），要么是我们没验证过的。写进 authorized_keys 的东西
 * 宁可少认几种，也不要塞进去一行 sshd 拒绝解析、进而可能让整个文件失效的内容。
 */
const KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  // 硬件密钥（FIDO/U2F），OpenSSH 8.2+
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

export interface ParsedKey {
  /** 规范化后的类型，如 ssh-ed25519 */
  type: string;
  /** base64 的密钥主体，不含类型和注释 */
  blob: string;
  /** 原始注释，可能为空 */
  comment: string;
  /** SHA256:xxx，和 ssh-keygen -lf 的输出一致 */
  fingerprint: string;
  /** 规范化后的单行公钥：类型 + blob + 注释 */
  normalized: string;
  /** 位数，仅 RSA 有意义；其它类型为 0 */
  bits: number;
}

export class SshKeyError extends Error {}

/**
 * 解析一行 OpenSSH 格式的公钥。
 *
 * 格式是 `<类型> <base64> [注释]`，前面还可能有一串逗号分隔的选项
 * （from=、command=、expiry-time= 之类）。这里**不接受带选项的行** ——
 * 用户粘进来的应该是他 .pub 文件里那一行，带选项说明他多半复制错了地方
 * （从 authorized_keys 里抄的），而那一行里的选项会被原样写到目标机器上。
 */
export function parsePublicKey(input: string): ParsedKey {
  const line = String(input ?? '').trim();
  if (!line) throw new SshKeyError('公钥不能为空');

  /*
   * 私钥要第一个检查。
   *
   * 它天然是多行的，放在换行检查后面的话，粘错私钥的人只会看到"必须是一行" ——
   * 那句话会引导他去把私钥拼成一行再试一次。这是这个输入框最危险的误操作，
   * 必须给最明确的提示。
   */
  if (/PRIVATE KEY/i.test(line)) {
    throw new SshKeyError('这是私钥，不是公钥。私钥永远不要贴到任何地方，包括这里 —— 请改用同名的 .pub 文件');
  }

  // 换行是最常见的粘贴事故：从网页复制时容易带上折行
  if (/[\r\n]/.test(line)) {
    throw new SshKeyError('公钥必须是一行。从 .pub 文件里复制时注意不要带上换行');
  }

  const parts = line.split(/\s+/);
  if (parts.length < 2) {
    throw new SshKeyError('格式不对，应该是「类型 base64 [注释]」，例如 ssh-ed25519 AAAAC3Nza... you@mac');
  }

  const [type, blob, ...rest] = parts as [string, string, ...string[]];

  if (!KEY_TYPES.has(type)) {
    throw new SshKeyError(`不支持的密钥类型 ${type}。支持：${[...KEY_TYPES].join('、')}`);
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(blob, 'base64');
  } catch {
    throw new SshKeyError('base64 部分无法解码');
  }
  // Node 的 base64 解码很宽容，非法字符会被静默丢弃。回编码比对一次才能确认它真的合法
  if (raw.length === 0 || raw.toString('base64').replace(/=+$/, '') !== blob.replace(/=+$/, '')) {
    throw new SshKeyError('base64 部分不合法');
  }

  /*
   * 校验 blob 里自带的类型和外面写的一致。
   *
   * OpenSSH 的 wire format 是 [4字节大端长度][数据] 的重复。第一段就是类型字符串，
   * 它和行首那个词本该相同 —— 不同就说明这一行是拼接出来的，
   * 而 sshd 认的是 blob 里那个。
   */
  const inner = readString(raw, 0);
  if (!inner || inner.value !== type) {
    throw new SshKeyError('公钥内容与声明的类型不一致');
  }

  const comment = rest.join(' ').trim();
  return {
    type,
    blob,
    comment,
    fingerprint: fingerprintOf(raw),
    normalized: comment ? `${type} ${blob} ${comment}` : `${type} ${blob}`,
    bits: type === 'ssh-rsa' ? rsaBits(raw) : 0,
  };
}

/** 读一段 [4字节长度][数据]，返回字符串和下一个偏移。越界返回 null。 */
function readString(buf: Buffer, offset: number): { value: string; next: number } | null {
  if (offset + 4 > buf.length) return null;
  const len = buf.readUInt32BE(offset);
  const start = offset + 4;
  // 长度字段来自不可信输入，不能拿它直接去切
  if (len > buf.length - start) return null;
  return { value: buf.subarray(start, start + len).toString('utf8'), next: start + len };
}

/**
 * SHA256 指纹，格式与 `ssh-keygen -lf` 一致。
 *
 * 去掉 base64 的 `=` 填充 —— OpenSSH 就是这么打印的，留着的话人拿去和终端里
 * 的输出对照会发现多了一截，进而怀疑是不是不同的 key。
 */
export function fingerprintOf(raw: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');
}

/** RSA 的模数位数。第二段是 e，第三段是 n，n 的字节数减去前导零字节即为位数来源。 */
function rsaBits(raw: Buffer): number {
  const t = readString(raw, 0);
  if (!t) return 0;
  const e = readString(raw, t.next);
  if (!e) return 0;
  if (e.next + 4 > raw.length) return 0;
  const nLen = raw.readUInt32BE(e.next);
  const start = e.next + 4;
  if (nLen > raw.length - start) return 0;
  let i = start;
  // mpint 会给最高位是 1 的数补一个前导 0 字节，算位数时要跳过
  while (i < start + nLen && raw[i] === 0) i++;
  const bytes = start + nLen - i;
  if (bytes === 0) return 0;
  const top = raw[i]!;
  return (bytes - 1) * 8 + (32 - Math.clz32(top));
}

// ————————————————————————————————————————————————————————
// 命令生成
// ————————————————————————————————————————————————————————

/**
 * Sonar 写进 authorized_keys 的 comment 前缀。
 *
 * 这是整套方案的锚点：对账靠它区分"我装的"和"别人装的"，删除只认带它的行。
 * 改动它等于让面板忘记自己装过什么，所以它不是配置项。
 */
export const SONAR_TAG = 'sonar';

/** comment 会进 shell 命令，也会写进目标机器的文件，只允许最保守的一组字符。 */
const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;

export interface GrantTarget {
  /** 目标机器上的账号，如 root */
  remoteUser: string;
  /** 机器标识，进 comment 用于对账 */
  nodeId: string;
  /** 密钥所有者的登录名，进 comment 用于追溯 */
  owner: string;
  /** YYYYMMDD，进 comment */
  day: string;
}

function assertSafe(value: string, what: string): string {
  const v = String(value ?? '').trim();
  if (!SAFE_TOKEN.test(v)) {
    throw new SshKeyError(`${what}只能包含字母、数字、点、下划线、连字符，当前值：${v || '(空)'}`);
  }
  return v;
}

/** 这一条授权在 authorized_keys 里的 comment。同时也是删除时的匹配依据之一。 */
export function grantComment(t: GrantTarget): string {
  return [
    SONAR_TAG,
    assertSafe(t.owner, '所有者'),
    assertSafe(t.nodeId, '机器标识'),
    assertSafe(t.day, '日期'),
  ].join(':');
}

/**
 * 生成授权命令。
 *
 * 刻意生成**人能看懂的原生 shell**，而不是 `curl | bash`。理由很实在：
 * 这条命令修改的是目标机器的信任根，让人执行一个看不懂的脚本去改自己的信任根，
 * 本身就是讽刺。装 agent 用 curl|bash 是合理的（那是装软件），装 SSH key 不是。
 *
 * 每一行都在解决一种具体的翻车方式，见行内注释。
 */
export function grantCommands(key: ParsedKey, t: GrantTarget, expiresAt = 0): string[] {
  const user = assertSafe(t.remoteUser, '远程账号');
  const comment = grantComment(t);

  /*
   * expiry-time 是 OpenSSH 7.7（2018-02）引入的 authorized_keys 选项，到点 sshd
   * 自己拒绝这把 key —— 和封禁把 TTL 交给内核是同一个思路：面板挂了也照常失效。
   *
   * 但低于 7.7 的 sshd 会把整行当成坏选项**整行拒绝**，那把 key 直接失效。
   * 所以调用方必须先确认版本（见 preflightGrant），拿不准就不要传 expiresAt。
   */
  const prefix = expiresAt > 0 ? `expiry-time="${expiryStamp(expiresAt)}",` : '';
  const line = `${prefix}${key.type} ${key.blob} ${comment}`;

  return [
    `u=${user}; h=$(getent passwd "$u" | cut -d: -f6) || { echo "用户 $u 不存在"; exit 1; }`,
    // 目录/文件权限不对时 sshd 会**静默拒绝**整个文件，这是 authorized_keys 失效的头号原因
    `install -d -m 700 -o "$u" -g "$(id -gn "$u")" "$h/.ssh"`,
    `touch "$h/.ssh/authorized_keys" && chown "$u" "$h/.ssh/authorized_keys" && chmod 600 "$h/.ssh/authorized_keys"`,
    // grep -qF 保证幂等：重复执行不会追加出十行一样的 key。用 >> 而不是 >，绝不覆盖别人的
    `grep -qF '${key.blob}' "$h/.ssh/authorized_keys" || echo '${line}' >> "$h/.ssh/authorized_keys"`,
  ];
}

/**
 * 生成撤销命令。
 *
 * 先备份再改。authorized_keys 是这台机器的门钥匙串，任何一次误删的代价都是
 * "再也进不来"，留一份带时间戳的副本几乎没有成本。
 */
export function revokeCommands(key: ParsedKey, t: Pick<GrantTarget, 'remoteUser' | 'day'>): string[] {
  const user = assertSafe(t.remoteUser, '远程账号');
  const day = assertSafe(t.day, '日期');
  return [
    `u=${user}; h=$(getent passwd "$u" | cut -d: -f6) || { echo "用户 $u 不存在"; exit 1; }`,
    `f="$h/.ssh/authorized_keys"; [ -f "$f" ] || { echo "没有 authorized_keys，无需处理"; exit 0; }`,
    `cp "$f" "$f.sonar-bak.${day}"`,
    `grep -vF '${key.blob}' "$f.sonar-bak.${day}" > "$f"`,
    `chmod 600 "$f"`,
  ];
}

/** authorized_keys 的 expiry-time 取 YYYYMMDDHHMM，带 Z 表示按 UTC 解释。 */
function expiryStamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`
  );
}

/** sshd 版本能不能认 expiry-time。低于 7.7 会整行拒绝，那把 key 会直接失效。 */
export function supportsExpiry(sshdVersion: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(String(sshdVersion ?? ''));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 7 || (major === 7 && minor >= 7);
}

// ————————————————————————————————————————————————————————
// 预检
// ————————————————————————————————————————————————————————

export interface SshPreflight {
  allowed: boolean;
  /** 阻止执行的硬性原因 */
  blockers: string[];
  /** 不阻止但需要人看一眼的提醒 */
  warnings: string[];
}

export interface HostFacts {
  /** agent 上报的 sshd 版本，空串表示还没上报过 */
  sshdVersion: string;
  /** 该账号 authorized_keys 里实际存在的指纹 */
  observedFingerprints: string[];
  /** 其中带 sonar: 前缀的那些 */
  managedFingerprints: string[];
  /** sshd 是否允许密码登录。null 表示未知 */
  passwordAuth: boolean | null;
  /** 实况的采集时刻，0 表示从未采集 */
  observedAt: number;
  /** agent 是否在线 */
  agentOnline: boolean;
}

/** 实况超过这个时长就不能作为删除决策的依据。过期的实况比没有实况更危险。 */
export const FACTS_STALE_MS = 10 * 60_000;

export function preflightGrant(input: {
  key: ParsedKey;
  facts: HostFacts;
  expiresAt: number;
}): SshPreflight {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const { key, facts, expiresAt } = input;

  if (facts.observedFingerprints.includes(key.fingerprint)) {
    warnings.push('这把公钥已经在目标机器上了，再执行一次不会有任何变化');
  }

  if (expiresAt > 0) {
    if (!facts.sshdVersion) {
      warnings.push('还没采集到目标机器的 sshd 版本，无法确认它支持 expiry-time。有效期将由 agent 本地到期清理来保证');
    } else if (!supportsExpiry(facts.sshdVersion)) {
      // 这一条如果漏掉，写进去的 key 会被 sshd 整行拒绝 —— 表现是"授权了却连不上"
      blockers.push(
        `目标机器的 sshd 是 ${facts.sshdVersion}，低于 7.7 不认 expiry-time，写进去会让整把 key 失效。请取消有效期，或改用 agent 下发（由 agent 本地到期清理）`,
      );
    }
    if (expiresAt <= Date.now()) {
      blockers.push('有效期已经是过去的时间');
    }
  }

  if (key.type === 'ssh-rsa' && key.bits > 0 && key.bits < 2048) {
    blockers.push(`RSA ${key.bits} 位强度不足，请换用 ed25519 或至少 3072 位的 RSA`);
  }

  return { allowed: blockers.length === 0, blockers, warnings };
}

/**
 * 撤销预检 —— 整个 SSH 管理里最危险的一步。
 *
 * 新增一把 key 最坏是多了个入口，删错一把的后果是**再也进不来**，
 * 而且没有任何界面能撤销它。所以这里的判断比授权那边严得多。
 */
export function preflightRevoke(input: {
  fingerprint: string;
  facts: HostFacts;
  /**
   * 要撤销的这把钥匙是不是操作者自己的。
   *
   * 面板无从知道他此刻正用哪把钥匙连着那台机器 —— 它看到的是浏览器会话，
   * 不是 ssh 会话。所以只能回答一个更弱但诚实的问题：这把钥匙归谁。
   */
  operatorOwnsKey?: boolean;
  now?: number;
}): SshPreflight {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const { fingerprint, facts, operatorOwnsKey } = input;
  const now = input.now ?? Date.now();

  /*
   * 没有实况就不许删。
   *
   * 删除的每一条判断（是不是最后一把、密码登录开没开）都建立在实况上。
   * 拿一份三天前的快照去做决策，比不做决策更危险 —— 因为人会以为它是准的。
   */
  if (facts.observedAt === 0) {
    blockers.push('还没有采集到这台机器的实况，无法判断删除是否安全。请等 agent 上报后再操作');
  } else if (now - facts.observedAt > FACTS_STALE_MS) {
    const mins = Math.round((now - facts.observedAt) / 60_000);
    blockers.push(`实况是 ${mins} 分钟前的，已经过期。agent 可能已离线，此时删除等于盲操作`);
  }

  if (!facts.agentOnline && facts.observedAt > 0) {
    warnings.push('agent 当前离线，撤销命令需要你手工到机器上执行');
  }

  if (facts.observedAt > 0 && !facts.observedFingerprints.includes(fingerprint)) {
    warnings.push('这把公钥已经不在目标机器上了，面板记录与实况不一致。执行撤销只会清掉面板这边的记录');
  }

  /*
   * 自伤检查一：这是你自己的钥匙。
   *
   * 只提醒不拦截 —— 换钥匙、清理旧设备都是完全正常的操作，
   * 而"这是不是你此刻正在用的那一把"面板真的判断不了。
   * 真正致命的那种情况（删完就没钥匙了）由下面那条负责硬拦。
   */
  if (operatorOwnsKey) {
    warnings.push('这是你自己的公钥。如果你此刻正用它连着这台机器，撤销后当前连接不受影响，但下次就连不上了');
  }

  /*
   * 自伤检查二：最后一把可用的 key。
   *
   * 只有在能确认密码登录被关掉时才升级为 blocker —— 密码登录还开着的话，
   * 删光 key 仍然有路进去，那是个可以接受的选择。passwordAuth 为 null
   * 表示采不到，此时按最坏情况处理。
   */
  const remaining = facts.observedFingerprints.filter((f) => f !== fingerprint);
  if (facts.observedAt > 0 && remaining.length === 0) {
    if (facts.passwordAuth === false) {
      blockers.push('这是这台机器上最后一把公钥，而密码登录已被关闭 —— 删掉之后没有任何方式能再登进去');
    } else if (facts.passwordAuth === null) {
      blockers.push('这是最后一把公钥，而面板无法确认密码登录是否开启。删除前请先确认你还有别的登录方式');
    } else {
      warnings.push('这是最后一把公钥，删除后只能用密码登录');
    }
  }

  return { allowed: blockers.length === 0, blockers, warnings };
}
