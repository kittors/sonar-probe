import { db } from './db.js';
import { cycleRange } from './billing.js';
import { convert, effectiveRates } from './rates.js';
import {
  CURRENCIES as SUPPORTED_CURRENCIES,
  dayKeyIn,
  getSettings,
  monthKeyIn,
  normalizeCurrency,
  trafficSumSql,
  trafficTotal,
  type Currency,
} from './settings.js';
import type {
  DailyTraffic,
  EventLog,
  Metric,
  NodeInfo,
  NodeState,
  NodeStatus,
  PeerTraffic,
  ServiceTraffic,
} from './types.js';

/** 卡片上迷你曲线的点数。 */
const TREND_POINTS = 40;

function rowToNodeInfo(row: Record<string, unknown>): NodeInfo {
  return {
    id: row.id as string,
    name: row.name as string,
    hostname: row.hostname as string,
    ip: row.ip as string,
    countryCode: row.country_code as string,
    region: row.region as string,
    provider: row.provider as string,
    os: row.os as string,
    platform: row.platform as string,
    arch: row.arch as string,
    kernel: row.kernel as string,
    cpuModel: row.cpu_model as string,
    cpuCores: row.cpu_cores as number,
    memTotal: row.mem_total as number,
    swapTotal: row.swap_total as number,
    diskTotal: row.disk_total as number,
    price: row.price as number,
    currency: row.currency as string,
    billingCycle: row.billing_cycle as NodeInfo['billingCycle'],
    expireAt: row.expire_at as number,
    trafficQuota: row.traffic_quota as number,
    panelUrl: (row.panel_url as string) ?? '',
    billingDay: (row.billing_day as number) ?? 0,
    tags: JSON.parse((row.tags as string) || '[]'),
    agentVersion: row.agent_version as string,
    bootTime: row.boot_time as number,
    createdAt: row.created_at as number,
  };
}

function rowToMetric(row: Record<string, unknown>): Metric {
  return {
    nodeId: row.node_id as string,
    ts: row.ts as number,
    cpu: row.cpu as number,
    memUsed: row.mem_used as number,
    swapUsed: row.swap_used as number,
    diskUsed: row.disk_used as number,
    load1: row.load1 as number,
    load5: row.load5 as number,
    load15: row.load15 as number,
    netRx: row.net_rx as number,
    netTx: row.net_tx as number,
    netRxTotal: row.net_rx_total as number,
    netTxTotal: row.net_tx_total as number,
    tcpConns: row.tcp_conns as number,
    udpConns: row.udp_conns as number,
    processes: row.processes as number,
    uptime: row.uptime as number,
    tempC: (row.temp_c as number | null) ?? null,
    diskRead: row.disk_read as number,
    diskWrite: row.disk_write as number,
  };
}

export function listNodeStates(): NodeState[] {
  const rows = db.prepare('SELECT * FROM nodes ORDER BY rowid').all() as Array<
    Record<string, unknown>
  >;

  const latest = db.prepare('SELECT * FROM metrics WHERE node_id=? ORDER BY ts DESC LIMIT 1');
  const trend = db.prepare(
    `SELECT cpu, net_rx, net_tx FROM metrics WHERE node_id=? ORDER BY ts DESC LIMIT ${TREND_POINTS}`,
  );

  // 整批机器共用一次设置读取 —— 这个函数每个 tick 都跑，
  // 每台机器都去问一遍设置纯属浪费（getSettings 有缓存，但循环里调仍是白开销）
  const settings = getSettings();

  return rows.map((row) => {
    const info = rowToNodeInfo(row);
    const lastSeen = row.last_seen as number;
    const mRow = latest.get(info.id) as Record<string, unknown> | undefined;
    const metric = mRow ? rowToMetric(mRow) : null;
    const trendRows = (trend.all(info.id) as Array<{ cpu: number; net_rx: number; net_tx: number }>)
      .slice()
      .reverse();

    const cycle = cycleRange(info.billingDay, new Date(), settings.timezone);
    const measured = measuredCycleTraffic(info.id);
    const offset =
      (row.traffic_offset_cycle as string) === cycle.start ? (row.traffic_offset as number) : 0;

    return {
      ...info,
      status: statusOf(lastSeen, metric, info),
      lastSeen,
      metric,
      cpuTrend: trendRows.map((r) => r.cpu),
      netTrend: trendRows.map((r) => ({ rx: r.net_rx, tx: r.net_tx })),
      trafficUsed: Math.max(0, measured + offset),
      trafficMeasured: measured,
      trafficOffset: offset,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
    };
  });
}

