import type {
  BlockPreflight,
  BlockRule,
  DailyTraffic,
  EventLog,
  Metric,
  NodeState,
  PeerTraffic,
  ServiceTraffic,
  SshDrift,
  SshEndpoint,
  SshGrant,
  SshKey,
  SshPreflightResult,
} from './types';
import type { Capability, Role, RoleInfo } from './permissions';
import type { Currency } from './currency';
import type { PublicSettings } from './settings';
import type { Me } from './auth';
import type { Range as DayRange } from '../components/DateRangePicker';

/**
 * 三个流量接口共用同一个区间参数。
 *
 * 「这段时间走了 338 GB，其中 nginx 吃掉 210 GB」这句话要成立，两个数字
 * 就必须来自同一个区间 —— 各查各的只会让人对着两个口径找原因。
 */
function rangeQuery(r: DayRange): string {
  return `from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`;
}

export interface FleetSummary {
  total: number;
  online: number;
  warning: number;
  offline: number;
  netRx: number;
  netTx: number;
  monthTraffic: number;
  monthRx: number;
  monthTx: number;
  activeBlocks: number;
  /** 已折算成 costCurrency 的月度支出 */
  monthlyCost: number;
  costCurrency: Currency;
  /** 换算前各币种各是多少 */
  costByCurrency: Array<{ currency: Currency; amount: number; nodes: number }>;
  pricedNodes: number;
  ratesUsingFallback: boolean;
  ratesStale: boolean;
  ratesFetchedAt: number;
  expiringSoon: number;
}

