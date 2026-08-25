import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SshKeyError,
  fingerprintOf,
  grantCommands,
  grantComment,
  parsePublicKey,
  preflightGrant,
  preflightRevoke,
  revokeCommands,
  supportsExpiry,
  type HostFacts,
} from './ssh.js';
import { configSnippet, hostBlock, knownHostsEntries, validateAlias } from './ssh-config.js';

/*
 * SSH 公钥解析、指纹、命令生成与预检。
 *
 * 这一组测试锁的是"错了就再也进不去"的行为。指纹算错会让对账全盘失真；
 * 命令少一个 chmod 会让 sshd 静默拒绝整个文件；预检漏一条会让人删掉
 * 最后一把钥匙 —— 而那之后没有任何界面能撤销它。
 */

// 真实的测试向量。指纹用 ssh-keygen 交叉验证过（见下面那个测试）
const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7WlB7Zj0y5V6bJ8vXNLgKQ3wYfTzKqK5nFqYqXmZ8P test@example';

// ————————————————————————————————————————————————————————
// 解析
// ————————————————————————————————————————————————————————

test('解析 ed25519 公钥', () => {
  const k = parsePublicKey(ED25519);
  assert.equal(k.type, 'ssh-ed25519');
  assert.equal(k.comment, 'test@example');
  assert.match(k.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(k.bits, 0, 'ed25519 没有可变位数');
});

test('指纹与 ssh-keygen 的输出逐字一致', (t) => {
  // 没装 openssh 就跳过，而不是让整个测试套失败
  let out: string;
  const dir = mkdtempSync(join(tmpdir(), 'sonar-ssh-'));
  try {
    const p = join(dir, 'k.pub');
    writeFileSync(p, ED25519 + '\n');
    out = execFileSync('ssh-keygen', ['-lf', p], { encoding: 'utf8' });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return t.skip('本机没有 ssh-keygen');
  }

  // 输出形如：256 SHA256:xxxx test@example (ED25519)
  const expected = /(SHA256:[^\s]+)/.exec(out)?.[1];
  rmSync(dir, { recursive: true, force: true });

  assert.equal(
    parsePublicKey(ED25519).fingerprint,
    expected,
    '指纹算错的话，对账、去重、删除匹配会全盘失真',
  );
});

test('拒绝私钥', () => {
  assert.throws(
    () => parsePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz\n-----END'),
    /私钥/,
  );
});

test('拒绝多行输入', () => {
  assert.throws(() => parsePublicKey(ED25519 + '\n' + ED25519), /必须是一行/);
});

test('拒绝不支持的类型', () => {
  assert.throws(() => parsePublicKey('ssh-dss AAAAB3NzaC1kc3M= x'), /不支持的密钥类型/);
});

test('拒绝类型与内容不符的拼接公钥', () => {
  // 拿 ed25519 的 blob 冒充 rsa —— blob 里第一段自带类型，对不上就该拒绝
  const blob = ED25519.split(' ')[1]!;
  assert.throws(() => parsePublicKey(`ssh-rsa ${blob} x`), /与声明的类型不一致/);
});

test('拒绝非法 base64', () => {
  assert.throws(() => parsePublicKey('ssh-ed25519 !!!!not-base64!!!! x'), SshKeyError);
});

test('注释可以为空', () => {
  const k = parsePublicKey(ED25519.split(' ').slice(0, 2).join(' '));
  assert.equal(k.comment, '');
  assert.equal(k.normalized.split(' ').length, 2);
});

test('指纹对同一把钥匙稳定，与注释无关', () => {
  const a = parsePublicKey(ED25519);
  const b = parsePublicKey(ED25519.replace('test@example', '完全不同的注释'));
  assert.equal(a.fingerprint, b.fingerprint, '注释不属于密钥本体，不该影响指纹');
});

// ————————————————————————————————————————————————————————
// 命令生成
// ————————————————————————————————————————————————————————

const TARGET = { remoteUser: 'root', nodeId: 'hkg-edge-01', owner: 'alice', day: '20260825' };

test('授权命令包含全部四道保护', () => {
  const cmds = grantCommands(parsePublicKey(ED25519), TARGET).join('\n');

  assert.match(cmds, /install -d -m 700/, '目录权限不对时 sshd 会静默拒绝整个文件');
  assert.match(cmds, /chmod 600/, '文件权限同理');
  assert.match(cmds, /grep -qF .* \|\| echo/, '必须幂等，否则重复执行会追加出多行');
  assert.match(cmds, />>/, '必须追加');
  assert.doesNotMatch(cmds, /[^>]>[^>]/, '绝不能出现单个 > —— 那会覆盖掉别人已有的钥匙');
});

test('写进去的 comment 带 sonar 前缀，这是对账与安全删除的锚点', () => {
  const c = grantComment(TARGET);
  assert.equal(c, 'sonar:alice:hkg-edge-01:20260825');
  assert.match(grantCommands(parsePublicKey(ED25519), TARGET).join('\n'), /sonar:alice:hkg-edge-01/);
});

test('命令注入：账号名里的 shell 元字符被拒绝', () => {
  for (const evil of ['root; rm -rf /', 'root$(whoami)', 'root`id`', "root'", 'root && curl x']) {
    assert.throws(
      () => grantCommands(parsePublicKey(ED25519), { ...TARGET, remoteUser: evil }),
      /只能包含字母、数字/,
      `"${evil}" 必须在生成阶段就被拒绝，不能进入命令文本`,
    );
  }
});

test('命令注入：所有者和机器标识同样要过滤', () => {
  assert.throws(() => grantComment({ ...TARGET, owner: 'a b' }), /所有者/);
  assert.throws(() => grantComment({ ...TARGET, nodeId: 'x;y' }), /机器标识/);
});

test('撤销命令先备份再改，且按 blob 精确匹配', () => {
  const cmds = revokeCommands(parsePublicKey(ED25519), { remoteUser: 'root', day: '20260825' });
  const text = cmds.join('\n');
  assert.match(text, /cp "\$f" "\$f\.sonar-bak\.20260825"/, '改之前必须留一份');
  assert.match(text, /grep -vF/, '按固定字符串反选，不能用正则');
  assert.ok(
    text.indexOf('cp "$f"') < text.indexOf('grep -vF'),
    '备份必须发生在覆盖之前，否则备份的是已经改坏的内容',
  );
});

test('撤销命令在没有 authorized_keys 时安全退出', () => {
  const text = revokeCommands(parsePublicKey(ED25519), { remoteUser: 'root', day: '20260825' }).join('\n');
  assert.match(text, /\[ -f "\$f" \] \|\|/, '文件不存在时不该报错，更不该创建一个空文件');
});

// ————————————————————————————————————————————————————————
// expiry-time
// ————————————————————————————————————————————————————————

test('sshd 版本判定：7.7 是分界线', () => {
  assert.equal(supportsExpiry('7.6'), false);
  assert.equal(supportsExpiry('7.7'), true);
  assert.equal(supportsExpiry('8.9p1'), true);
  assert.equal(supportsExpiry('9.6p1 Ubuntu'), true);
  assert.equal(supportsExpiry(''), false, '采不到版本时按不支持处理');
  assert.equal(supportsExpiry('unknown'), false);
});

test('带有效期时命令里有 expiry-time 前缀', () => {
  const at = Date.UTC(2026, 8, 1, 12, 30);
  const text = grantCommands(parsePublicKey(ED25519), TARGET, at).join('\n');
  assert.match(text, /expiry-time="202609011230Z"/);
});

// ————————————————————————————————————————————————————————
// 预检
// ————————————————————————————————————————————————————————

const FRESH: HostFacts = {
  sshdVersion: '9.6p1',
  observedFingerprints: ['SHA256:aaa', 'SHA256:bbb'],
  managedFingerprints: ['SHA256:aaa'],
  passwordAuth: false,
  observedAt: Date.now(),
  agentOnline: true,
};

test('授权预检：sshd 低于 7.7 时带有效期会被硬拦', () => {
  const r = preflightGrant({
    key: parsePublicKey(ED25519),
    facts: { ...FRESH, sshdVersion: '7.6p1' },
    expiresAt: Date.now() + 86_400_000,
  });
  assert.equal(r.allowed, false);
  assert.match(r.blockers.join(), /7\.6.*expiry-time/s, '写进去会让整把 key 失效，必须拦住');
});

test('授权预检：版本未知时降级为提醒而不是硬拦', () => {
  const r = preflightGrant({
    key: parsePublicKey(ED25519),
    facts: { ...FRESH, sshdVersion: '' },
    expiresAt: Date.now() + 86_400_000,
  });
  assert.equal(r.allowed, true);
  assert.match(r.warnings.join(), /无法确认/);
});

test('授权预检：已经存在的公钥给提醒', () => {
  const key = parsePublicKey(ED25519);
  const r = preflightGrant({
    key,
    facts: { ...FRESH, observedFingerprints: [key.fingerprint] },
    expiresAt: 0,
  });
  assert.equal(r.allowed, true);
  assert.match(r.warnings.join(), /已经在目标机器上/);
});

test('撤销预检：没有实况时一律拒绝', () => {
  const r = preflightRevoke({
    fingerprint: 'SHA256:aaa',
    facts: { ...FRESH, observedAt: 0 },
  });
  assert.equal(r.allowed, false);
  assert.match(r.blockers.join(), /还没有采集到/);
});

test('撤销预检：实况过期时拒绝 —— 过期的实况比没有实况更危险', () => {
  const r = preflightRevoke({
    fingerprint: 'SHA256:aaa',
    facts: { ...FRESH, observedAt: Date.now() - 3 * 86_400_000 },
  });
  assert.equal(r.allowed, false);
  assert.match(r.blockers.join(), /已经过期/);
});

test('撤销预检：撤自己的钥匙时给提醒，但不拦 —— 换钥匙是正常操作', () => {
  const r = preflightRevoke({
    fingerprint: 'SHA256:aaa',
    facts: FRESH,
    operatorOwnsKey: true,
  });
  assert.equal(r.allowed, true);
  assert.match(r.warnings.join(), /这是你自己的公钥/);
});

test('撤销预检：最后一把 key + 密码登录关闭 = 硬拦', () => {
  const r = preflightRevoke({
    fingerprint: 'SHA256:only',
    facts: { ...FRESH, observedFingerprints: ['SHA256:only'], passwordAuth: false },
  });
  assert.equal(r.allowed, false);
  assert.match(r.blockers.join(), /最后一把公钥/);
});

test('撤销预检：最后一把 key 但密码登录开着，只是提醒', () => {
  const r = preflightRevoke({
    fingerprint: 'SHA256:only',
    facts: { ...FRESH, observedFingerprints: ['SHA256:only'], passwordAuth: true },
  });
  assert.equal(r.allowed, true);
  assert.match(r.warnings.join(), /只能用密码登录/);
});

test('撤销预检：密码登录状态未知时按最坏情况拦住', () => {
  const r = preflightRevoke({
    fingerprint: 'SHA256:only',
    facts: { ...FRESH, observedFingerprints: ['SHA256:only'], passwordAuth: null },
  });
  assert.equal(r.allowed, false);
  assert.match(r.blockers.join(), /无法确认密码登录/);
});

test('撤销预检：还有别的钥匙时正常放行', () => {
  const r = preflightRevoke({ fingerprint: 'SHA256:aaa', facts: FRESH });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.blockers, []);
});