/**
 * 在线判定。
 *
 * 全部四条告警线和离线时长都来自面板设置。写死的问题不是"改不了"，
 * 而是没有一组阈值对所有机器都合适 —— 一台跑 CI 的构建机负载常年在
 * 核心数的三四倍，那是它的正常状态，按 2.5 倍判定会让它永远挂着告警，
 * 于是所有人都学会了无视这个颜色。
 */
function statusOf(lastSeen: number, metric: Metric | null, node: NodeInfo): NodeStatus {
  const s = getSettings();
  if (Date.now() - lastSeen > s.offlineAfterSeconds * 1000 || !metric) return 'offline';
  const memPct = node.memTotal > 0 ? (metric.memUsed / node.memTotal) * 100 : 0;
  const diskPct = node.diskTotal > 0 ? (metric.diskUsed / node.diskTotal) * 100 : 0;
  if (
    metric.cpu > s.cpuWarnPercent ||
    memPct > s.memWarnPercent ||
    diskPct > s.diskWarnPercent ||
    metric.load1 > node.cpuCores * s.loadWarnRatio
  ) {
    return 'warning';
  }
  return 'online';
}

export function getNodeState(id: string): NodeState | null {
  return listNodeStates().find((n) => n.id === id) ?? null;
}

/**
 * 本流量周期已用量。
 *
 * = 周期内实测累计 + 人工校准的差额。差额只在它所属的那个周期里生效，
 * 进入新周期后自动作废（那时面板从周期第一天就在统计，不再有缺口）。
 */
export function currentCycleTraffic(nodeId: string): number {
  const node = db
    .prepare('SELECT billing_day, traffic_offset, traffic_offset_cycle FROM nodes WHERE id=?')
    .get(nodeId) as
    | { billing_day: number; traffic_offset: number; traffic_offset_cycle: string }
    | undefined;
  if (!node) return 0;

  const settings = getSettings();
  const { start } = cycleRange(node.billing_day, new Date(), settings.timezone);
  const measured = measuredCycleTraffic(nodeId);
  const offset = node.traffic_offset_cycle === start ? node.traffic_offset : 0;
  // 校准值可能是负的（面板统计比账单高），但总量不该被压到 0 以下
  return Math.max(0, measured + offset);
}

/**
 * 只要实测部分，不含校准 —— 编辑弹窗要拿它算差额。
 *
 * 收发怎么合并由面板设置的计费方向决定。这不是显示偏好，是"这台机器的配额
 * 到底在扣什么"：只计出站的机房里按 rx+tx 算，一台正常同步镜像的机器
 * 会显示成随时要超额。
 */
export function measuredCycleTraffic(nodeId: string): number {
  const node = db.prepare('SELECT billing_day FROM nodes WHERE id=?').get(nodeId) as
    | { billing_day: number }
    | undefined;
  if (!node) return 0;
  const settings = getSettings();
  const { start, end } = cycleRange(node.billing_day, new Date(), settings.timezone);
  const row = db
    .prepare(
      `SELECT ${trafficSumSql(settings.trafficDirection)} AS total
       FROM daily_traffic WHERE node_id=? AND day >= ? AND day < ?`,
    )
    .get(nodeId, start, end) as { total: number };
  return row.total;
}

/**
 * 历史指标。
 *
 * 点数上限固定在 720，超出就按步长抽稀 —— 前端画 24 小时曲线不需要 1440 个点，
 * 传过去只会让 JSON 变大、渲染变慢。
 */
export function getMetricHistory(nodeId: string, sinceMs: number, maxPoints = 720): Metric[] {
  const since = Date.now() - sinceMs;
  const rows = db
    .prepare('SELECT * FROM metrics WHERE node_id=? AND ts >= ? ORDER BY ts ASC')
    .all(nodeId, since) as Array<Record<string, unknown>>;
  if (rows.length <= maxPoints) return rows.map(rowToMetric);
  const step = Math.ceil(rows.length / maxPoints);
  const out: Metric[] = [];
  for (let i = 0; i < rows.length; i += step) out.push(rowToMetric(rows[i] as Record<string, unknown>));
  // 末点必须保留，否则曲线右端会缺一截
  const last = rows[rows.length - 1];
  if (last && out[out.length - 1]?.ts !== (last.ts as number)) out.push(rowToMetric(last));
  return out;
}

