/**
 * 权限模型
 *
 * 粒度是"按钮级"：每个会产生后果的操作都是一个独立的能力点，前端拿它决定按钮显不显示，
 * 后端拿它决定请求放不放行。**两边都要判** —— 前端隐藏按钮只是不碍眼，
 * 真正拦住越权的是后端那道。
 *
 * 这份定义前后端各有一份镜像（apps/dashboard/src/lib/permissions.ts），改动时两边都要动。
 */

export const CAPABILITIES = {
  // —— 浏览
  'node:list': { label: '查看机器列表', group: '浏览', risk: 'low' },
  'node:detail': { label: '进入机器详情页', group: '浏览', risk: 'low' },
  'node:full_ip': { label: '查看未打码的 IP 地址', group: '浏览', risk: 'medium' },
  'node:hardware': { label: '查看硬件与系统信息', group: '浏览', risk: 'low' },
  'node:manage': { label: '编辑机器信息（价格、配额、到期）', group: '浏览', risk: 'medium' },

  // —— 流量
  'traffic:daily': { label: '查看每日流量', group: '流量', risk: 'low' },
  'traffic:services': { label: '查看服务流量归因', group: '流量', risk: 'medium' },
  'traffic:peers': { label: '查看对端 IP 流量', group: '流量', risk: 'medium' },

  // —— 封禁
  'block:view': { label: '查看封禁规则', group: '封禁', risk: 'low' },
  'block:preflight': { label: '预检封禁目标', group: '封禁', risk: 'low' },
  'block:dryrun': { label: '生成封禁规则（不下发）', group: '封禁', risk: 'medium' },
  'block:enforce': { label: '真正下发封禁到机器', group: '封禁', risk: 'high' },
  'block:remove': { label: '解除封禁', group: '封禁', risk: 'high' },

  // —— 告警
  'alert:view': { label: '查看流量阈值', group: '告警', risk: 'low' },
  'alert:manage': { label: '增删改流量阈值', group: '告警', risk: 'medium' },

  // —— 管理
  'audit:view': { label: '查看访问审计与在线用户', group: '管理', risk: 'medium' },
  'user:view': { label: '查看用户列表', group: '管理', risk: 'medium' },
  'user:manage': { label: '改用户角色与权限', group: '管理', risk: 'high' },
} as const;

export type Capability = keyof typeof CAPABILITIES;

export const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[];

export type Role = 'admin' | 'operator' | 'viewer' | 'guest' | 'anonymous';

export const ROLE_LABEL: Record<Role, string> = {
  admin: '管理员',
  operator: '运维',
  viewer: '观察者',
  guest: '访客',
  anonymous: '未登录',
};

/** 可以被指派给真实用户的角色。anonymous 是系统内部身份，不出现在管理页的下拉里。 */
export const ASSIGNABLE_ROLES: Role[] = ['admin', 'operator', 'viewer', 'guest'];

/**
 * 角色的默认能力集。
 *
 * 访客给得很克制：能看机器状态和整体流量，但看不到具体是谁在连、连的哪个端口 ——
 * 那些信息拼起来足以画出你的服务拓扑，不该对未经确认的人开放。
 */
export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  admin: ALL_CAPABILITIES,

  operator: [
    'node:list', 'node:detail', 'node:full_ip', 'node:hardware', 'node:manage',
    'traffic:daily', 'traffic:services', 'traffic:peers',
    'block:view', 'block:preflight', 'block:dryrun', 'block:enforce', 'block:remove',
    'alert:view', 'alert:manage',
    'audit:view',
  ],

  viewer: [
    'node:list', 'node:detail', 'node:hardware',
    'traffic:daily', 'traffic:services', 'traffic:peers',
    'block:view',
    'alert:view',
  ],

  guest: [
    'node:list', 'node:detail',
    'traffic:daily',
  ],

  /**
   * 完全未登录的人。
   *
   * 概览页是公开的状态页 —— 谁都能看到有几台机器、活着没有、负载多少。
   * 但只到这一层：点进详情要有身份，因为详情页会暴露服务拓扑和对端地址，
   * 而且需要能追溯是谁看的。
   */
  anonymous: ['node:list'],
};

/**
 * 算出用户的最终能力集：角色默认值 + 单独授予 - 单独收回。
 *
 * 收回优先于授予 —— 出现冲突时按更严格的那个来。
 */
export function resolveCapabilities(
  role: Role,
  granted: string[] = [],
  revoked: string[] = [],
): Set<Capability> {
  const set = new Set<Capability>(ROLE_CAPABILITIES[role] ?? []);
  for (const c of granted) {
    if (c in CAPABILITIES) set.add(c as Capability);
  }
  for (const c of revoked) {
    set.delete(c as Capability);
  }
  return set;
}

/** 能力点按展示分组，管理页用它渲染权限矩阵。 */
export function groupedCapabilities(): Array<{ group: string; items: Array<{ key: Capability; label: string; risk: string }> }> {
  const map = new Map<string, Array<{ key: Capability; label: string; risk: string }>>();
  for (const key of ALL_CAPABILITIES) {
    const meta = CAPABILITIES[key];
    const list = map.get(meta.group) ?? [];
    list.push({ key, label: meta.label, risk: meta.risk });
    map.set(meta.group, list);
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }));
}
