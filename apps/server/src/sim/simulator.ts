import { db, isFreshDatabase } from '../db.js';
import { dayKeyIn, getSettings } from '../settings.js';
import { Rng, clamp, ouStep } from './rng.js';
import {
  ROLE_PROFILES,
  NODE_SEEDS,
  BENIGN_PEERS,
  SCANNER_PEERS,
  ABUSIVE_PEERS,
  type NodeSeed,
  type PeerSeed,
  type RoleProfile,
} from './profiles.js';
import type { Metric } from '../types.js';

const GB = 1024 ** 3;
const DAY_MS = 86_400_000;

/** 时区偏移，用于让每台机器的忙闲高峰落在它自己的白天。 */
const TZ_OFFSET: Record<string, number> = {
  'Hong Kong': 8,
  Tokyo: 9,
  Singapore: 8,
  Frankfurt: 1,
  'Los Angeles': -8,
  Amsterdam: 1,
  Seattle: -8,
  Paris: 1,
  Sydney: 11,
  Seoul: 9,
  'San Jose': -8,
  Warsaw: 1,
};

/**
 * 昼夜调制系数 0.15 ~ 1.0
 *
 * 用双峰而非单峰：真实业务在上午 10 点和晚上 9 点各有一个高峰，午休有个小凹陷。
 */
function diurnal(ts: number, tzOffset: number): number {
  const local = new Date(ts + tzOffset * 3600_000);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  const morning = Math.exp(-((h - 10.5) ** 2) / 8);
  const evening = Math.exp(-((h - 21) ** 2) / 6);
  const night = 0.15;
  return clamp(night + 0.85 * Math.max(morning, evening * 1.05), 0.12, 1);
}

/** 周末流量下降，周一略高。 */
function weekdayFactor(ts: number): number {
  const d = new Date(ts).getUTCDay();
  if (d === 0 || d === 6) return 0.72;
  if (d === 1) return 1.08;
  return 1;
}

/** 备份窗口：storage 角色在凌晨 3-5 点有一段大流量。 */
function backupWindow(ts: number, tzOffset: number): number {
  const local = new Date(ts + tzOffset * 3600_000);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  return h >= 3 && h < 5 ? 4.2 : 1;
}

interface RuntimeState {
  seed: NodeSeed;
  profile: RoleProfile;
  rng: Rng;
  tzOffset: number;
  /** 连续演化的物理量 */
  cpu: number;
  memRatio: number;
  diskRatio: number;
  load1: number;
  load5: number;
  load15: number;
  netRx: number;
  netTx: number;
  netRxTotal: number;
  netTxTotal: number;
  diskRead: number;
  diskWrite: number;
  conns: number;
  processes: number;
  /** 尖峰的剩余衰减 */
  spikeDecay: number;
  bootTime: number;
  peers: PeerSeed[];
  /** 当天累计的小数残余，避免每次取整丢流量 */
  carryRx: number;
  carryTx: number;
  lastTick: number;
  online: boolean;
}

const states = new Map<string, RuntimeState>();

// 和采集端上报走同一个时区，否则模拟数据和真实数据会落在不同的"天"里
function dayKey(ts: number): string {
  return dayKeyIn(getSettings().timezone, ts);
}

