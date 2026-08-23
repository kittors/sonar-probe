import { db } from './db.js';
import { cycleRange } from './billing.js';
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

/** 超过这个时长没上报就算离线。 */
const OFFLINE_AFTER_MS = 30_000;
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

  return rows.map((row) => {
    const info = rowToNodeInfo(row);
    const lastSeen = row.last_seen as number;
    const mRow = latest.get(info.id) as Record<string, unknown> | undefined;
    const metric = mRow ? rowToMetric(mRow) : null;
    const trendRows = (trend.all(info.id) as Array<{ cpu: number; net_rx: number; net_tx: number }>)
      .slice()
      .reverse();

    const cycle = cycleRange(info.billingDay);
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

function statusOf(lastSeen: number, metric: Metric | null, node: NodeInfo): NodeStatus {
  if (Date.now() - lastSeen > OFFLINE_AFTER_MS || !metric) return 'offline';
  const memPct = node.memTotal > 0 ? metric.memUsed / node.memTotal : 0;
  const diskPct = node.diskTotal > 0 ? metric.diskUsed / node.diskTotal : 0;
  if (metric.cpu > 92 || memPct > 0.92 || diskPct > 0.9 || metric.load1 > node.cpuCores * 2.5) {
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

  const { start, end } = cycleRange(node.billing_day);
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(rx),0) AS rx, COALESCE(SUM(tx),0) AS tx FROM daily_traffic WHERE node_id=? AND day >= ? AND day < ?',
    )
    .get(nodeId, start, end) as { rx: number; tx: number };

  const measured = row.rx + row.tx;
  const offset = node.traffic_offset_cycle === start ? node.traffic_offset : 0;
  // 校准值可能是负的（面板统计比账单高），但总量不该被压到 0 以下
  return Math.max(0, measured + offset);
}

/** 只要实测部分，不含校准 —— 编辑弹窗要拿它算差额。 */
export function measuredCycleTraffic(nodeId: string): number {
  const node = db.prepare('SELECT billing_day FROM nodes WHERE id=?').get(nodeId) as
    | { billing_day: number }
    | undefined;
  if (!node) return 0;
  const { start, end } = cycleRange(node.billing_day);
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(rx),0) AS rx, COALESCE(SUM(tx),0) AS tx FROM daily_traffic WHERE node_id=? AND day >= ? AND day < ?',
    )
    .get(nodeId, start, end) as { rx: number; tx: number };
  return row.rx + row.tx;
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

export function getDailyTraffic(nodeId: string, days = 30): DailyTraffic[] {
  const rows = db
    .prepare('SELECT * FROM daily_traffic WHERE node_id=? ORDER BY day DESC LIMIT ?')
    .all(nodeId, days) as Array<Record<string, unknown>>;
  return rows
    .map((r) => ({
      nodeId: r.node_id as string,
      day: r.day as string,
      rx: r.rx as number,
      tx: r.tx as number,
    }))
    .reverse();
}

export function getServiceTraffic(nodeId: string, days = 7): ServiceTraffic[] {
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      // 老版本 agent 把查不到归属的连接写成 'unknown'，新版本写 '已结束的连接'。
      // 查询跨 7 天，不归一化就会看到两条含义相同的记录并排站着。
      `SELECT
         CASE WHEN service IN ('unknown', '(已结束的连接)', '已结束的连接')
              THEN '已结束的连接' ELSE service END AS service,
         CASE WHEN service IN ('unknown', '(已结束的连接)', '已结束的连接')
              THEN 'closed' ELSE category END AS category,
         SUM(rx) AS rx, SUM(tx) AS tx, MAX(conns) AS conns,
         ports, pids
       FROM service_traffic
       WHERE node_id=? AND day >= ?
       GROUP BY 1
       ORDER BY (SUM(rx) + SUM(tx)) DESC`,
    )
    .all(nodeId, since) as Array<Record<string, unknown>>;

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

export function getPeerTraffic(nodeId: string, limit = 50): PeerTraffic[] {
  const rows = db
    .prepare(
      `SELECT p.*,
              EXISTS(SELECT 1 FROM block_rules b
                     WHERE b.node_id = p.node_id AND b.target = p.ip AND b.state = 'active') AS blocked
       FROM peer_traffic p
       WHERE p.node_id = ?
       ORDER BY (p.rx + p.tx) DESC
       LIMIT ?`,
    )
    .all(nodeId, limit) as Array<Record<string, unknown>>;

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

const CURRENCIES = new Set(['USD', 'EUR', 'CNY', 'JPY', 'HKD', 'GBP']);
const CYCLES = new Set(['monthly', 'quarterly', 'yearly']);

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
  if (patch.currency !== undefined) {
    const c = String(patch.currency).toUpperCase();
    put('currency', CURRENCIES.has(c) ? c : 'USD');
  }
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
        const { start } = cycleRange(row.billing_day);
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

/** 概览页顶部的汇总数字。 */
export function getFleetSummary() {
  const nodes = listNodeStates();
  const online = nodes.filter((n) => n.status === 'online').length;
  const warning = nodes.filter((n) => n.status === 'warning').length;
  const offline = nodes.filter((n) => n.status === 'offline').length;

  const totalRx = nodes.reduce((a, n) => a + (n.metric?.netRx ?? 0), 0);
  const totalTx = nodes.reduce((a, n) => a + (n.metric?.netTx ?? 0), 0);

  const monthPrefix = new Date().toISOString().slice(0, 7);
  const traffic = db
    .prepare(
      "SELECT COALESCE(SUM(rx),0) AS rx, COALESCE(SUM(tx),0) AS tx FROM daily_traffic WHERE day LIKE ?",
    )
    .get(`${monthPrefix}%`) as { rx: number; tx: number };

  const activeBlocks = (
    db.prepare("SELECT COUNT(*) AS n FROM block_rules WHERE state='active'").get() as { n: number }
  ).n;

  const monthlyCost = nodes.reduce((sum, n) => {
    const divisor = n.billingCycle === 'yearly' ? 12 : n.billingCycle === 'quarterly' ? 3 : 1;
    return sum + n.price / divisor;
  }, 0);

  return {
    total: nodes.length,
    online,
    warning,
    offline,
    netRx: totalRx,
    netTx: totalTx,
    monthTraffic: traffic.rx + traffic.tx,
    monthRx: traffic.rx,
    monthTx: traffic.tx,
    activeBlocks,
    monthlyCost: Number(monthlyCost.toFixed(2)),
    /** 30 天内到期的机器，用于续费提醒 */
    expiringSoon: nodes.filter(
      (n) => n.expireAt > 0 && n.expireAt - Date.now() < 30 * 86_400_000,
    ).length,
  };
}
