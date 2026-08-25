/**
 * ssh_config 片段与 known_hosts
 *
 * 目标是让人从面板复制一段配置到本地，之后 `ssh hkg-edge-01` 就能连上，
 * 不必记 IP、端口和用哪把 key。
 *
 * ——————————————————————————————————————————————
 *
 * **绝不接管 ~/.ssh/config。** 生成的是一个独立文件，由用户自己在主配置里
 * Include 进去。反面教材是 assh —— 它直接托管 ~/.ssh/config，官方文档不得不
 * 专门警告你先备份原文件。别人手写了多年的配置，不该因为用了一个探针面板而被改写。
 */

export interface EndpointView {
  nodeId: string;
  alias: string;
  hostname: string;
  port: number;
  defaultUser: string;
  /** 跳板机的别名或 user@host，空串表示直连 */
  proxyJump: string;
  /** agent 上报的 host key，用于生成 known_hosts */
  hostKeys: Array<{ type: string; blob: string }>;
  /** 本地私钥路径，由用户在面板上填，空串则不写 IdentityFile */
  identityFile: string;
}

/** ssh_config 的值里出现空格或 # 时要引号包起来，否则会被截断或当成注释。 */
function quote(value: string): string {
  return /[\s#"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * 生成一台机器的 Host 块。
 *
 * IdentitiesOnly yes 是有意加的：不加的话 ssh 会把 agent 里所有身份挨个试一遍，
 * 服务端的 MaxAuthTries 默认是 6 —— 本地 key 一多，还没轮到正确的那把就被断开了，
 * 报错是「Too many authentication failures」，看起来像是密钥不对。
 */
export function hostBlock(e: EndpointView): string {
  const lines = [`Host ${e.alias}`, `    HostName ${quote(e.hostname)}`];
  if (e.port && e.port !== 22) lines.push(`    Port ${e.port}`);
  if (e.defaultUser) lines.push(`    User ${quote(e.defaultUser)}`);
  if (e.identityFile) {
    lines.push(`    IdentityFile ${quote(e.identityFile)}`);
    lines.push('    IdentitiesOnly yes');
  }
  if (e.proxyJump) lines.push(`    ProxyJump ${quote(e.proxyJump)}`);
  return lines.join('\n');
}

/**
 * 完整的配置片段。
 *
 * 顶部那段注释不是装饰：Include 有一个很容易踩的顺序陷阱 —— Include 之后的
 * 任何通用配置都会被前一个 Host 块吸收进去。不写清楚的话，用户把
 * `Include config.d/*` 放在自己 ~/.ssh/config 的末尾，他原有的全局设置就失效了。
 */
export function configSnippet(endpoints: EndpointView[], panelName = 'Sonar'): string {
  const header = [
    `# ===== ${panelName} 托管，请勿手工编辑本文件 =====`,
    '#',
    '# 用法：把本文件存为 ~/.ssh/config.d/sonar，然后在 ~/.ssh/config 的',
    '# **最顶部**加一行：',
    '#',
    '#     Include config.d/*',
    '#',
    '# 必须放在顶部：ssh_config 里 Include 之后的配置会被前一个 Host 块吸收，',
    '# 放在末尾会让你原有的全局设置静默失效。',
    '#',
    '# 另外 ssh_config 是「先匹配先生效」：如果你本地已经有同名的 Host，',
    '# 排在前面的那个说了算，而且不会有任何报错 —— 你会连到另一台机器上',
    '# 却以为连对了。下面列出的别名如果和你已有的重名，改掉其中一个。',
    '',
  ];

  const blocks = endpoints.map(hostBlock);
  return [...header, ...blocks].join('\n') + '\n';
}

/**
 * known_hosts 条目。
 *
 * 这是 Sonar 相对 Termius / Tabby / Xshell 真正的差异化：那些工具装在你本机，
 * 没法知道目标机器的 host key 到底是什么，只能在首次连接时让你盲按一次 yes ——
 * 而那一下正是中间人攻击唯一的窗口（TOFU，首次使用即信任）。
 *
 * Sonar 的 agent 就跑在目标机器上，`/etc/ssh/ssh_host_*_key.pub` 是它本地的文件。
 * 把指纹带出来，首次连接就不需要盲信任了。
 */
export function knownHostsEntries(endpoints: EndpointView[]): string {
  const lines: string[] = [];
  for (const e of endpoints) {
    if (e.hostKeys.length === 0) continue;
    /*
     * 非 22 端口在 known_hosts 里要写成 [host]:port，这是 OpenSSH 的格式要求。
     * 写错的话条目对不上，ssh 仍然会问你要不要信任 —— 等于这一整块白做了。
     */
    const host = e.port && e.port !== 22 ? `[${e.hostname}]:${e.port}` : e.hostname;
    for (const k of e.hostKeys) {
      lines.push(`${host} ${k.type} ${k.blob}`);
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** 别名要能直接当 ssh 的 Host 用，所以不能有空格、通配符和注释符。 */
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateAlias(alias: string): string | null {
  if (!ALIAS_RE.test(String(alias ?? ''))) {
    return '别名只能用字母数字开头，包含字母、数字、点、下划线、连字符，最长 64 位';
  }
  return null;
}

/**
 * 主机名可以是 IP，也可以是域名。
 *
 * 不做严格校验 —— 内网主机名、Tailscale 的 MagicDNS 名字、.local 都是合法目标，
 * 拿一个「必须是 IP 或含点的域名」的规则去卡，只会让正常场景填不进来。
 * 只拦住会破坏配置文件结构的字符。
 */
export function validateHostname(hostname: string): string | null {
  const h = String(hostname ?? '').trim();
  if (!h) return '主机名不能为空';
  if (h.length > 255) return '主机名过长';
  if (/[\s#'"\\]/.test(h)) return '主机名不能包含空格、井号、引号或反斜杠';
  return null;
}

/**
 * ProxyJump 的值形如 `user@host:port` 或另一个 Host 别名。
 *
 * 同样只拦破坏结构的字符 —— 它可能引用的是用户本地 config 里的别名，
 * 面板无从校验那个别名存不存在。
 */
export function validateProxyJump(value: string): string | null {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (v.length > 255) return '跳板配置过长';
  if (/[\s#'"\\]/.test(v)) return '跳板配置不能包含空格、井号、引号或反斜杠';
  return null;
}