function buildRuntime(seed: NodeSeed, now: number): RuntimeState {
  const profile = ROLE_PROFILES[seed.role];
  const rng = new Rng(seed.id);
  const tzOffset = TZ_OFFSET[seed.region] ?? 0;
  const d = diurnal(now, tzOffset);

  // 每台机器挑一批对端：良性流量是主体，扫描器少量，恶意来源按机器暴露面分配
  const peers: PeerSeed[] = [
    ...rng.sample(BENIGN_PEERS, rng.int(6, 9)),
    ...rng.sample(SCANNER_PEERS, rng.int(1, 2)),
  ];
  // 暴露在公网的角色更容易吃到恶意流量
  const exposure: Record<string, number> = {
    edge: 3,
    app: 2,
    mail: 2,
    database: 1,
    storage: 1,
    build: 1,
    probe: 1,
  };
  peers.push(...rng.sample(ABUSIVE_PEERS, exposure[seed.role] ?? 1));

  // 标记为 warning 的机器要真的处在越界状态，否则面板上永远看不到告警样式。
  // 用磁盘顶到 91%（阈值 90%）来触发，因为磁盘满是最不容易自己恢复的那类问题。
  const warned = seed.health === 'warning';

  return {
    seed,
    profile,
    rng,
    tzOffset,
    cpu: clamp(profile.cpuBase * d * 100 + rng.normal(0, 3), 1, 96),
    memRatio: clamp(profile.memBase + rng.normal(0, 0.04), 0.08, 0.94),
    diskRatio: warned
      ? clamp(0.912 + rng.normal(0, 0.006), 0.905, 0.94)
      : clamp(profile.diskBase + rng.normal(0, 0.03), 0.05, 0.95),
    load1: profile.cpuBase * seed.cpuCores * d,
    load5: profile.cpuBase * seed.cpuCores * d,
    load15: profile.cpuBase * seed.cpuCores * d,
    netRx: profile.rxBase * d,
    netTx: profile.txBase * d,
    netRxTotal: 0,
    netTxTotal: 0,
    diskRead: profile.diskIoBase * d * 0.4,
    diskWrite: profile.diskIoBase * d * 0.6,
    conns: rng.int(profile.connections[0], profile.connections[1]),
    processes: rng.int(profile.processes[0], profile.processes[1]),
    spikeDecay: 0,
    bootTime: now - seed.uptimeDays * DAY_MS - rng.int(0, 86400) * 1000,
    peers,
    carryRx: 0,
    carryTx: 0,
    lastTick: now,
    online: seed.health !== 'offline',
  };
}

