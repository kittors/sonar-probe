/**
 * Sonar 数据契约
 *
 * 这份类型是面板、采集端、前端三方共同遵守的协议。
 * 前端有一份镜像副本：apps/dashboard/src/lib/types.ts —— 改动时两边都要动。
 */

export type NodeStatus = 'online' | 'offline' | 'warning';

/** 机器的静态画像，agent 注册时上报一次，之后很少变。 */
export interface NodeInfo {
  id: string;
  name: string;
  hostname: string;
  /** 面板展示用的公网 IP，已做打码处理的原始值由前端决定是否遮蔽 */
  ip: string;
  countryCode: string;
  region: string;
  provider: string;
  os: string;
  platform: string;
  arch: string;
  kernel: string;
  cpuModel: string;
  cpuCores: number;
  memTotal: number;
  swapTotal: number;
  diskTotal: number;
  /** 计费与到期，用于卡片上的续费提醒 */
  price: number;
  currency: string;
  billingCycle: 'monthly' | 'quarterly' | 'yearly';
  expireAt: number;
  /** 月流量配额，单位 byte；0 表示不限量 */
  trafficQuota: number;
  /** 服务商控制台地址，空串表示没填。只会是 http/https */
  panelUrl: string;
  /** 流量周期从每月几号重置，1-31；0 表示按自然月 */
  billingDay: number;
  tags: string[];
  agentVersion: string;
  bootTime: number;
  createdAt: number;
}

/** 一次采样的实时指标，agent 每 N 秒推一条。 */
export interface Metric {
  nodeId: string;
  ts: number;
  cpu: number;
  memUsed: number;
  swapUsed: number;
  diskUsed: number;
  load1: number;
  load5: number;
  load15: number;
  /** 瞬时速率，byte/s */
  netRx: number;
  netTx: number;
  /** 开机以来累计，byte */
  netRxTotal: number;
  netTxTotal: number;
  tcpConns: number;
  udpConns: number;
  processes: number;
  uptime: number;
  /** 摄氏度，取不到时为 null */
  tempC: number | null;
  /** 磁盘 IO，byte/s */
  diskRead: number;
  diskWrite: number;
}

/** 节点当前状态 = 静态画像 + 最新一条指标 + 在线判定。 */
export interface NodeState extends NodeInfo {
  status: NodeStatus;
  lastSeen: number;
  metric: Metric | null;
  /** 最近 N 个采样点的 CPU，供卡片上的迷你折线用 */
  cpuTrend: number[];
  netTrend: Array<{ rx: number; tx: number }>;
  /** 本流量周期已用（实测 + 人工校准） */
  trafficUsed: number;
  /** 周期内实测累计，不含校准。编辑时拿它对照 */
  trafficMeasured: number;
  /** 当前生效的校准差额，可正可负；0 表示没校准过 */
  trafficOffset: number;
  /** 本流量周期起止，YYYY-MM-DD，左闭右开 */
  cycleStart: string;
  cycleEnd: string;
}

/** 按服务/进程聚合的流量归因。 */
export interface ServiceTraffic {
  nodeId: string;
  service: string;
  /**
   * 归类：反代、数据库、容器、备份… 用于配色和图标。
   * closed 是特殊的一档：连接已经关闭、归属查不到了，不是某个真实存在的服务。
   */
  category: 'web' | 'database' | 'container' | 'transfer' | 'system' | 'app' | 'other' | 'closed';
  rx: number;
  tx: number;
  conns: number;
  /** 主要监听/连出端口 */
  ports: number[];
  pids: number[];
}

/** 按对端 IP 聚合的流量，是拉黑决策的依据。 */
export interface PeerTraffic {
  nodeId: string;
  ip: string;
  rx: number;
  tx: number;
  conns: number;
  countryCode: string;
  asn: number;
  org: string;
  /** 0-100，越高越可疑 */
  threatScore: number;
  /** 触发高分的原因，直接展示给人看 */
  threatReasons: string[];
  ports: number[];
  firstSeen: number;
  lastSeen: number;
  blocked: boolean;
}

/** 一天的流量总量，用于详情页的流量柱状图。 */
export interface DailyTraffic {
  nodeId: string;
  /** YYYY-MM-DD */
  day: string;
  rx: number;
  tx: number;
}

export type BlockMode = 'dry-run' | 'enforced';
export type BlockState = 'pending' | 'active' | 'expired' | 'removed' | 'failed';

/** 一条封禁记录。 */
export interface BlockRule {
  id: string;
  nodeId: string;
  /** 单 IP 或 CIDR */
  target: string;
  reason: string;
  mode: BlockMode;
  state: BlockState;
  /** 将要执行（或已执行）的防火墙命令，落库存证 */
  commands: string[];
  createdAt: number;
  /** 0 表示永久 */
  expiresAt: number;
  operator: string;
  /** agent 执行后的回执 */
  result: string | null;
}

/** 拉黑前的预检结果 —— 决定这个 IP 到底能不能封。 */
export interface BlockPreflight {
  allowed: boolean;
  target: string;
  mode: BlockMode;
  commands: string[];
  /** 阻止执行的硬性原因 */
  blockers: string[];
  /** 不阻止但需要人看一眼的提醒 */
  warnings: string[];
  /** 命中的白名单条目 */
  matchedGuards: string[];
}