/**
 * 一个闭区间的日期范围，YYYY-MM-DD。
 *
 * 流量的三张表都按天分桶，所以对外的时间参数统一到「天」这个粒度 ——
 * 让人能选到小时，却只能按天返回，是更糟的欺骗。
 */
export interface DayRange {
  from: string;
  to: string;
}

/** 最近 N 天（含今天）的日期范围，按面板时区算。 */
export function recentDays(days: number): DayRange {
  const tz = getSettings().timezone;
  const now = Date.now();
  return {
    from: dayKeyIn(tz, now - (Math.max(1, days) - 1) * 86_400_000),
    to: dayKeyIn(tz, now),
  };
}

/**
 * 某台机器当前流量周期的日期范围。
 *
 * cycleRange 给的是左闭右开（end 是下个周期的第一天），而这里对外统一用闭区间，
 * 所以 to 取「今天」而不是周期结束日 —— 未来那些天还没有数据，
 * 把它们算进区间只会让"日均"被一串空日子稀释。
 */
export function nodeCycleRange(nodeId: string): DayRange {
  const row = db.prepare('SELECT billing_day FROM nodes WHERE id=?').get(nodeId) as
    | { billing_day: number }
    | undefined;
  const tz = getSettings().timezone;
  const today = dayKeyIn(tz, Date.now());
  if (!row) return { from: today, to: today };
  const { start } = cycleRange(row.billing_day, new Date(), tz);
  return { from: start, to: today };
}

export function getDailyTraffic(nodeId: string, range: DayRange): DailyTraffic[] {
  const rows = db
    .prepare(
      'SELECT * FROM daily_traffic WHERE node_id=? AND day >= ? AND day <= ? ORDER BY day ASC',
    )
    .all(nodeId, range.from, range.to) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    nodeId: r.node_id as string,
    day: r.day as string,
    rx: r.rx as number,
    tx: r.tx as number,
  }));
}

export function getServiceTraffic(nodeId: string, range: DayRange): ServiceTraffic[] {
  const rows = db
    .prepare(
      // 老版本 agent 把查不到归属的连接写成 'unknown'，新版本写 '已结束的连接'。
      // 查询跨多天，不归一化就会看到两条含义相同的记录并排站着。
      `SELECT
         CASE WHEN service IN ('unknown', '(已结束的连接)', '已结束的连接')
              THEN '已结束的连接' ELSE service END AS service,
         CASE WHEN service IN ('unknown', '(已结束的连接)', '已结束的连接')
              THEN 'closed' ELSE category END AS category,
         SUM(rx) AS rx, SUM(tx) AS tx, MAX(conns) AS conns,
         ports, pids
       FROM service_traffic
       WHERE node_id=? AND day >= ? AND day <= ?
       GROUP BY 1
       ORDER BY (SUM(rx) + SUM(tx)) DESC`,
    )
    .all(nodeId, range.from, range.to) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    nodeId,
    service: r.service as string,
    category: r.category as ServiceTraffic['category'],
    rx: r.rx as number,
    tx: r.tx as number,
    conns: r.conns as number,
    ports: JSON.parse((r.ports as string) || '[]'),
    pids: JSON.parse((r.pids as string) || '[]'),
  }));
}

export function getPeerTraffic(nodeId: string, range: DayRange, limit = 50): PeerTraffic[] {
  const rows = db
    .prepare(
      /*
       * 按 IP 跨天合并。
       *
       * 威胁分取区间内的最高值，理由和入库时一样：一个地址前天扫过端口、
       * 这两天安静下来，不该因为最近一天很干净就把那次扫描抹掉。
       * 判定依据要跟着最高分那一天走，否则会出现「92 分」配一句
       * 「连接数偏多」的错配理由。
       */
      `SELECT p.ip,
              SUM(p.rx) AS rx, SUM(p.tx) AS tx, MAX(p.conns) AS conns,
              MAX(p.country_code) AS country_code, MAX(p.asn) AS asn, MAX(p.org) AS org,
              MAX(p.threat_score) AS threat_score,
              (SELECT q.threat_reasons FROM peer_traffic q
                WHERE q.node_id = p.node_id AND q.ip = p.ip AND q.day >= ? AND q.day <= ?
                ORDER BY q.threat_score DESC, q.day DESC LIMIT 1) AS threat_reasons,
              (SELECT q.ports FROM peer_traffic q
                WHERE q.node_id = p.node_id AND q.ip = p.ip AND q.day >= ? AND q.day <= ?
                ORDER BY q.day DESC LIMIT 1) AS ports,
              MIN(p.first_seen) AS first_seen, MAX(p.last_seen) AS last_seen,
              EXISTS(SELECT 1 FROM block_rules b
                     WHERE b.node_id = p.node_id AND b.target = p.ip AND b.state = 'active') AS blocked
       FROM peer_traffic p
       WHERE p.node_id = ? AND p.day >= ? AND p.day <= ?
       GROUP BY p.ip
       ORDER BY (SUM(p.rx) + SUM(p.tx)) DESC
       LIMIT ?`,
    )
    .all(
      range.from, range.to,
      range.from, range.to,
      nodeId, range.from, range.to,
      limit,
    ) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    nodeId,
    ip: r.ip as string,
    rx: r.rx as number,
    tx: r.tx as number,
    conns: r.conns as number,
    countryCode: r.country_code as string,
    asn: r.asn as number,
    org: r.org as string,
    threatScore: r.threat_score as number,
    threatReasons: JSON.parse((r.threat_reasons as string) || '[]'),
    ports: JSON.parse((r.ports as string) || '[]'),
    firstSeen: r.first_seen as number,
    lastSeen: r.last_seen as number,
    blocked: Number(r.blocked) === 1,
  }));
}