/** 推进一个 tick，返回该节点这一刻的指标。dtSec 是这一拍代表的真实秒数。 */
function advance(st: RuntimeState, now: number, dtSec: number): Metric {
  const { profile, rng, seed } = st;
  const d = diurnal(now, st.tzOffset);
  const wd = weekdayFactor(now);
  const activity = d * wd;

  // —— CPU：OU 回归到当前时段的基线，叠加偶发尖峰后指数衰减
  const cpuTarget = profile.cpuBase * activity * 100;
  if (st.spikeDecay > 0.01) {
    st.spikeDecay *= 0.88;
  } else if (rng.bool(profile.spikeChance)) {
    st.spikeDecay = profile.spikeMagnitude * 100 * rng.float(0.5, 1.3);
  } else {
    st.spikeDecay = 0;
  }
  st.cpu = clamp(
    ouStep(st.cpu, cpuTarget, 0.14, profile.cpuVolatility * 100 * 0.35, rng) + st.spikeDecay * 0.14,
    0.4,
    99.2,
  );

  // —— 负载：跟随 CPU 但有惯性，1/5/15 分钟依次更平滑
  const loadTarget = (st.cpu / 100) * seed.cpuCores * rng.float(0.85, 1.25);
  st.load1 = ouStep(st.load1, loadTarget, 0.25, 0.08, rng);
  st.load5 = ouStep(st.load5, st.load1, 0.08, 0.02, rng);
  st.load15 = ouStep(st.load15, st.load5, 0.03, 0.01, rng);
  st.load1 = clamp(st.load1, 0, seed.cpuCores * 6);
  st.load5 = clamp(st.load5, 0, seed.cpuCores * 5);
  st.load15 = clamp(st.load15, 0, seed.cpuCores * 4);

  // —— 内存：缓慢漂移，缓存涨到高位后被回收，呈锯齿
  st.memRatio = ouStep(st.memRatio, profile.memBase + activity * 0.08, 0.03, 0.006, rng);
  if (st.memRatio > 0.93 && rng.bool(0.25)) st.memRatio -= rng.float(0.06, 0.14);
  st.memRatio = clamp(st.memRatio, 0.06, 0.97);

  // —— 磁盘：只增不减，偶尔清理一次。告警机器不让它自己恢复，否则告警会闪来闪去
  st.diskRatio += rng.float(0, 0.00004);
  if (rng.bool(0.0015)) st.diskRatio -= rng.float(0.01, 0.05);
  st.diskRatio = clamp(st.diskRatio, seed.health === 'warning' ? 0.905 : 0.04, 0.97);

  // —— 网络：日周期 + 备份窗口 + 突发
  const backup = seed.role === 'storage' ? backupWindow(now, st.tzOffset) : 1;
  const burst = rng.bool(0.04) ? rng.float(1.6, 3.4) : 1;
  const rxTarget = profile.rxBase * activity * backup * burst;
  const txTarget = profile.txBase * activity * backup * burst;
  // 噪声要跟着目标值缩放。用固定的峰值噪声，夜间目标一小就会被噪声打穿，
  // 曲线会莫名其妙贴到 0。同理下限不取 0：闲置机器也有心跳、DNS、监控的背景流量。
  const rxNoise = Math.max(rxTarget * 0.22, profile.rxBase * 0.03) * profile.netVolatility;
  const txNoise = Math.max(txTarget * 0.22, profile.txBase * 0.03) * profile.netVolatility;
  st.netRx = Math.max(profile.rxBase * 0.02, ouStep(st.netRx, rxTarget, 0.3, rxNoise, rng));
  st.netTx = Math.max(profile.txBase * 0.02, ouStep(st.netTx, txTarget, 0.3, txNoise, rng));

  // —— 磁盘 IO：与 CPU 和网络都有关
  const ioTarget = profile.diskIoBase * activity * (0.6 + st.cpu / 160);
  const ioNoise = Math.max(ioTarget * 0.2, profile.diskIoBase * 0.02);
  st.diskRead = Math.max(profile.diskIoBase * 0.01, ouStep(st.diskRead, ioTarget * 0.42, 0.25, ioNoise, rng));
  st.diskWrite = Math.max(profile.diskIoBase * 0.01, ouStep(st.diskWrite, ioTarget * 0.58, 0.25, ioNoise, rng));

  // —— 连接数与进程数
  const connTarget =
    profile.connections[0] + (profile.connections[1] - profile.connections[0]) * activity;
  st.conns = Math.max(4, Math.round(ouStep(st.conns, connTarget, 0.2, connTarget * 0.06, rng)));
  st.processes = Math.max(
    12,
    Math.round(ouStep(st.processes, (profile.processes[0] + profile.processes[1]) / 2, 0.05, 2.2, rng)),
  );

  // —— 累计量
  const rxBytes = st.netRx * dtSec + st.carryRx;
  const txBytes = st.netTx * dtSec + st.carryTx;
  st.carryRx = rxBytes % 1;
  st.carryTx = txBytes % 1;
  st.netRxTotal += Math.floor(rxBytes);
  st.netTxTotal += Math.floor(txBytes);

  const memTotal = seed.memTotalGb * GB;
  const diskTotal = seed.diskTotalGb * GB;

  return {
    nodeId: seed.id,
    ts: now,
    cpu: Number(st.cpu.toFixed(2)),
    memUsed: Math.round(memTotal * st.memRatio),
    swapUsed: Math.round(
      seed.swapTotalGb * GB * clamp((st.memRatio - 0.82) * 1.6, 0, 0.6) * rng.float(0.8, 1.2),
    ),
    diskUsed: Math.round(diskTotal * st.diskRatio),
    load1: Number(st.load1.toFixed(2)),
    load5: Number(st.load5.toFixed(2)),
    load15: Number(st.load15.toFixed(2)),
    netRx: Math.round(st.netRx),
    netTx: Math.round(st.netTx),
    netRxTotal: st.netRxTotal,
    netTxTotal: st.netTxTotal,
    tcpConns: st.conns,
    udpConns: Math.round(st.conns * rng.float(0.05, 0.18)),
    processes: st.processes,
    uptime: Math.floor((now - st.bootTime) / 1000),
    tempC:
      seed.role === 'probe' ? null : Number((32 + (st.cpu / 100) * 34 + rng.normal(0, 1.4)).toFixed(1)),
    diskRead: Math.round(st.diskRead),
    diskWrite: Math.round(st.diskWrite),
  };
}

// ————————————————————————————————————————————————————————————————
// 首次播种：写入机器清单，并回填 30 天流量 + 24 小时负载曲线
// ————————————————————————————————————————————————————————————————