// ————————————————————————————————————————————————————————
// SSH
// ————————————————————————————————————————————————————————

/** 一把登记在册的公钥。私钥永远不经过面板。 */
export interface SshKey {
  id: string;
  ownerUserId: string;
  ownerName: string;
  label: string;
  keyType: string;
  /** 公钥原文。生成命令时要用，所以这一份必须存 */
  publicKey: string;
  fingerprint: string;
  bits: number;
  /** manual = 手工粘贴，github = 从 github.com/<login>.keys 导入 */
  source: 'manual' | 'github';
  createdAt: number;
  lastUsedAt: number;
  disabled: boolean;
  /** 这把钥匙目前开着几台机器 */
  grantCount: number;
}

export type GrantState = 'pending' | 'active' | 'drifted' | 'revoked' | 'failed';
export type GrantRequestState = 'pending_approval' | 'approved' | 'rejected';

/** 一条授权：谁的哪把钥匙，开哪台机器的哪个账号。 */
export interface SshGrant {
  id: string;
  nodeId: string;
  nodeName: string;
  keyId: string;
  keyFingerprint: string;
  keyLabel: string;
  ownerUserId: string;
  ownerName: string;
  remoteUser: string;
  state: GrantState;
  requestState: GrantRequestState;
  /** 0 表示永久 */
  expiresAt: number;
  method: 'command' | 'agent';
  requestedBy: string;
  grantedBy: string;
  grantedAt: number;
  approvedBy: string;
  approvedAt: number;
  rejectReason: string;
  /** 机器实况里第一次看到它的时刻。只有它非零才算真的生效 */
  appliedAt: number;
  revokedBy: string;
  revokedAt: number;
  note: string;
}

/** 一台机器怎么连。前半段人可以改，后半段由 agent 上报。 */
export interface SshEndpoint {
  nodeId: string;
  nodeName: string;
  alias: string;
  /** 空串表示回落到 nodes.ip */
  hostname: string;
  /** 实际生效的地址，已处理过回落 */
  effectiveHostname: string;
  port: number;
  defaultUser: string;
  proxyJump: string;
  identityFile: string;
  // —— agent 上报，只读
  hostKeys: Array<{ type: string; blob: string; fingerprint: string }>;
  sshdVersion: string;
  sshdPort: number;
  /** null 表示采不到 */
  passwordAuth: boolean | null;
  permitRootLogin: string;
  observedAt: number;
  /** 实况是不是已经过期到不能用来做删除决策 */
  factsStale: boolean;
}

/**
 * 对账：面板记录 vs 机器实况。
 *
 * unmanaged 那一格是这整套东西最有价值的部分 —— 它回答"这台机器上有几把
 * 我不知道来路的钥匙"，而今天没有任何工具会告诉你这件事。
 */
export interface SshDrift {
  nodeId: string;
  nodeName: string;
  remoteUser: string;
  fingerprint: string;
  keyType: string;
  comment: string;
  /** managed = 带 sonar: 前缀，是我们装的 */
  managed: boolean;
  /** 面板认不认识这把钥匙 */
  known: boolean;
  ownerName: string;
  seenAt: number;
}

/** 授权/撤销前的预检结果，形态与封禁那边一致。 */
export interface SshPreflightResult {
  allowed: boolean;
  blockers: string[];
  warnings: string[];
  /** 将要执行的命令，落库存证并展示给人看 */
  commands: string[];
}

export interface EventLog {
  id: string;
  nodeId: string | null;
  level: 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  ts: number;
}

/**
 * 展示口径。跟着 WebSocket 推给所有在线的人，包括匿名访客。
 *
 * 必须推而不是让各人自己去拉：口径是全局的，管理员把流量进制从 1024 改成 1000
 * 之后，另一个正开着页面的人如果还按旧口径渲染，两个人对着同一台机器会读出
 * 差 10% 的数字，而谁都不知道对方看到的是什么。
 */
export interface PublicSettings {
  panelName: string;
  panelTagline: string;
  displayCurrency: string;
  costIncludeExpired: boolean;
  byteBase: 1024 | 1000;
  binaryUnitLabels: boolean;
  trafficDirection: 'both' | 'tx' | 'rx';
  timezone: string;
  expiryWarnDays: number;
  quotaWarnPercent: number;
  rates: Record<string, number>;
  ratesMeta: { fetchedAt: number; source: string; usingFallback: boolean; stale: boolean };
}

/** WebSocket 下行消息。 */
export type ServerMessage =
  | { type: 'snapshot'; nodes: NodeState[]; ts: number }
  | { type: 'tick'; nodes: NodeState[]; ts: number }
  | { type: 'event'; event: EventLog }
  | { type: 'block'; rule: BlockRule }
  | { type: 'settings'; settings: PublicSettings }
  /**
   * 你的权限刚刚被改了，去重新拉一次 /api/me。
   *
   * 不把新的能力集直接推过来，是因为这条消息的接收者是"被改的那个人"，
   * 而改动可能包含停用账号 —— 那时该发生的是他被登出，不是他收到一份空权限
   * 继续留在页面上。让前端走一次正常的 /api/me，登出、降权、提权三种结果
   * 都由同一条已有的路径处理。
   */
  | { type: 'auth-refresh' };
