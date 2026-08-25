/**
 * 能力点
 *
 * 粒度是"按钮级"：每个会产生后果的操作都是一个独立的能力点，前端拿它决定按钮显不显示，
 * 后端拿它决定请求放不放行。**两边都要判** —— 前端隐藏按钮只是不碍眼，
 * 真正拦住越权的是后端那道。
 *
 * 这份定义前后端各有一份镜像（apps/server/src/permissions.ts），改动时两边都要动。
 *
 * ——————————————————————————————————————————————
 *
 * 这里**只有能力点，没有角色**。
 *
 * 角色和它的能力集在服务端的数据库里，运行期可增删改，前端通过
 * /api/admin/capabilities 拿到当前有哪些角色。写死一份在这儿的话，
 * 管理员新建的角色在界面上就会显示成一个光秃秃的 id。
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

  // —— SSH
  'ssh:view': { label: '查看 SSH 接入方式与别名', group: 'SSH', risk: 'medium' },
  'ssh:keys': { label: '管理自己的公钥', group: 'SSH', risk: 'low' },
  'ssh:endpoint': { label: '编辑机器的 SSH 别名与连接方式', group: 'SSH', risk: 'medium' },
  'ssh:audit': { label: '查看机器上的密钥实况与漂移', group: 'SSH', risk: 'high' },
  'ssh:grant': { label: '发起 SSH 授权', group: 'SSH', risk: 'high' },
  'ssh:approve': { label: '审批 SSH 授权申请', group: 'SSH', risk: 'high' },
  'ssh:revoke': { label: '撤销 SSH 授权', group: 'SSH', risk: 'high' },
  'ssh:remote_apply': { label: '经 agent 远程下发密钥变更', group: 'SSH', risk: 'high' },

  // —— 管理
  'audit:view': { label: '查看访问审计与在线用户', group: '管理', risk: 'medium' },
  'user:view': { label: '查看用户列表', group: '管理', risk: 'medium' },
  'user:manage': { label: '改用户角色与权限', group: '管理', risk: 'high' },
  'user:create': { label: '创建与删除用户账号', group: '管理', risk: 'high' },
  'user:escalate': {
    label: '授予自己没有的权限（等同于可自我提权）',
    group: '管理',
    risk: 'high',
  },
  'role:manage': { label: '增删改角色及其能力集', group: '管理', risk: 'high' },
  'settings:view': { label: '查看通用设置', group: '管理', risk: 'low' },
  'settings:manage': { label: '修改通用设置（口径、阈值、保留策略）', group: '管理', risk: 'high' },
} as const;

export type Capability = keyof typeof CAPABILITIES;

export const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[];

/** 角色 id。具体有哪些角色由服务端决定，前端不做枚举。 */
export type Role = string;

/** 系统内置角色，界面上要对它们做特殊处理（不可删、能力集只读）。 */
export const SYSTEM_ROLES = ['admin', 'operator', 'viewer', 'guest', 'anonymous'] as const;

/** 服务端 /api/admin/capabilities 返回的角色。 */
export interface RoleInfo {
  value: string;
  label: string;
  description: string;
  capabilities: Capability[];
  system: boolean;
  locked: boolean;
  sortOrder: number;
  userCount: number;
  /** anonymous 不挂在任何账号上，不出现在"指派角色"的下拉里 */
  assignable: boolean;
}

export function capabilityLabel(cap: string): string {
  return (CAPABILITIES as Record<string, { label: string } | undefined>)[cap]?.label ?? cap;
}

export function capabilityRisk(cap: string): string {
  return (CAPABILITIES as Record<string, { risk: string } | undefined>)[cap]?.risk ?? 'low';
}

/** 能力点按展示分组，权限矩阵用它渲染。 */
export function groupedCapabilities(): Array<{
  group: string;
  items: Array<{ key: Capability; label: string; risk: string }>;
}> {
  const map = new Map<string, Array<{ key: Capability; label: string; risk: string }>>();
  for (const key of ALL_CAPABILITIES) {
    const meta = CAPABILITIES[key];
    const list = map.get(meta.group) ?? [];
    list.push({ key, label: meta.label, risk: meta.risk });
    map.set(meta.group, list);
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }));
}