/** 可由管理员编辑的机器属性。都是采集端拿不到的账务信息。 */
export interface NodePatch {
  name?: string;
  provider?: string;
  countryCode?: string;
  region?: string;
  price?: number;
  currency?: string;
  billingCycle?: NodeInfo['billingCycle'];
  /** 到期时间戳；0 表示未设置 */
  expireAt?: number;
  /** 月流量配额，字节；0 表示不限量 */
  trafficQuota?: number;
  /** 服务商控制台地址。只接受 http/https，其余一律存空 */
  panelUrl?: string;
  /** 流量周期从每月几号重置，1-31；0 表示按自然月 */
  billingDay?: number;
  /**
   * 本周期实际已用量（字节），用来校准。
   *
   * 传的是"服务商后台此刻显示的真实值"，不是差额 —— 差额由服务端根据当前实测
   * 算出来存，调用方不需要先查一次再自己减，也就不会有中间的竞态。
   * 传 null 表示撤销校准。
   */
  trafficUsedActual?: number | null;
  tags?: string[];
}

/**
 * 外部链接消毒。
 *
 * 这个值最终会进 <a href>，所以**必须**限死协议：`javascript:alert(1)` 放进 href
 * 点一下就执行了，`data:text/html,...` 同理。只放行 http/https，其余一律清空 ——
 * 宁可丢掉这个链接，也不能留一个能执行脚本的入口。
 *
 * 前端渲染前还会再查一次（见 lib/format.ts 的 safeUrl）。两道是故意的：
 * 库里可能有更早版本写进去的脏数据，光靠写入时校验管不到它们。
 */
function sanitizeUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString().slice(0, 500);
  } catch {
    // 连 URL 都解析不出来的就不是链接
    return '';
  }
}

const CYCLES = new Set(['monthly', 'quarterly', 'yearly']);

/** 机器可选的计价币种，跟设置页的展示币种共用一份清单。 */
export const NODE_CURRENCIES = SUPPORTED_CURRENCIES;

/**
 * 更新机器的账务属性。
 *
 * 只允许改这几项 —— CPU 型号、内存大小这些是采集端上报的事实，
 * 让人手动覆盖只会让面板和真机对不上。
 */