// ————————————————————————————————————————————————————————
// ssh_config
// ————————————————————————————————————————————————————————

const EP = {
  nodeId: 'hkg-edge-01',
  alias: 'hkg-edge-01',
  hostname: '203.0.113.10',
  port: 22,
  defaultUser: 'root',
  proxyJump: '',
  identityFile: '~/.ssh/id_ed25519',
  hostKeys: [{ type: 'ssh-ed25519', blob: 'AAAAC3NzaC1lZDI1NTE5AAAAI' }],
};

test('Host 块：默认端口不写 Port', () => {
  const b = hostBlock(EP);
  assert.match(b, /^Host hkg-edge-01$/m);
  assert.match(b, /HostName 203\.0\.113\.10/);
  assert.doesNotMatch(b, /Port/, '22 是默认值，写出来只是噪音');
  assert.match(b, /IdentitiesOnly yes/, '不加的话本地 key 一多就会撞上 MaxAuthTries');
});

test('Host 块：非默认端口和跳板要写出来', () => {
  const b = hostBlock({ ...EP, port: 2222, proxyJump: 'bastion' });
  assert.match(b, /Port 2222/);
  assert.match(b, /ProxyJump bastion/);
});

test('配置片段顶部必须讲清 Include 的顺序陷阱', () => {
  const s = configSnippet([EP]);
  assert.match(s, /最顶部/, 'Include 放末尾会让用户原有的全局配置静默失效');
  assert.match(s, /先匹配先生效/, '同名 Host 会静默连到别的机器上');
});