export function seedDatabase(): void {
  if (!isFreshDatabase()) return;
  const now = Date.now();

  const insertNode = db.prepare(`
    INSERT INTO nodes (id,name,hostname,ip,country_code,region,provider,os,platform,arch,kernel,
      cpu_model,cpu_cores,mem_total,swap_total,disk_total,price,currency,billing_cycle,expire_at,
      traffic_quota,tags,agent_version,boot_time,created_at,last_seen,secret)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  db.exec('BEGIN');
  try {
    for (const seed of NODE_SEEDS) {
      const st = buildRuntime(seed, now);
      states.set(seed.id, st);
      const rng = new Rng(seed.id + ':ip');
      const ip = `${seed.ipPrefix}.${rng.int(2, 254)}.${rng.int(2, 254)}`;
      const lastSeen = seed.health === 'offline' ? now - rng.int(3, 46) * 3600_000 : now;

      insertNode.run(
        seed.id,
        seed.name,
        seed.hostname,
        ip,
        seed.countryCode,
        seed.region,
        seed.provider,
        seed.os,
        seed.os.startsWith('Alpine') ? 'linux' : 'linux',
        seed.cpuModel.includes('aarch64') || seed.cpuModel.includes('Ampere') ? 'arm64' : 'amd64',
        seed.kernel,
        seed.cpuModel,
        seed.cpuCores,
        seed.memTotalGb * GB,
        seed.swapTotalGb * GB,
        seed.diskTotalGb * GB,
        seed.price,
        seed.currency,
        seed.billingCycle,
        now + seed.expireInDays * DAY_MS,
        seed.trafficQuotaTb * 1024 * GB,
        JSON.stringify(seed.tags),
        '0.1.0',
        st.bootTime,
        now - (seed.uptimeDays + 4) * DAY_MS,
        lastSeen,
        '',
      );

      backfillHistory(st, now);
      seedPeers(st, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 回填 30 天日流量（含服务归因）+ 最近 24 小时分钟级指标。 */
function backfillHistory(st: RuntimeState, now: number): void {
  const { seed, profile } = st;
  const rng = new Rng(seed.id + ':history');

  const insDaily = db.prepare(
    'INSERT OR REPLACE INTO daily_traffic (node_id,day,rx,tx) VALUES (?,?,?,?)',
  );
  const insService = db.prepare(`
    INSERT OR REPLACE INTO service_traffic (node_id,day,service,category,rx,tx,conns,ports,pids)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);

  for (let back = 29; back >= 0; back--) {
    const dayTs = now - back * DAY_MS;
    const day = dayKey(dayTs);
    // 当天已过去的比例：今天只算到此刻为止
    const progress = back === 0 ? partOfDayElapsed(now) : 1;
    const wd = weekdayFactor(dayTs);
    // 平均调制系数约为峰值的 45%
    const jitter = rng.float(0.78, 1.24);
    const dayRx = profile.rxBase * 0.45 * wd * jitter * 86400 * progress;
    const dayTx = profile.txBase * 0.45 * wd * jitter * 86400 * progress;

    insDaily.run(seed.id, day, Math.round(dayRx), Math.round(dayTx));

    // 把当天流量按服务权重摊开，权重带抖动，保证总和仍等于当天总量
    const weights = profile.services.map((s) => s.weight * rng.float(0.75, 1.3));
    const sum = weights.reduce((a, b) => a + b, 0);
    profile.services.forEach((svc, i) => {
      const share = (weights[i] as number) / sum;
      insService.run(
        seed.id,
        day,
        svc.name,
        svc.category,
        Math.round(dayRx * share),
        Math.round(dayTx * share),
        Math.round(st.conns * share * rng.float(0.6, 1.4)),
        JSON.stringify(svc.ports),
        JSON.stringify(
          Array.from({ length: rng.int(1, 3) }, () => rng.int(300, 32000)).sort((a, b) => a - b),
        ),
      );
    });
  }

  // 最近 24 小时，每分钟一个采样点 —— 详情页一打开就有完整曲线
  if (seed.health === 'offline') return;
  const insMetric = db.prepare(`
    INSERT OR REPLACE INTO metrics (node_id,ts,cpu,mem_used,swap_used,disk_used,load1,load5,load15,
      net_rx,net_tx,net_rx_total,net_tx_total,tcp_conns,udp_conns,processes,uptime,temp_c,disk_read,disk_write)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const start = now - 24 * 3600_000;
  const warm = buildRuntime(seed, start);
  // 累计流量倒推：开机至今的总量近似为日均 × 运行天数
  warm.netRxTotal = Math.round(profile.rxBase * 0.45 * 86400 * seed.uptimeDays);
  warm.netTxTotal = Math.round(profile.txBase * 0.45 * 86400 * seed.uptimeDays);

  for (let t = start; t <= now; t += 60_000) {
    const m = advance(warm, t, 60);
    insMetric.run(
      m.nodeId,
      m.ts,
      m.cpu,
      m.memUsed,
      m.swapUsed,
      m.diskUsed,
      m.load1,
      m.load5,
      m.load15,
      m.netRx,
      m.netTx,
      m.netRxTotal,
      m.netTxTotal,
      m.tcpConns,
      m.udpConns,
      m.processes,
      m.uptime,
      m.tempC,
      m.diskRead,
      m.diskWrite,
    );
  }
  // 把热身后的连续状态接回实时引擎，避免历史和实时之间出现断崖
  const live = states.get(seed.id);
  if (live) {
    Object.assign(live, {
      cpu: warm.cpu,
      memRatio: warm.memRatio,
      diskRatio: warm.diskRatio,
      load1: warm.load1,
      load5: warm.load5,
      load15: warm.load15,
      netRx: warm.netRx,
      netTx: warm.netTx,
      netRxTotal: warm.netRxTotal,
      netTxTotal: warm.netTxTotal,
      diskRead: warm.diskRead,
      diskWrite: warm.diskWrite,
      conns: warm.conns,
      processes: warm.processes,
    });
  }
}

function partOfDayElapsed(now: number): number {
  const d = new Date(now);
  const secs = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return Math.max(0.02, secs / 86400);
}

/** 生成对端 IP 的流量画像，摊到近 7 天。 */
function seedPeers(st: RuntimeState, now: number): void {
  const { seed, profile } = st;
  const rng = new Rng(seed.id + ':peers');
  const ins = db.prepare(`
    INSERT OR REPLACE INTO peer_traffic
      (node_id,day,ip,rx,tx,conns,country_code,asn,org,threat_score,threat_reasons,ports,first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  // 7 天总量作为分摊基数
  const totalRx = profile.rxBase * 0.45 * 86400 * 7;
  const totalTx = profile.txBase * 0.45 * 86400 * 7;
  const weights = st.peers.map((p) => p.weight * rng.float(0.7, 1.35));
  const sum = weights.reduce((a, b) => a + b, 0);

  st.peers.forEach((peer, i) => {
    const share = (weights[i] as number) / sum;
    let rx = totalRx * share;
    let tx = totalTx * share;
    // 下限防止算出"1 个连接跑了几个 GB"这种一眼假的组合。
    // 权重很低的对端在大流量机器上很容易被摊成 1 连接却仍分到可观流量。
    let conns = Math.max(minConns(peer.kind), Math.round(st.conns * share * rng.float(0.5, 1.6)));

    // 爆破和扫描类的流量必须跟连接数挂钩，不能按总量比例分摊。
    // 按比例算的话，在一台大流量机器上 5% 也有几百 MB，
    // 而判定它们可疑的依据恰恰是"连接数极高、流量极小"—— 数字会和结论自相矛盾。
    if (peer.kind === 'abusive' && peer.ports.includes(22)) {
      conns = rng.int(1800, 5200);
      // 一次失败的 SSH 握手也就几百字节到几 KB
      rx = conns * rng.float(200, 1400);
      tx = conns * rng.float(150, 900);
    } else if (peer.kind === 'scanner') {
      conns = rng.int(120, 460);
      // 端口探测更轻，很多连接连握手都没完成
      rx = conns * rng.float(120, 900);
      tx = conns * rng.float(80, 500);
    }
    // 盗刷流量类：出站被放大
    if (peer.kind === 'abusive' && peer.ip === '103.149.28.44') {
      tx *= 2.6;
    }

    /*
     * 摊到 7 天，而不是全塞进一行。
     *
     * peer_traffic 现在按天分桶，一整周的量堆在今天这一格的话，
     * 界面上选"近 7 天"和选"今天"会得到同一个数字 —— 演示数据
     * 首先得让时间范围这个功能看起来是有用的。
     */
    const perDay = dayWeights(rng, 7);
    const score = scoreThreat(peer, conns, rx + tx);
    const firstSeen = now - rng.int(2, 30) * DAY_MS;
    const lastSeen = now - rng.int(0, 900) * 1000;

    perDay.forEach((w, back) => {
      const dayTs = now - back * DAY_MS;
      ins.run(
        seed.id,
        dayKey(dayTs),
        peer.ip,
        Math.round(rx * w),
        Math.round(tx * w),
        Math.max(1, Math.round(conns * w * perDay.length)),
        peer.countryCode,
        peer.asn,
        peer.org,
        score,
        JSON.stringify(peer.reasons),
        JSON.stringify(peer.ports),
        firstSeen,
        // 只有最近那天的 last_seen 是"刚刚"，往前推的几天各自落在当天
        back === 0 ? lastSeen : dayTs,
      );
    });
  });
}

/** 把 1 拆成 n 份带随机起伏的权重，用于把总量摊到每一天。 */
function dayWeights(rng: Rng, n: number): number[] {
  const raw = Array.from({ length: n }, () => rng.float(0.6, 1.4));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / sum);
}

/** 各类对端的连接数下限。滥用型通常是多连接并发，不会只开一条。 */
function minConns(kind: PeerSeed['kind']): number {
  return kind === 'abusive' ? 18 : kind === 'scanner' ? 60 : 3;
}

/**
 * 威胁评分 0-100
 *
 * 不是黑盒打分：每一分都来自可解释的信号，前端会把 threatReasons 原样展示，
 * 让人在点"封禁"之前知道自己在封什么。
 */
function scoreThreat(peer: PeerSeed, conns: number, bytes?: number): number {
  if (peer.kind === 'benign') return Math.min(12, Math.round(conns / 400));
  let score = peer.kind === 'scanner' ? 34 : 62;

  // 高连接数 + 低流量 = 典型爆破/扫描特征。
  // 只有拿到窗口累计量时才算得准；实时增量的分母太小会让分数虚高，
  // 这时退回按对端的固有特征给分。
  if (bytes !== undefined) {
    const bytesPerConn = conns > 0 ? bytes / conns : Infinity;
    if (bytesPerConn < 2048) score += 18;
    else if (bytesPerConn < 16384) score += 8;
  } else if (peer.ports.some((p) => [22, 3389, 5900].includes(p))) {
    score += 18;
  }
  if (conns > 2000) score += 12;
  if (peer.ports.some((p) => [22, 3389, 5900, 3306, 6379, 27017].includes(p))) score += 10;
  score += Math.min(8, peer.reasons.length * 3);
  return Math.min(99, score);
}

// ————————————————————————————————————————————————————————————————
// 实时推进
// ————————————————————————————————————————————————————————————————

export function ensureRuntimeLoaded(): void {
  if (states.size > 0) return;
  const now = Date.now();
  for (const seed of NODE_SEEDS) {
    const st = buildRuntime(seed, now);
    // 从库里恢复累计量，重启面板不该让流量计数归零
    const row = db
      .prepare('SELECT net_rx_total AS rx, net_tx_total AS tx FROM metrics WHERE node_id=? ORDER BY ts DESC LIMIT 1')
      .get(seed.id) as { rx: number; tx: number } | undefined;
    if (row) {
      st.netRxTotal = row.rx;
      st.netTxTotal = row.tx;
    }
    states.set(seed.id, st);
  }
}

const insMetricLive = () =>
  db.prepare(`
    INSERT OR REPLACE INTO metrics (node_id,ts,cpu,mem_used,swap_used,disk_used,load1,load5,load15,
      net_rx,net_tx,net_rx_total,net_tx_total,tcp_conns,udp_conns,processes,uptime,temp_c,disk_read,disk_write)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

const bumpDaily = () =>
  db.prepare(`
    INSERT INTO daily_traffic (node_id,day,rx,tx) VALUES (?,?,?,?)
    ON CONFLICT(node_id,day) DO UPDATE SET rx = rx + excluded.rx, tx = tx + excluded.tx
  `);

const bumpService = () =>
  db.prepare(`
    INSERT INTO service_traffic (node_id,day,service,category,rx,tx,conns,ports,pids)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(node_id,day,service) DO UPDATE SET
      rx = rx + excluded.rx, tx = tx + excluded.tx, conns = excluded.conns
  `);

const bumpPeer = () =>
  db.prepare(`
    INSERT INTO peer_traffic (node_id,day,ip,rx,tx,conns,country_code,asn,org,threat_score,threat_reasons,ports,first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(node_id,day,ip) DO UPDATE SET
      rx = rx + excluded.rx, tx = tx + excluded.tx, conns = excluded.conns, last_seen = excluded.last_seen
  `);

let stmts: {
  metric: ReturnType<typeof insMetricLive>;
  daily: ReturnType<typeof bumpDaily>;
  service: ReturnType<typeof bumpService>;
  peer: ReturnType<typeof bumpPeer>;
} | null = null;

/**
 * 推进一拍。返回本拍产生的指标，供 WebSocket 广播。
 *
 * dtSec 决定"一拍代表多少秒"。默认与 tick 间隔一致；调大可以让演示时的流量增长更明显。
 */
export function tick(dtSec: number): Metric[] {
  ensureRuntimeLoaded();
  if (!stmts) {
    stmts = { metric: insMetricLive(), daily: bumpDaily(), service: bumpService(), peer: bumpPeer() };
  }
  const now = Date.now();
  const day = dayKey(now);
  const out: Metric[] = [];

  // 真实机器的数据由 agent 上报，模拟器一拍都不能碰它们，
  // 否则真实指标会被虚构数据当场覆盖掉。
  const realNodes = new Set(
    (db.prepare("SELECT id FROM nodes WHERE source='agent'").all() as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );

  db.exec('BEGIN');
  try {
    for (const st of states.values()) {
      if (!st.online) continue;
      if (realNodes.has(st.seed.id)) continue;
      const m = advance(st, now, dtSec);
      out.push(m);

      stmts.metric.run(
        m.nodeId, m.ts, m.cpu, m.memUsed, m.swapUsed, m.diskUsed, m.load1, m.load5, m.load15,
        m.netRx, m.netTx, m.netRxTotal, m.netTxTotal, m.tcpConns, m.udpConns, m.processes,
        m.uptime, m.tempC, m.diskRead, m.diskWrite,
      );
      db.prepare('UPDATE nodes SET last_seen = ? WHERE id = ?').run(now, m.nodeId);

      const rxDelta = Math.round(m.netRx * dtSec);
      const txDelta = Math.round(m.netTx * dtSec);
      stmts.daily.run(m.nodeId, day, rxDelta, txDelta);

      // 同一份流量分别落到"服务"和"对端 IP"两个视角，两边总量保持一致
      distribute(st, day, rxDelta, txDelta, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return out;
}

function distribute(st: RuntimeState, day: string, rxDelta: number, txDelta: number, now: number): void {
  if (!stmts) return;
  const { profile, rng, seed } = st;

  const sw = profile.services.map((s) => s.weight * rng.float(0.8, 1.25));
  const sSum = sw.reduce((a, b) => a + b, 0);
  profile.services.forEach((svc, i) => {
    const share = (sw[i] as number) / sSum;
    stmts!.service.run(
      seed.id, day, svc.name, svc.category,
      Math.round(rxDelta * share), Math.round(txDelta * share),
      Math.max(1, Math.round(st.conns * share)),
      JSON.stringify(svc.ports),
      JSON.stringify([rng.int(300, 32000)]),
    );
  });

  // 被封禁的对端不再贡献新流量 —— 让封禁动作在图表上看得见效果
  const blocked = new Set(
    (
      db
        .prepare("SELECT target FROM block_rules WHERE node_id=? AND state='active'")
        .all(seed.id) as Array<{ target: string }>
    ).map((r) => r.target),
  );
  const live = st.peers.filter((p) => !blocked.has(p.ip));
  if (live.length === 0) return;

  const pw = live.map((p) => p.weight * rng.float(0.7, 1.4));
  const pSum = pw.reduce((a, b) => a + b, 0);
  live.forEach((peer, i) => {
    const share = (pw[i] as number) / pSum;
    const probing =
      peer.kind === 'scanner' || (peer.kind === 'abusive' && peer.ports.includes(22));
    const conns = probing
      ? peer.kind === 'scanner'
        ? rng.int(120, 460)
        : rng.int(1800, 5200)
      : Math.max(minConns(peer.kind), Math.round(st.conns * share));

    // 探测型来源不参与总量分摊，理由同 seedPeers：它们的特征就是流量极小
    const rxAdd = probing ? Math.round(conns * rng.float(0.3, 2.4)) : Math.round(rxDelta * share);
    const txAdd = probing ? Math.round(conns * rng.float(0.2, 1.6)) : Math.round(txDelta * share);

    stmts!.peer.run(
      seed.id, dayKey(now), peer.ip,
      rxAdd, txAdd, conns,
      peer.countryCode, peer.asn, peer.org,
      scoreThreat(peer, conns),
      JSON.stringify(peer.reasons), JSON.stringify(peer.ports),
      now, now,
    );
  });
}

export function getRuntimeNodeIds(): string[] {
  ensureRuntimeLoaded();
  return [...states.keys()];
}