export function updateNode(id: string, patch: NodePatch): NodeState | null {
  const existing = db.prepare('SELECT id FROM nodes WHERE id=?').get(id);
  if (!existing) return null;

  const sets: string[] = [];
  const args: unknown[] = [];

  const put = (col: string, value: unknown) => {
    sets.push(`${col} = ?`);
    args.push(value);
  };

  if (patch.name !== undefined) put('name', String(patch.name).trim().slice(0, 60) || id);
  if (patch.provider !== undefined) put('provider', String(patch.provider).trim().slice(0, 40));
  if (patch.countryCode !== undefined) {
    const cc = String(patch.countryCode).trim().toUpperCase().slice(0, 2);
    put('country_code', /^[A-Z]{2}$/.test(cc) ? cc : 'XX');
  }
  if (patch.region !== undefined) put('region', String(patch.region).trim().slice(0, 40));
  if (patch.price !== undefined) {
    const p = Number(patch.price);
    put('price', Number.isFinite(p) && p >= 0 ? Math.round(p * 100) / 100 : 0);
  }
  if (patch.currency !== undefined) put('currency', normalizeCurrency(patch.currency));
  if (patch.billingCycle !== undefined) {
    put('billing_cycle', CYCLES.has(patch.billingCycle) ? patch.billingCycle : 'monthly');
  }
  if (patch.expireAt !== undefined) {
    const t = Number(patch.expireAt);
    put('expire_at', Number.isFinite(t) && t > 0 ? Math.floor(t) : 0);
  }
  if (patch.trafficQuota !== undefined) {
    const q = Number(patch.trafficQuota);
    put('traffic_quota', Number.isFinite(q) && q > 0 ? Math.floor(q) : 0);
  }
  if (patch.panelUrl !== undefined) put('panel_url', sanitizeUrl(patch.panelUrl));
  if (patch.billingDay !== undefined) {
    const d = Math.floor(Number(patch.billingDay));
    put('billing_day', Number.isFinite(d) && d >= 1 && d <= 31 ? d : 0);
  }
  if (patch.tags !== undefined) {
    const tags = (Array.isArray(patch.tags) ? patch.tags : [])
      .map((t) => String(t).trim().slice(0, 20))
      .filter(Boolean)
      .slice(0, 8);
    put('tags', JSON.stringify(tags));
  }

  /*
   * 校准要放在最后单独处理。
   *
   * 差额 = 用户填的真实值 − 当前实测值，而"当前实测值"取决于 billing_day
   * （周期变了，实测的区间也就变了）。所以必须等上面那批字段先落库，
   * 再按新的周期去算，否则改账单日的同时校准会拿旧周期的实测值去减。
   */
  if (sets.length > 0) {
    args.push(id);
    db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...(args as never[]));
  }

  if (patch.trafficUsedActual !== undefined) {
    if (patch.trafficUsedActual === null) {
      db.prepare("UPDATE nodes SET traffic_offset=0, traffic_offset_cycle='' WHERE id=?").run(id);
    } else {
      const actual = Number(patch.trafficUsedActual);
      if (Number.isFinite(actual) && actual >= 0) {
        const row = db.prepare('SELECT billing_day FROM nodes WHERE id=?').get(id) as {
          billing_day: number;
        };
        const { start } = cycleRange(row.billing_day, new Date(), getSettings().timezone);
        // measuredCycleTraffic 已按计费方向合并过，差额自然也是同一口径
        const offset = Math.round(actual) - measuredCycleTraffic(id);
        db.prepare('UPDATE nodes SET traffic_offset=?, traffic_offset_cycle=? WHERE id=?').run(
          offset,
          start,
          id,
        );
      }
    }
  }

  return getNodeState(id);
}

export function logEvent(
  nodeId: string | null,
  level: EventLog['level'],
  kind: string,
  message: string,
): EventLog {
  const ev: EventLog = {
    id: crypto.randomUUID(),
    nodeId,
    level,
    kind,
    message,
    ts: Date.now(),
  };
  db.prepare('INSERT INTO events (id,node_id,level,kind,message,ts) VALUES (?,?,?,?,?,?)').run(
    ev.id, ev.nodeId, ev.level, ev.kind, ev.message, ev.ts,
  );
  return ev;
}

export function listEvents(limit = 60, nodeId?: string): EventLog[] {
  const rows = nodeId
    ? db.prepare('SELECT * FROM events WHERE node_id=? ORDER BY ts DESC LIMIT ?').all(nodeId, limit)
    : db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(limit);
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    nodeId: (r.node_id as string | null) ?? null,
    level: r.level as EventLog['level'],
    kind: r.kind as string,
    message: r.message as string,
    ts: r.ts as number,
  }));
}

/**
 * 一台机器摊到每个月的成本，折算成指定币种。
 *
 * 两件事必须一起做，少一件结果就没有意义：
 *   折算周期 —— 年付 1200 和月付 1200 完全不是一回事；
 *   折算币种 —— 把 52 欧元当 52 美元加进去，得到的数字既不是欧元也不是美元。
 */
function monthlyCostOf(
  node: Pick<NodeInfo, 'price' | 'currency' | 'billingCycle'>,
  to: Currency,
  rates: Record<Currency, number>,
): number {
  if (!(node.price > 0)) return 0;
  const divisor = node.billingCycle === 'yearly' ? 12 : node.billingCycle === 'quarterly' ? 3 : 1;
  return convert(node.price / divisor, normalizeCurrency(node.currency), to, rates);
}

