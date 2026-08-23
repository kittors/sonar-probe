/**
 * 封禁规则的生成与预检
 *
 * 设计原则：**面板永远不直接碰防火墙**。这里只负责算出"应该执行什么"，
 * 由 agent 在目标机器上执行，且默认 dry-run。
 *
 * TTL 交给 nftables 的 set timeout 而不是面板定时器 —— 面板挂了、网络断了，
 * 内核照样会到点自动解封，不会把机器永久锁死。
 */

import { randomUUID } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { db } from './db.js';
import type { BlockMode, BlockPreflight, BlockRule } from './types.js';

// ————————————————————————————————————————————————————————————————
// IP / CIDR 工具
// ————————————————————————————————————————————————————————————————

export function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/**
 * 严格的 IPv6 判定。
 *
 * 原来这里是 `addr.includes(':')` —— 只要含冒号就当 IPv6，没有任何格式校验。
 * 后果是 `::1; whoami` 这种字符串能一路通过预检，最终被拼进
 * `nft add element ... { <target> }` 的命令文本里。
 *
 * agent 那边用的是 exec.Command("nft", args...)，不过 shell，所以注入的分号
 * 只会让 nft 报错，构不成远程执行。但面板会把这段命令原样显示出来、还配了
 * 「复制」按钮 —— 一旦有人粘进终端，注入就成立了。这一关必须自己守住，
 * 不能指望下游恰好安全。
 *
 * 用 node:net 的实现而不是自己写正则：IPv6 有 `::` 缩写、IPv4 映射尾巴
 * （`::ffff:1.2.3.4`）、区域 ID 等一堆规则，手写正则漏一个就是个洞。
 */
export function isIpv6(addr: string): boolean {
  return isIPv6(addr);
}

/** 看起来是不是想写 IPv6 —— 只用来决定报错文案该说 v4 还是 v6，不作为放行依据 */
function looksLikeIpv6(addr: string): boolean {
  return addr.includes(':');
}

/** 拆出 "1.2.3.0/24" 里的地址和前缀长度；裸 IP 视为 /32。 */
/**
 * 拆出 "1.2.3.0/24" 里的地址和前缀长度；裸 IP 视为 /32（v6 为 /128）。
 *
 * 地址部分必须是**合法的** IPv4 或 IPv6，否则一律返回 null —— 这是整条封禁链路
 * 唯一的入口校验，放进来的任何东西最终都会出现在 nft 命令文本里。
 */
export function splitCidr(target: string): { addr: string; prefix: number } | null {
  // 多于一个 '/' 的输入直接判非法，避免 "1.2.3.4/24/x" 这类被截断后蒙混过关
  const slices = target.split('/');
  if (slices.length > 2) return null;
  const [addr, maskRaw] = slices;
  if (!addr) return null;

  const v6 = isIPv6(addr);
  if (!v6 && !isIPv4(addr)) return null;

  const full = v6 ? 128 : 32;
  if (maskRaw === undefined) return { addr, prefix: full };
  if (!/^\d{1,3}$/.test(maskRaw)) return null;
  const prefix = Number(maskRaw);
  if (prefix < 0 || prefix > full) return null;
  return { addr, prefix };
}

export function ipv4InCidr(ip: string, cidr: string): boolean {
  const parsedIp = parseIpv4(ip);
  const parts = splitCidr(cidr);
  if (parsedIp === null || !parts || isIpv6(parts.addr)) return false;
  const base = parseIpv4(parts.addr);
  if (base === null) return false;
  if (parts.prefix === 0) return true;
  const mask = (0xffffffff << (32 - parts.prefix)) >>> 0;
  return (parsedIp & mask) === (base & mask);
}

/** 一个网段覆盖多少个地址 —— 用来拦住"手滑封了半个互联网"。 */
export function cidrSize(target: string): number {
  const parts = splitCidr(target);
  if (!parts) return 1;
  const full = isIpv6(parts.addr) ? 128 : 32;
  return 2 ** (full - parts.prefix);
}

// ————————————————————————————————————————————————————————————————
// 守卫名单
// ————————————————————————————————————————————————————————————————

/** 任何情况下都不允许封的网段。封了它们等于自断退路。 */
const HARD_GUARDS: Array<{ cidr: string; why: string }> = [
  { cidr: '127.0.0.0/8', why: '本机环回地址' },
  { cidr: '10.0.0.0/8', why: 'RFC1918 私有网段（内网互通会断）' },
  { cidr: '172.16.0.0/12', why: 'RFC1918 私有网段（Docker 默认网桥常在此）' },
  { cidr: '192.168.0.0/16', why: 'RFC1918 私有网段' },
  { cidr: '169.254.0.0/16', why: '链路本地地址（云厂商元数据服务常用 169.254.169.254）' },
  { cidr: '100.64.0.0/10', why: 'CGNAT 网段（运营商共享地址，会误伤大量正常用户）' },
  { cidr: '0.0.0.0/8', why: '保留网段' },
  { cidr: '224.0.0.0/4', why: '组播地址' },
];

