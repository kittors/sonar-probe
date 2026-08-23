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

export interface EventLog {
  id: string;
  nodeId: string | null;
  level: 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  ts: number;
}

/** WebSocket 下行消息。 */
export type ServerMessage =
  | { type: 'snapshot'; nodes: NodeState[]; ts: number }
  | { type: 'tick'; nodes: NodeState[]; ts: number }
  | { type: 'event'; event: EventLog }
  | { type: 'block'; rule: BlockRule };