/** 概览页顶部的汇总数字。 */
export function getFleetSummary() {
  const settings = getSettings();
  const nodes = listNodeStates();
  const online = nodes.filter((n) => n.status === 'online').length;
  const warning = nodes.filter((n) => n.status === 'warning').length;
  const offline = nodes.filter((n) => n.status === 'offline').length;

  const totalRx = nodes.reduce((a, n) => a + (n.metric?.netRx ?? 0), 0);
  const totalTx = nodes.reduce((a, n) => a + (n.metric?.netTx ?? 0), 0);

  // 月份按面板时区取。跨月那几个小时里 UTC 和本地不在同一个月，
  // 用 UTC 会让月初的汇总数字凭空少掉大半天的流量
  const month = monthKeyIn(settings.timezone);
  const traffic = db
    .prepare(
      `SELECT COALESCE(SUM(rx),0) AS rx, COALESCE(SUM(tx),0) AS tx
       FROM daily_traffic WHERE day LIKE ?`,
    )
    .get(`${month}%`) as { rx: number; tx: number };

  const activeBlocks = (
    db.prepare("SELECT COUNT(*) AS n FROM block_rules WHERE state='active'").get() as { n: number }
  ).n;

  /*
   * 月度成本。
   *
   * 原来这里是 `sum + n.price / divisor` —— 不看币种，把各国货币的面值
   * 直接相加，再统一标一个美元符号。三台机器分别 12.9 美元、52 欧元、
   * 180 人民币时，它会得出 "$244.90"，而真实支出约合 90 美元。
   * 那个数字不是估算不准，是根本没有单位。
   */
  const displayCurrency = normalizeCurrency(settings.displayCurrency);
  const { rates, usingFallback, stale, fetchedAt } = effectiveRates();
  const now = Date.now();

  // 已过期的机器默认不计：到期就不再扣费了，继续算进月度支出会让人
  // 以为自己每月还在为一台早就停掉的机器付钱
  const billable = settings.costIncludeExpired
    ? nodes
    : nodes.filter((n) => n.expireAt <= 0 || n.expireAt > now);

  const monthlyCost = billable.reduce(
    (sum, n) => sum + monthlyCostOf(n, displayCurrency, rates),
    0,
  );

  // 按币种拆一份明细。汇总数字换算过，人总会想知道换算前各是多少
  const costByCurrency: Array<{ currency: Currency; amount: number; nodes: number }> = [];
  for (const code of SUPPORTED_CURRENCIES) {
    const group = billable.filter((n) => n.price > 0 && normalizeCurrency(n.currency) === code);
    if (group.length === 0) continue;
    const amount = group.reduce((sum, n) => sum + monthlyCostOf(n, code, rates), 0);
    costByCurrency.push({ currency: code, amount: Number(amount.toFixed(2)), nodes: group.length });
  }

  const expiryWindowMs = settings.expiryWarnDays * 86_400_000;

  return {
    total: nodes.length,
    online,
    warning,
    offline,
    netRx: totalRx,
    netTx: totalTx,
    monthTraffic: trafficTotal(traffic.rx, traffic.tx, settings.trafficDirection),
    monthRx: traffic.rx,
    monthTx: traffic.tx,
    activeBlocks,
    monthlyCost: Number(monthlyCost.toFixed(2)),
    /** 汇总用的币种，前端照它选符号，不要再自己假定 */
    costCurrency: displayCurrency,
    costByCurrency,
    /** 有几台填了价格 —— 一台都没填时"月度成本 0"是句空话，前端据此决定显不显示 */
    pricedNodes: billable.filter((n) => n.price > 0).length,
    /** 汇率只是内置参考值或者已经过期，界面上要如实说明 */
    ratesUsingFallback: usingFallback,
    ratesStale: stale,
    ratesFetchedAt: fetchedAt,
    /*
     * 按设置的提醒窗口算，不再前端 7 天、后端 30 天各说各话。
     *
     * 已过期的单独算一档。原来的判定是 `expireAt - now < 窗口`，负数天然满足，
     * 于是一台过期 30 天的机器会被数进"7 天内到期"里 —— 那句话对它是错的，
     * 而且它需要的动作也不同：即将到期是"该续费了"，已过期是"要么续要么删"。
     */
    expiringSoon: nodes.filter((n) => n.expireAt > now && n.expireAt - now < expiryWindowMs).length,
    expired: nodes.filter((n) => n.expireAt > 0 && n.expireAt <= now).length,
  };
}