/** 带上响应体里的错误信息，不然前端只能显示一个干巴巴的状态码。 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public payload?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // 会话是 httpOnly cookie，跨端口开发时不带上就永远是未登录
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg =
      (body && typeof body === 'object' && 'error' in body && String(body.error)) ||
      `请求失败（${res.status}）`;
    throw new ApiError(res.status, msg, body);
  }
  return body as T;
}

export const api = {
  summary: () => req<FleetSummary>('/api/summary'),
  nodes: () => req<NodeState[]>('/api/nodes'),
  node: (id: string) => req<NodeState>(`/api/nodes/${id}`),

  /** 编辑机器的账务属性（价格、周期、配额、到期等）。 */
  updateNode: (
    id: string,
    body: {
      name?: string;
      provider?: string;
      countryCode?: string;
      region?: string;
      price?: number;
      currency?: string;
      billingCycle?: 'monthly' | 'quarterly' | 'yearly';
      expireAt?: number;
      trafficQuota?: number;
      billingDay?: number;
      /** 服务商控制台地址。服务端只接受 http/https */
      panelUrl?: string;
      /** 服务商后台此刻显示的真实已用量；差额由服务端算。null 表示撤销校准 */
      trafficUsedActual?: number | null;
      tags?: string[];
    },
  ) => req<NodeState>(`/api/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  metrics: (id: string, range: '15m' | '1h' | '6h' | '24h') =>
    req<Metric[]>(`/api/nodes/${id}/metrics?range=${range}`),


  dailyTraffic: (id: string, range: DayRange) =>
    req<DailyTraffic[]>(`/api/nodes/${id}/traffic/daily?${rangeQuery(range)}`),

  serviceTraffic: (id: string, range: DayRange) =>
    req<ServiceTraffic[]>(`/api/nodes/${id}/traffic/services?${rangeQuery(range)}`),

  peerTraffic: (id: string, range: DayRange, limit = 50) =>
    req<PeerTraffic[]>(`/api/nodes/${id}/traffic/peers?${rangeQuery(range)}&limit=${limit}`),

  events: (limit = 60, node?: string) =>
    req<EventLog[]>(`/api/events?limit=${limit}${node ? `&node=${node}` : ''}`),

  blocks: (nodeId?: string) =>
    req<BlockRule[]>(nodeId ? `/api/nodes/${nodeId}/blocks` : '/api/blocks'),

  /** 预检：只算不做。UI 拿它渲染"将要执行什么"和"为什么不让封"。 */
  preflight: (nodeId: string, target: string, mode: 'dry-run' | 'enforced', ttlSeconds: number) =>
    req<BlockPreflight>(`/api/nodes/${nodeId}/blocks/preflight`, {
      method: 'POST',
      body: JSON.stringify({ target, mode, ttlSeconds }),
    }),

  /** enforce 模式必须带 confirm，值等于 target —— 服务端会校验。 */
  block: (input: {
    nodeId: string;
    target: string;
    reason: string;
    mode: 'dry-run' | 'enforced';
    ttlSeconds: number;
  }) =>
    req<BlockRule>(`/api/nodes/${input.nodeId}/blocks`, {
      method: 'POST',
      body: JSON.stringify({
        target: input.target,
        reason: input.reason,
        mode: input.mode,
        ttlSeconds: input.ttlSeconds,
        confirm: input.mode === 'enforced' ? input.target : undefined,
      }),
    }),

  unblock: (ruleId: string) =>
    req<BlockRule & { unblockCommands: string[] }>(`/api/blocks/${ruleId}`, { method: 'DELETE' }),

  // —— 流量阈值与账本

  trafficRules: () => req<TrafficRule[]>('/api/traffic/rules'),

  trafficLedger: (days = 30) => req<LedgerRow[]>(`/api/traffic/ledger?days=${days}`),

  createTrafficRule: (body: {
    nodeId: string;
    scope: 'day' | 'month';
    threshold: number;
    compare: 'absolute' | 'quota';
    note: string;
  }) => req<TrafficRule>('/api/traffic/rules', { method: 'POST', body: JSON.stringify(body) }),

  toggleTrafficRule: (id: string, enabled: boolean) =>
    req<TrafficRule>(`/api/traffic/rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  deleteTrafficRule: (id: string) =>
    req<{ ok: boolean }>(`/api/traffic/rules/${id}`, { method: 'DELETE' }),

  // —— 管理

  adminCapabilities: () => req<CapabilityCatalog>('/api/admin/capabilities'),

  adminUsers: () => req<AdminUser[]>('/api/admin/users'),

  updateUser: (
    id: string,
    body: {
      role?: Role;
      granted?: string[];
      revoked?: string[];
      disabled?: boolean;
      note?: string;
      name?: string;
    },
  ) => req<AdminUser>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  createUser: (body: {
    username: string;
    password: string;
    name?: string;
    email?: string;
    role?: string;
    note?: string;
  }) => req<AdminUser>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) }),

  deleteUser: (id: string) =>
    req<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' }),

  /** 回显的新密码只在这一次响应里出现，服务端不留明文 */
  resetUserPassword: (id: string, password?: string) =>
    req<{ ok: boolean; password: string; mustChange: boolean }>(
      `/api/admin/users/${id}/password`,
      { method: 'POST', body: JSON.stringify({ password }) },
    ),

  kickUser: (id: string) =>
    req<{ ok: boolean }>(`/api/admin/users/${id}/sessions/revoke`, { method: 'POST' }),

  // —— 角色

  createRole: (body: {
    id: string;
    name: string;
    description?: string;
    capabilities?: string[];
    sortOrder?: number;
  }) => req<RoleDetail>('/api/admin/roles', { method: 'POST', body: JSON.stringify(body) }),

  updateRole: (
    id: string,
    body: { name?: string; description?: string; capabilities?: string[]; sortOrder?: number },
  ) => req<RoleDetail>(`/api/admin/roles/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteRole: (id: string) =>
    req<{ ok: boolean }>(`/api/admin/roles/${id}`, { method: 'DELETE' }),

  /** 接入新机器所需的信息。含 agent token，需要 node:manage 权限 */
  enrollInfo: () =>
    req<{ ready: boolean; panelUrl: string; token: string; existingIds: string[] }>(
      '/api/admin/enroll',
    ),

  online: () => req<OnlineEntry[]>('/api/admin/online'),

  visitors: (days = 7) => req<VisitorRow[]>(`/api/admin/visitors?days=${days}`),

  auditLog: (opts: { limit?: number; user?: string; action?: string } = {}) => {
    const p = new URLSearchParams();
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.user) p.set('user', opts.user);
    if (opts.action) p.set('action', opts.action);
    return req<AuditRow[]>(`/api/admin/audit?${p}`);
  },

  // —— 通用设置

  /** 展示口径，匿名可读。日常渲染走 lib/settings 的单例，这条给设置页做对照 */
  publicSettings: () => req<PublicSettings>('/api/settings/public'),

  settings: () => req<SettingsBundle>('/api/settings'),

  updateSettings: (body: Partial<PanelSettings>) =>
    req<{ settings: PanelSettings; rates: RatesPayload }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  refreshRates: () => req<RatesPayload>('/api/settings/rates/refresh', { method: 'POST' }),

  // —— SSH

  sshKeys: () => req<SshKey[]>('/api/ssh/keys'),

  addSshKey: (publicKey: string, label?: string) =>
    req<SshKey>('/api/ssh/keys', { method: 'POST', body: JSON.stringify({ publicKey, label }) }),

  importGithubKeys: () =>
    req<{ added: number; skipped: string[]; keys: SshKey[] }>('/api/ssh/keys/import/github', {
      method: 'POST',
    }),

  updateSshKey: (id: string, body: { label?: string; disabled?: boolean }) =>
    req<SshKey>(`/api/ssh/keys/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteSshKey: (id: string) => req<{ ok: boolean }>(`/api/ssh/keys/${id}`, { method: 'DELETE' }),

  sshEndpoints: () => req<SshEndpoint[]>('/api/ssh/endpoints'),

  updateSshEndpoint: (
    id: string,
    body: {
      alias?: string;
      hostname?: string;
      port?: number;
      defaultUser?: string;
      proxyJump?: string;
      identityFile?: string;
    },
  ) => req<SshEndpoint>(`/api/ssh/endpoints/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  sshConfig: (nodes?: string[]) =>
    req<{ config: string; knownHosts: string; count: number; missingHostKeys: number }>(
      `/api/ssh/config${nodes?.length ? `?nodes=${nodes.join(',')}` : ''}`,
    ),

  sshDrift: (node?: string) => req<SshDrift[]>(`/api/ssh/drift${node ? `?node=${node}` : ''}`),

  sshGrants: (opts: { node?: string; key?: string; mine?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (opts.node) p.set('node', opts.node);
    if (opts.key) p.set('key', opts.key);
    if (opts.mine) p.set('mine', '1');
    return req<SshGrant[]>(`/api/ssh/grants?${p}`);
  },

  sshPreflight: (body: { nodeId: string; keyId: string; remoteUser?: string; expiresAt?: number }) =>
    req<SshPreflightResult>('/api/ssh/grants/preflight', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  createSshGrant: (body: {
    nodeId: string;
    keyId: string;
    remoteUser?: string;
    expiresAt?: number;
    note?: string;
    useAgent?: boolean;
  }) =>
    req<{ grant: SshGrant; preflight: SshPreflightResult; commands: string[] }>('/api/ssh/grants', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  sshGrantCommands: (id: string) =>
    req<{ commands: string[] }>(`/api/ssh/grants/${id}/commands`),

  approveSshGrant: (id: string) =>
    req<{ grant: SshGrant; commands: string[] }>(`/api/ssh/grants/${id}/approve`, { method: 'POST' }),

  rejectSshGrant: (id: string, reason?: string) =>
    req<SshGrant>(`/api/ssh/grants/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  revokeSshGrant: (id: string, useAgent?: boolean) =>
    req<{ ok: boolean; commands: string[]; preflight: SshPreflightResult; dispatched: boolean }>(
      `/api/ssh/grants/${id}/revoke`,
      { method: 'POST', body: JSON.stringify({ useAgent }) },
    ),

  /** 某个人的全部授权，人员离场时一键列出 */
  sshUserGrants: (userId: string) =>
    req<{
      grants: SshGrant[];
      commands: Array<{
        grantId: string;
        nodeId: string;
        nodeName: string;
        remoteUser: string;
        commands: string[];
      }>;
    }>(`/api/ssh/users/${userId}/grants`),

  sshExport: () => req<SshExport>('/api/ssh/export'),

  sshCommands: (node?: string) =>
    req<AgentCommandRow[]>(`/api/ssh/commands${node ? `?node=${node}` : ''}`),

  // —— 个人设置

  changePassword: (current: string, next: string) =>
    req<{ ok: boolean }>('/api/me/password', {
      method: 'POST',
      body: JSON.stringify({ current, next }),
    }),

  updateProfile: (body: { name?: string; email?: string }) =>
    req<{ user: Me }>('/api/me', { method: 'PATCH', body: JSON.stringify(body) }),

  myIdentities: () => req<{ identities: IdentityInfo[] }>('/api/me/identities'),

  unbindIdentity: (provider: 'github' | 'password') =>
    req<{ ok: boolean; identities: IdentityInfo[] }>(`/api/me/identities/${provider}`, {
      method: 'DELETE',
    }),
};

export interface SshExport {
  generatedAt: number;
  grants: Array<{
    node: string;
    nodeName: string;
    remoteUser: string;
    owner: string;
    fingerprint: string;
    state: string;
    grantedAt: number;
    expiresAt: number;
    revokeCommands: string[];
  }>;
}

export interface AgentCommandRow {
  id: string;
  nodeId: string;
  kind: string;
  preview: string[];
  state: 'pending' | 'sent' | 'done' | 'failed';
  attempts: number;
  createdAt: number;
  finishedAt: number;
  result: string;
  operator: string;
  refId: string;
}

export interface IdentityInfo {
  provider: 'password' | 'github';
  /** 密码身份是用户名，GitHub 是它的 login */
  label: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface RoleDetail {
  id: string;
  name: string;
  description: string;
  capabilities: Capability[];
  system: boolean;
  locked: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

// ————————————————————————————————————————————————————————
// 设置相关类型
//
// 服务端的 Settings 接口（apps/server/src/settings.ts）在这里有一份镜像，
// 改动时两边都要动 —— 和 types.ts、permissions.ts 是同一个约定。
// ————————————————————————————————————————————————————————

export interface PanelSettings {
  panelName: string;
  panelTagline: string;

  displayCurrency: Currency;
  autoRefreshRates: boolean;
  /** 手填汇率，含义是"1 USD = N 该币种"。只存显式填过的项 */
  rateOverrides: Partial<Record<Currency, number>>;
  costIncludeExpired: boolean;

  byteBase: 1024 | 1000;
  binaryUnitLabels: boolean;
  trafficDirection: 'both' | 'tx' | 'rx';

  timezone: string;

  offlineAfterSeconds: number;
  cpuWarnPercent: number;
  memWarnPercent: number;
  diskWarnPercent: number;
  loadWarnRatio: number;

  expiryWarnDays: number;
  quotaWarnPercent: number;

  metricRetentionHours: number;
  auditRetentionDays: number;
  /** 归因明细（按服务、按对端）保留多少天。日流量总账不受它影响 */
  trafficRetentionDays: number;
}

export interface RatesPayload {
  base: 'USD';
  displayCurrency: Currency;
  /** 生效汇率：手填 > 自动拉取 > 内置参考值 */
  rates: Record<Currency, number>;
  /** 哪些币种用的是手填值 */
  overridden: Currency[];
  fetchedAt: number;
  source: string;
  lastError: string;
  usingFallback: boolean;
  stale: boolean;
  autoRefresh: boolean;
}

export interface SettingsBundle {
  settings: PanelSettings;
  /** 服务端的默认值，用来在界面上标出"这项被改过" */
  defaults: PanelSettings;
  rates: RatesPayload;
  options: {
    currencies: Array<{ value: Currency; symbol: string; label: string; decimals: number }>;
    timezones: Array<{ value: string; label: string }>;
  };
}

// ————————————————————————————————————————————————————————
// 管理相关类型
// ————————————————————————————————————————————————————————

export interface TrafficRule {
  id: string;
  nodeId: string;
  scope: 'day' | 'month';
  threshold: number;
  compare: 'absolute' | 'quota';
  enabled: boolean;
  note: string;
  createdBy: string;
  createdAt: number;
  lastFired: number;
  fireCount: number;
}

export interface LedgerRow {
  nodeId: string;
  nodeName: string;
  countryCode: string;
  provider: string;
  quota: number;
  monthUsed: number;
  monthRx: number;
  monthTx: number;
  todayUsed: number;
  periodRx: number;
  periodTx: number;
  periodTotal: number;
  quotaPercent: number | null;
  dailyAvg: number;
  peakDay: { day: string; total: number };
  series: Array<{ day: string; rx: number; tx: number }>;
}

export interface AdminUser extends Me {
  granted: string[];
  revoked: string[];
  capabilities: Capability[];
  identities: IdentityInfo[];
}

export interface CapabilityCatalog {
  groups: Array<{ group: string; items: Array<{ key: Capability; label: string; risk: string }> }>;
  roles: RoleInfo[];
  all: Capability[];
}

export interface OnlineEntry {
  user: Me;
  sessionId: string;
  ip: string;
  userAgent: string;
  lastActive: number;
  since: number;
  currentView: string;
}

export interface VisitorRow {
  userId: string;
  kind: string;
  name: string;
  login: string;
  avatar: string;
  role: Role;
  actions: number;
  visits: number;
  ipCount: number;
  firstSeen: number;
  lastSeen: number;
}

export interface AuditRow {
  id: string;
  userId: string;
  sessionId: string;
  action: string;
  target: string;
  detail: string;
  ip: string;
  userAgent: string;
  ts: number;
  user: Me | null;
}
