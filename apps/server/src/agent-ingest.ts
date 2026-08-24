import { timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { dayKeyIn, getSettings } from './settings.js';
import { logEvent } from './store.js';
import type { Metric } from './types.js';

/**
 * 采集端上报接入
 *
 * agent 报上来的是"开机以来的累计值"和"当前速率"。这里要做两件转换：
 *
 *   累计流量 → 日流量：记住上次的累计值，取差值累加到 daily_traffic。
 *                      机器重启会让累计值归零，差值算出负数，要当成新起点而不是倒扣。
 *
 *   conntrack 快照 → 服务/对端流量：conntrack 条目会过期消失，累计值本身会往下掉，
 *                      所以这两张表对真实节点用覆盖写而不是累加。它表达的是
 *                      "当前活跃连接的流量分布"，回答"谁在吃带宽"已经够了。
 */

export interface AgentNodeInfo {
  id: string;
  name?: string;
  hostname?: string;
  ip?: string;
  countryCode?: string;
  region?: string;
  provider?: string;
  os?: string;
  platform?: string;
  arch?: string;
  kernel?: string;
  cpuModel?: string;
  cpuCores?: number;
  memTotal?: number;
  swapTotal?: number;
  diskTotal?: number;
  tags?: string[];
  agentVersion?: string;
  bootTime?: number;
  trafficQuota?: number;
}

export interface AgentServiceTraffic {
  service: string;
  category?: string;
  rx: number;
  tx: number;
  conns: number;
  ports?: number[];
  pids?: number[];
}

export interface AgentPeerTraffic {
  ip: string;
  rx: number;
  tx: number;
  conns: number;
  ports?: number[];
}

export interface AgentReport {
  nodeId: string;
  metric: Partial<Metric>;
  services?: AgentServiceTraffic[];
  peers?: AgentPeerTraffic[];
}

/**
 * 这条上报归到哪一天。
 *
 * 必须和读取端（billing.ts 的周期判定、traffic-rules 的日/月用量）用同一个
 * 时区，否则每天会有几个小时的流量落在读取端认为的"另一天"里。
 * 两边都取自面板设置。
 *
 * 改时区不会重算历史：已经写进 daily_traffic 的行仍按旧时区归属。
 * 换时区当天的那一格会有几个小时的偏差，之后恢复正常 —— 这是设置页里
 * 写明的取舍，重算历史需要逐条采样的原始时间戳，而那些早被 pruneMetrics 清掉了。
 */
function nowDay(ts = Date.now()): string {
  return dayKeyIn(getSettings().timezone, ts);
}

/** 回环和私有地址不能当作机器的对外地址。 */
function isRoutableIp(addr: string): boolean {
  if (!addr) return false;
  if (addr.includes(':')) return addr !== '::1';
  const p = addr.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  if (a === 127 || a === 0) return false;
  if (a === 10) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

export function agentTokenValid(token: string | undefined): boolean {
  const expected = process.env.SONAR_AGENT_TOKEN ?? '';
  // 没配 token 就不开放上报通道 —— 否则任何人都能往面板里塞数据
  if (!expected) return false;
  if (typeof token !== 'string') return false;
  /*
   * 恒定时间比较。
   *
   * `===` 对字符串是短路的：前缀猜对得越多，返回得越晚。这个时间差在本机是纳秒级，
   * 隔着网络几乎不可测，但同一台机器上的其他进程、或者共享宿主的邻居是能量到的。
   * 项目里 auth.ts 早就用了 timingSafeEqual，这里没用只是疏漏。
   */
  return safeCompare(token, expected);
}

/** 长度不同也要走完比较，否则长度本身就泄露了信息 */
function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // 跟自己比一次，让耗时和长度相同的情况保持在同一量级
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function agentIngestEnabled(): boolean {
  return Boolean(process.env.SONAR_AGENT_TOKEN);
}

/** agent 首次连上或重启后调用，写入机器画像。 */
export function registerAgentNode(info: AgentNodeInfo): { created: boolean } {
  const now = Date.now();
  const existing = db.prepare('SELECT id, source FROM nodes WHERE id = ?').get(info.id) as
    | { id: string; source: string }
    | undefined;

  if (existing) {
    // 已存在的模拟节点不允许被 agent 顶替，避免演示数据和真实数据混淆同一个 id
    if (existing.source === 'sim') {
      throw new Error(`节点 id "${info.id}" 已被模拟器占用，请给 agent 换一个 id`);
    }
    // 地区、厂商、标签也要跟着更新 —— 它们是 agent 启动参数，
    // 改了配置重启后应该立刻反映到面板，而不是只在首次注册时写一次
    db.prepare(`
      UPDATE nodes SET name=?, hostname=?, ip=?, os=?, platform=?, arch=?, kernel=?,
        cpu_model=?, cpu_cores=?, mem_total=?, swap_total=?, disk_total=?,
        country_code=?, region=?, provider=?, tags=?,
        agent_version=?, boot_time=?, last_seen=?, agent_last_report=?
      WHERE id=?
    `).run(
      info.name ?? info.hostname ?? info.id,
      info.hostname ?? '',
      info.ip ?? '',
      info.os ?? '',
      info.platform ?? 'linux',
      info.arch ?? '',
      info.kernel ?? '',
      info.cpuModel ?? '',
      info.cpuCores ?? 1,
      info.memTotal ?? 0,
      info.swapTotal ?? 0,
      info.diskTotal ?? 0,
      info.countryCode || 'XX',
      info.region ?? '',
      info.provider ?? '',
      JSON.stringify(info.tags ?? []),
      info.agentVersion ?? '',
      info.bootTime ?? now,
      now,
      now,
      info.id,
    );
    return { created: false };
  }

  db.prepare(`
    INSERT INTO nodes (id,name,hostname,ip,country_code,region,provider,os,platform,arch,kernel,
      cpu_model,cpu_cores,mem_total,swap_total,disk_total,price,currency,billing_cycle,expire_at,
      traffic_quota,tags,agent_version,boot_time,created_at,last_seen,secret,source,agent_last_report)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'USD','monthly',0,?,?,?,?,?,?,'','agent',?)
  `).run(
    info.id,
    info.name ?? info.hostname ?? info.id,
    info.hostname ?? '',
    info.ip ?? '',
    info.countryCode ?? 'XX',
    info.region ?? '',
    info.provider ?? '',
    info.os ?? '',
    info.platform ?? 'linux',
    info.arch ?? '',
    info.kernel ?? '',
    info.cpuModel ?? '',
    info.cpuCores ?? 1,
    info.memTotal ?? 0,
    info.swapTotal ?? 0,
    info.diskTotal ?? 0,
    info.trafficQuota ?? 0,
    JSON.stringify(info.tags ?? []),
    info.agentVersion ?? '',
    info.bootTime ?? now,
    now,
    now,
    now,
  );

  logEvent(info.id, 'info', 'agent', `采集端接入：${info.name ?? info.hostname ?? info.id}`);
  return { created: true };
}

/** 上一次的累计流量，用来算日增量。进程内缓存即可，重启后从库里的最后一条恢复。 */
const lastTotals = new Map<string, { rx: number; tx: number }>();

/**
 * 清空累计值缓存。
 *
 * 只给测试用 —— 用来模拟"面板进程重启"：缓存没了之后必须能从数据库里的
 * 上一条 metrics 续上，否则会把机器的整个累计流量当成一次增量记进当天。
 */
export function resetTotalsCache(): void {
  lastTotals.clear();
}

function previousTotals(nodeId: string): { rx: number; tx: number } | null {
  const cached = lastTotals.get(nodeId);
  if (cached) return cached;
  const row = db
    .prepare('SELECT net_rx_total AS rx, net_tx_total AS tx FROM metrics WHERE node_id=? ORDER BY ts DESC LIMIT 1')
    .get(nodeId) as { rx: number; tx: number } | undefined;
  return row ?? null;
}

export function ingestReport(report: AgentReport, remoteIp: string): void {
  const nodeId = report.nodeId;
  const node = db.prepare('SELECT id, source, ip FROM nodes WHERE id=?').get(nodeId) as
    | { id: string; source: string; ip: string }
    | undefined;

  if (!node) throw new Error(`未知节点 ${nodeId}，请先调用 /api/agent/register`);
  if (node.source !== 'agent') throw new Error(`节点 ${nodeId} 不是采集端节点`);

  const now = Date.now();
  const m = report.metric ?? {};
  const rxTotal = Math.max(0, Math.floor(Number(m.netRxTotal ?? 0)));
  const txTotal = Math.max(0, Math.floor(Number(m.netTxTotal ?? 0)));

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT OR REPLACE INTO metrics (node_id,ts,cpu,mem_used,swap_used,disk_used,load1,load5,load15,
        net_rx,net_tx,net_rx_total,net_tx_total,tcp_conns,udp_conns,processes,uptime,temp_c,disk_read,disk_write)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      nodeId, now,
      num(m.cpu), int(m.memUsed), int(m.swapUsed), int(m.diskUsed),
      num(m.load1), num(m.load5), num(m.load15),
      int(m.netRx), int(m.netTx), rxTotal, txTotal,
      int(m.tcpConns), int(m.udpConns), int(m.processes), int(m.uptime),
      m.tempC == null ? null : num(m.tempC),
      int(m.diskRead), int(m.diskWrite),
    );

    // —— 日流量增量
    const prev = previousTotals(nodeId);
    if (prev) {
      // 机器重启后累计值会归零，此时差值为负。这不是"流量减少"，
      // 是计数器重置 —— 当成新起点，本拍不计增量。
      const dRx = rxTotal >= prev.rx ? rxTotal - prev.rx : 0;
      const dTx = txTotal >= prev.tx ? txTotal - prev.tx : 0;
      if (dRx > 0 || dTx > 0) {
        db.prepare(`
          INSERT INTO daily_traffic (node_id,day,rx,tx) VALUES (?,?,?,?)
          ON CONFLICT(node_id,day) DO UPDATE SET rx = rx + excluded.rx, tx = tx + excluded.tx
        `).run(nodeId, nowDay(now), dRx, dTx);
      }
    }
    lastTotals.set(nodeId, { rx: rxTotal, tx: txTotal });

    // —— 服务归因：覆盖写当天的快照
    if (report.services?.length) {
      const day = nowDay(now);
      db.prepare('DELETE FROM service_traffic WHERE node_id=? AND day=?').run(nodeId, day);
      const ins = db.prepare(`
        INSERT INTO service_traffic (node_id,day,service,category,rx,tx,conns,ports,pids)
        VALUES (?,?,?,?,?,?,?,?,?)
      `);
      for (const s of report.services.slice(0, 60)) {
        ins.run(
          nodeId, day, String(s.service).slice(0, 64), s.category ?? 'other',
          int(s.rx), int(s.tx), int(s.conns),
          JSON.stringify((s.ports ?? []).slice(0, 8)),
          JSON.stringify((s.pids ?? []).slice(0, 6)),
        );
      }
    }

    // —— 对端流量：同样覆盖写
    if (report.peers?.length) {
      db.prepare('DELETE FROM peer_traffic WHERE node_id=?').run(nodeId);
      const ins = db.prepare(`
        INSERT INTO peer_traffic (node_id,ip,rx,tx,conns,country_code,asn,org,threat_score,threat_reasons,ports,first_seen,last_seen)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const p of report.peers.slice(0, 200)) {
        const scored = scorePeer(p);
        ins.run(
          nodeId, String(p.ip).slice(0, 45), int(p.rx), int(p.tx), int(p.conns),
          'XX', 0, '',
          scored.score, JSON.stringify(scored.reasons),
          JSON.stringify((p.ports ?? []).slice(0, 8)),
          now, now,
        );
      }
    }

    // 注意用单引号：SQLite 里 "" 是标识符（会被当成列名），'' 才是空字符串。
    // 另外来源地址只在它像个公网地址时才用 —— agent 和面板同机时走回环，
    // 拿 127.0.0.1 当机器 IP 写进去，面板上就会显示一台"127.0.0.*"的机器。
    const usableIp = isRoutableIp(remoteIp) ? remoteIp : '';
    db.prepare("UPDATE nodes SET last_seen=?, agent_last_report=?, ip=COALESCE(NULLIF(ip,''),?) WHERE id=?")
      .run(now, now, usableIp, nodeId);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 真实对端的威胁评分。
 *
 * 拿不到 ASN 和情报库，只能靠行为特征判断，所以判定比模拟数据保守 ——
 * 宁可少报，也不要因为一条误判让人去封掉正常用户。
 */
function scorePeer(p: AgentPeerTraffic): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const bytes = p.rx + p.tx;
  const perConn = p.conns > 0 ? bytes / p.conns : Infinity;
  const ports = p.ports ?? [];

  if (p.conns >= 200 && perConn < 2048) {
    score += 45;
    reasons.push(`${p.conns} 条连接但每条平均只有 ${Math.round(perConn)} 字节，像是在反复试探`);
  } else if (p.conns >= 60 && perConn < 8192) {
    score += 22;
    reasons.push(`连接数偏多（${p.conns}）而流量很小`);
  }

  const sensitive = ports.filter((x) => [22, 3389, 5900, 3306, 5432, 6379, 27017, 9200].includes(x));
  if (sensitive.length > 0) {
    score += 20;
    reasons.push(`触碰了远程登录或数据库端口：${sensitive.join(', ')}`);
  }

  if (ports.length >= 6) {
    score += 15;
    reasons.push(`短时间内接触了 ${ports.length} 个不同端口，符合扫描特征`);
  }

  return { score: Math.min(99, score), reasons };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function int(v: unknown): number {
  return Math.max(0, Math.floor(num(v)));
}

/** 采集端节点的 id 列表，模拟器要跳过它们。 */
export function agentNodeIds(): Set<string> {
  const rows = db.prepare("SELECT id FROM nodes WHERE source='agent'").all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** 超过阈值没上报的采集端节点会被判定离线，由 store 的在线判定统一处理。 */
export function staleAgentNodes(thresholdMs = 60_000): string[] {
  const cutoff = Date.now() - thresholdMs;
  const rows = db
    .prepare("SELECT id FROM nodes WHERE source='agent' AND agent_last_report < ?")
    .all(cutoff) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