test('known_hosts：非 22 端口要写成 [host]:port', () => {
  assert.match(knownHostsEntries([{ ...EP, port: 2222 }]), /^\[203\.0\.113\.10\]:2222 ssh-ed25519 /m);
  assert.match(knownHostsEntries([EP]), /^203\.0\.113\.10 ssh-ed25519 /m);
});

test('known_hosts：没采到 host key 就不产出条目', () => {
  assert.equal(knownHostsEntries([{ ...EP, hostKeys: [] }]), '');
});

test('别名校验', () => {
  assert.equal(validateAlias('hkg-edge-01'), null);
  assert.match(validateAlias('has space')!, /别名/);
  assert.match(validateAlias('-leading')!, /别名/);
  assert.match(validateAlias('has*wildcard')!, /别名/);
});

test('配置片段里的特殊字符会被引号包住', () => {
  const b = hostBlock({ ...EP, identityFile: '/path/with space/id' });
  assert.match(b, /IdentityFile "\/path\/with space\/id"/);
});

// ————————————————————————————————————————————————————————
// 指纹工具
// ————————————————————————————————————————————————————————

test('指纹去掉 base64 填充，和 ssh-keygen 的打印格式一致', () => {
  const fp = fingerprintOf(Buffer.from('hello'));
  assert.doesNotMatch(fp, /=/, '留着 = 的话，人拿去和终端输出对照会以为是不同的 key');
  assert.match(fp, /^SHA256:/);
});