/** 比这更宽的网段需要显式确认，避免一条规则打掉整个 ASN。 */
const MAX_SAFE_PREFIX = 24;

export interface GuardContext {
  /** 目标机器自己的公网 IP */
  nodeIp: string;
  /** 发起操作的人的出口 IP —— 最容易误伤的就是自己 */
  operatorIp?: string;
  /** 面板地址：agent 靠它回连，封了就彻底失联 */
  panelIp?: string;
  /** 用户自定义白名单 */
  allowlist?: string[];
}

export function loadAllowlist(): string[] {
  const raw = process.env.SONAR_ALLOWLIST ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ————————————————————————————————————————————————————————————————
// 规则生成
// ————————————————————————————————————————————————————————————————

const TABLE = 'inet sonar';
const SET_V4 = 'blocklist4';
const SET_V6 = 'blocklist6';

/** 首次使用时需要建的表/链/集合。agent 会做幂等处理。 */
export function bootstrapCommands(): string[] {
  return [
    `nft add table ${TABLE}`,
    `nft add set ${TABLE} ${SET_V4} { type ipv4_addr\\; flags interval,timeout\\; }`,
    `nft add set ${TABLE} ${SET_V6} { type ipv6_addr\\; flags interval,timeout\\; }`,
    // priority -10 让它排在常规 filter 之前，但仍在 conntrack 之后
    `nft add chain ${TABLE} input { type filter hook input priority -10\\; policy accept\\; }`,
    `nft add rule ${TABLE} input ip saddr @${SET_V4} counter drop`,
    `nft add rule ${TABLE} input ip6 saddr @${SET_V6} counter drop`,
  ];
}

export function blockCommands(target: string, ttlSeconds: number): string[] {
  const set = isIpv6(target) ? SET_V6 : SET_V4;
  const timeout = ttlSeconds > 0 ? ` timeout ${ttlSeconds}s` : '';
  return [`nft add element ${TABLE} ${set} { ${target}${timeout} }`];
}

export function unblockCommands(target: string): string[] {
  const set = isIpv6(target) ? SET_V6 : SET_V4;
  return [`nft delete element ${TABLE} ${set} { ${target} }`];
}

// ————————————————————————————————————————————————————————————————
// 预检
// ————————————————————————————————————————————————————————————————

export function preflight(
  target: string,
  mode: BlockMode,
  ttlSeconds: number,
  ctx: GuardContext,
): BlockPreflight {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const matchedGuards: string[] = [];

  const parts = splitCidr(target);
  if (!parts) {
    return {
      allowed: false,
      target,
      mode,
      commands: [],
      blockers: [
        looksLikeIpv6(target)
          ? `"${target}" 不是合法的 IPv6 地址或网段`
          : `"${target}" 不是合法的 IP 或 CIDR`,
      ],
      warnings: [],
      matchedGuards: [],
    };
  }

  if (isIpv6(parts.addr)) {
    // IPv6 只做基础校验：环回和未指定地址
    if (parts.addr === '::1' || parts.addr === '::') {
      blockers.push('这是本机地址，封禁会导致本地服务不可用');
      matchedGuards.push(parts.addr);
    }
    if (parts.prefix < 48) {
      blockers.push(`/${parts.prefix} 覆盖范围过大，请收窄到 /48 或更精确的网段`);
    }
  } else {
    // splitCidr 已经保证过合法性，这里留一道冗余检查：
    // 万一以后有人绕开 splitCidr 直接调 preflight，也不至于漏进去
    if (parseIpv4(parts.addr) === null) {
      blockers.push(`"${parts.addr}" 不是合法的 IPv4 地址`);
    }
    for (const guard of HARD_GUARDS) {
      if (ipv4InCidr(parts.addr, guard.cidr)) {
        blockers.push(`${guard.cidr} —— ${guard.why}`);
        matchedGuards.push(guard.cidr);
      }
    }
    if (parts.prefix < MAX_SAFE_PREFIX) {
      const size = cidrSize(target).toLocaleString('en-US');
      blockers.push(
        `/${parts.prefix} 覆盖 ${size} 个地址，超出 /${MAX_SAFE_PREFIX} 的安全上限。` +
          `如确需大范围封禁，请拆成多条更精确的规则。`,
      );
    }
  }

  // 自伤检查：这三条是实战里最常见的翻车方式
  const selfChecks: Array<[string | undefined, string]> = [
    [ctx.nodeIp, '这是目标机器自己的 IP'],
    [ctx.operatorIp, '这是你当前的出口 IP，封了之后你自己就连不上了'],
    [ctx.panelIp, '这是 Sonar 面板的地址，封了 agent 会立刻失联'],
  ];
  for (const [ip, why] of selfChecks) {
    if (ip && (ip === parts.addr || (!isIpv6(parts.addr) && ipv4InCidr(ip, target)))) {
      blockers.push(why);
      matchedGuards.push(ip);
    }
  }

  for (const allow of ctx.allowlist ?? []) {
    if (allow === parts.addr || (!isIpv6(parts.addr) && ipv4InCidr(parts.addr, allow))) {
      blockers.push(`命中白名单 ${allow}`);
      matchedGuards.push(allow);
    }
  }

  // 提醒类：不拦，但要让人看见
  if (ttlSeconds === 0) {
    warnings.push('未设置有效期，这条规则会一直存在，直到手动解除');
  }
  if (ttlSeconds > 0 && ttlSeconds < 60) {
    warnings.push('有效期短于 1 分钟，可能还没起作用就自动解封了');
  }
  if (mode === 'enforced') {
    warnings.push('当前是 enforce 模式，确认后会立刻在目标机器上生效');
  }
  if (!isIpv6(parts.addr) && parts.prefix >= MAX_SAFE_PREFIX && parts.prefix < 32) {
    warnings.push(`这是一个网段（${cidrSize(target)} 个地址），不是单个 IP`);
  }

  const allowed = blockers.length === 0;
  return {
    allowed,
    target,
    mode,
    commands: allowed ? [...bootstrapCommands(), ...blockCommands(target, ttlSeconds)] : [],
    blockers,
    warnings,
    matchedGuards,
  };
}

// ————————————————————————————————————————————————————————————————
// 规则持久化
// ————————————————————————————————————————————————————————————————

export function createRule(input: {
  nodeId: string;
  target: string;
  reason: string;
  mode: BlockMode;
  ttlSeconds: number;
  commands: string[];
  operator: string;
}): BlockRule {
  const now = Date.now();
  const rule: BlockRule = {
    id: randomUUID(),
    nodeId: input.nodeId,
    target: input.target,
    reason: input.reason,
    mode: input.mode,
    // dry-run 只落库存档，不代表机器上真的生效了
    state: input.mode === 'enforced' ? 'active' : 'pending',
    commands: input.commands,
    createdAt: now,
    expiresAt: input.ttlSeconds > 0 ? now + input.ttlSeconds * 1000 : 0,
    operator: input.operator,
    result:
      input.mode === 'enforced'
        ? null
        : 'dry-run：规则已生成但未下发，切换到 enforce 模式后才会执行',
  };

  db.prepare(`
    INSERT INTO block_rules (id,node_id,target,reason,mode,state,commands,created_at,expires_at,operator,result)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    rule.id, rule.nodeId, rule.target, rule.reason, rule.mode, rule.state,
    JSON.stringify(rule.commands), rule.createdAt, rule.expiresAt, rule.operator, rule.result,
  );

  return rule;
}

export function rowToRule(row: Record<string, unknown>): BlockRule {
  return {
    id: row.id as string,
    nodeId: row.node_id as string,
    target: row.target as string,
    reason: row.reason as string,
    mode: row.mode as BlockMode,
    state: row.state as BlockRule['state'],
    commands: JSON.parse((row.commands as string) || '[]'),
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
    operator: row.operator as string,
    result: (row.result as string | null) ?? null,
  };
}

export function listRules(nodeId?: string): BlockRule[] {
  const rows = nodeId
    ? db.prepare('SELECT * FROM block_rules WHERE node_id=? ORDER BY created_at DESC').all(nodeId)
    : db.prepare('SELECT * FROM block_rules ORDER BY created_at DESC LIMIT 200').all();
  return (rows as Array<Record<string, unknown>>).map(rowToRule);
}

/** 把到期的规则标记为 expired。内核那边已经自己解封了，这里只是让面板状态跟上。 */
export function expireRules(): number {
  const now = Date.now();
  const res = db
    .prepare("UPDATE block_rules SET state='expired' WHERE state='active' AND expires_at > 0 AND expires_at <= ?")
    .run(now);
  return Number(res.changes ?? 0);
}

export function removeRule(id: string): BlockRule | null {
  const row = db.prepare('SELECT * FROM block_rules WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  db.prepare("UPDATE block_rules SET state='removed', result=? WHERE id=?").run(
    `已解除封禁：${unblockCommands(row.target as string).join('; ')}`,
    id,
  );
  return rowToRule({ ...row, state: 'removed' });
}
