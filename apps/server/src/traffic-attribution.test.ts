import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * 流量归因的累加口径。
 *
 * 0.1.0 里 agent 报的是 conntrack 的**瞬时快照**，面板整天覆盖写 —— 那两张表
 * 回答的是"此刻谁连着"，而人问的是"这段时间谁把流量吃掉了"。实测一台生产机：
 * 近 7 天归因合计 11.03 GB，同期实际走了 278.45 GB，覆盖率 4%。
 *
 * 新版 agent 改报增量、面板改成累加。这组用例锁住累加这一侧的行为：
 * 多拍相加、端口取并集、连接数取峰值、按天分桶、按区间聚合。
 * 任何一条退回覆盖写，那张排行榜就会重新变成一个和时间无关的数字。
 */

const MB = 1000 ** 2;
const NODE = 'attr-test';
/** 钉死时钟：全部落在同一天，才验得了"同一天多拍累加" */
const NOW = new Date('2026-08-23T12:00:00Z');
const TODAY = '2026-08-23';

let dir: string;
let ingest: typeof import('./agent-ingest.js');
let store: typeof import('./store.js');
let dbMod: typeof import('./db.js');
let db: import('node:sqlite').DatabaseSync;

type Svc = { service: string; category?: string; rx: number; tx: number; conns: number; ports?: number[]; pids?: number[] };
type Peer = { ip: string; rx: number; tx: number; conns: number; ports?: number[] };

/** 新 agent 的上报：带 attributionDelta，声明装的是增量 */
function report(services: Svc[], peers: Peer[] = []) {
  return {
    nodeId: NODE,
    metric: { netRxTotal: 0, netTxTotal: 0 },
    services,
    peers,
    attributionDelta: true,
  } as unknown as Parameters<typeof ingest.ingestReport>[0];
}

/** 0.1.0 agent 的上报：没有那个标记，装的是 conntrack 当前快照 */
function snapshotReport(services: Svc[], peers: Peer[] = []) {
  return {
    nodeId: NODE,
    metric: { netRxTotal: 0, netTxTotal: 0 },
    services,
    peers,
  } as unknown as Parameters<typeof ingest.ingestReport>[0];
}

function svcRow(name: string) {
  return db
    .prepare('SELECT rx, tx, conns, ports, pids FROM service_traffic WHERE node_id=? AND day=? AND service=?')
    .get(NODE, TODAY, name) as
    | { rx: number; tx: number; conns: number; ports: string; pids: string }
    | undefined;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sonar-attr-'));
  process.env.SONAR_DB = join(dir, 'test.db');
  process.env.SONAR_AGENT_TOKEN = 'test-token';
  dbMod = await import('./db.js');
  db = dbMod.db;
  ingest = await import('./agent-ingest.js');
  store = await import('./store.js');
  mock.timers.enable({ apis: ['Date'], now: NOW });

  db.prepare(
    `INSERT INTO nodes (id, name, hostname, ip, cpu_cores, created_at, last_seen, source)
     VALUES (?, '归因测试机', 'h', '203.0.113.7', 2, 0, 0, 'agent')`,
  ).run(NODE);
});

after(() => {
  mock.timers.reset();
  rmSync(dir, { recursive: true, force: true });
});

// ————————————————————————————————————————————————————————
// 服务归因
// ————————————————————————————————————————————————————————

test('同一天多次上报要累加，不是覆盖', () => {
  ingest.ingestReport(report([{ service: 'nginx', rx: 100 * MB, tx: 40 * MB, conns: 12 }]), '1.2.3.4');
  ingest.ingestReport(report([{ service: 'nginx', rx: 60 * MB, tx: 20 * MB, conns: 9 }]), '1.2.3.4');

  const row = svcRow('nginx');
  assert.ok(row);
  assert.equal(row.rx, 160 * MB, '两拍的增量应该相加');
  assert.equal(row.tx, 60 * MB);
});

test('连接数取峰值而不是相加', () => {
  // conns 是"同时有多少条连接"。累加的话，一台连接数稳定在 12 的机器
  // 跑一天能报出几十万 —— 而对端评分正是按"连接多、流量小"判扫描的
  assert.equal(svcRow('nginx')?.conns, 12);
});

test('端口取并集，不被单拍的视野截断', () => {
  ingest.ingestReport(
    report([{ service: 'nginx', rx: MB, tx: MB, conns: 3, ports: [80], pids: [900] }]),
    '1.2.3.4',
  );
  ingest.ingestReport(
    report([{ service: 'nginx', rx: MB, tx: MB, conns: 3, ports: [443], pids: [901] }]),
    '1.2.3.4',
  );

  const row = svcRow('nginx');
  assert.deepEqual(JSON.parse(row!.ports), [80, 443], '一次采样只看得见当时活跃的端口，覆盖会让列表每两秒跳一次');
  assert.deepEqual(JSON.parse(row!.pids), [900, 901]);
});

test('区间聚合把跨天的量加起来', () => {
  // 手写前一天的行，模拟昨天也跑过
  db.prepare(
    `INSERT INTO service_traffic (node_id,day,service,category,rx,tx,conns,ports,pids)
     VALUES (?, '2026-08-22', 'nginx', 'web', ?, 0, 5, '[80]', '[]')`,
  ).run(NODE, 500 * MB);

  const twoDays = store.getServiceTraffic(NODE, { from: '2026-08-22', to: TODAY });
  const nginx = twoDays.find((s) => s.service === 'nginx');
  assert.ok(nginx);
  assert.equal(nginx.rx, 662 * MB, '昨天 500 + 今天 162');

  // 只看今天就不该带上昨天那 500
  const oneDay = store.getServiceTraffic(NODE, { from: TODAY, to: TODAY });
  assert.equal(oneDay.find((s) => s.service === 'nginx')?.rx, 162 * MB);
});

test('查询区间之外的天不会漏进来', () => {
  const none = store.getServiceTraffic(NODE, { from: '2026-08-01', to: '2026-08-02' });
  assert.equal(none.length, 0);
});

test('老 agent 的 unknown 和新的"已结束的连接"合成一条', () => {
  db.prepare(
    `INSERT INTO service_traffic (node_id,day,service,category,rx,tx,conns,ports,pids)
     VALUES (?, '2026-08-22', 'unknown', 'other', ?, 0, 1, '[]', '[]')`,
  ).run(NODE, 10 * MB);
  ingest.ingestReport(
    report([{ service: '已结束的连接', category: 'closed', rx: 5 * MB, tx: 0, conns: 1 }]),
    '1.2.3.4',
  );

  const rows = store.getServiceTraffic(NODE, { from: '2026-08-22', to: TODAY });
  const closed = rows.filter((s) => s.service === '已结束的连接');
  assert.equal(closed.length, 1, '两种写法含义相同，不该并排站着');
  assert.equal(closed[0]!.rx, 15 * MB);
});

// ————————————————————————————————————————————————————————
// 对端归因
// ————————————————————————————————————————————————————————

test('对端流量按天分桶并累加', () => {
  ingest.ingestReport(report([], [{ ip: '198.51.100.4', rx: 30 * MB, tx: 10 * MB, conns: 6 }]), '1.2.3.4');
  ingest.ingestReport(report([], [{ ip: '198.51.100.4', rx: 20 * MB, tx: 5 * MB, conns: 4 }]), '1.2.3.4');

  const row = db
    .prepare('SELECT rx, tx, conns FROM peer_traffic WHERE node_id=? AND day=? AND ip=?')
    .get(NODE, TODAY, '198.51.100.4') as { rx: number; tx: number; conns: number };
  assert.equal(row.rx, 50 * MB);
  assert.equal(row.tx, 15 * MB);
  assert.equal(row.conns, 6, '连接数取峰值');
});

test('对端按区间跨天合并', () => {
  db.prepare(
    `INSERT INTO peer_traffic (node_id,day,ip,rx,tx,conns,ports,first_seen,last_seen)
     VALUES (?, '2026-08-22', '198.51.100.4', ?, 0, 3, '[443]', 100, 200)`,
  ).run(NODE, 70 * MB);

  const peers = store.getPeerTraffic(NODE, { from: '2026-08-22', to: TODAY }, 50);
  const p = peers.find((x) => x.ip === '198.51.100.4');
  assert.ok(p);
  assert.equal(p.rx, 120 * MB, '昨天 70 + 今天 50');
  assert.equal(p.firstSeen, 100, '首次见到取区间内最早的');
});

test('威胁分取区间内最高，判定依据跟着最高分那天走', () => {
  // 一次明显的扫描：连接极多、每条流量极小
  ingest.ingestReport(
    report([], [{ ip: '198.51.100.9', rx: 1000, tx: 500, conns: 400, ports: [22, 3306] }]),
    '1.2.3.4',
  );
  // 随后安静下来。最后一拍很干净，但那次扫描不该被抹掉
  ingest.ingestReport(report([], [{ ip: '198.51.100.9', rx: 8 * MB, tx: MB, conns: 2 }]), '1.2.3.4');

  const p = store
    .getPeerTraffic(NODE, { from: TODAY, to: TODAY }, 50)
    .find((x) => x.ip === '198.51.100.9');
  assert.ok(p);
  assert.ok(p.threatScore > 0, '扫描行为发生过就该留下分数');
  assert.ok(
    p.threatReasons.length > 0,
    '有分数就必须有可解释的依据 —— 面板要拿它给人看"为什么建议封这个地址"',
  );
});

test('排行按区间内的总量排序', () => {
  const peers = store.getPeerTraffic(NODE, { from: '2026-08-22', to: TODAY }, 50);
  for (let i = 1; i < peers.length; i++) {
    const prev = peers[i - 1]!;
    const cur = peers[i]!;
    assert.ok(prev.rx + prev.tx >= cur.rx + cur.tx, '排行榜必须真的有序');
  }
});

// ————————————————————————————————————————————————————————
// 新旧采集端的分界
// ————————————————————————————————————————————————————————

test('没声明增量的上报（老 agent）一条归因都不写', () => {
  const before = (t: string) =>
    (db.prepare(`SELECT COALESCE(SUM(rx+tx),0) v FROM ${t} WHERE node_id=?`).get(NODE) as {
      v: number;
    }).v;
  const svcBefore = before('service_traffic');
  const peerBefore = before('peer_traffic');

  /*
   * 0.1.0 报的是 conntrack 当前快照 —— 一条挂了三天的长连接，它那 60 GB
   * 会出现在每一拍里。按累加口径收下来，两秒一次、一天四万多拍，
   * 排行榜上会长出几十 TB。
   */
  for (let i = 0; i < 5; i++) {
    ingest.ingestReport(
      snapshotReport(
        [{ service: 'nginx', rx: 60_000 * MB, tx: 0, conns: 3 }],
        [{ ip: '198.51.100.77', rx: 60_000 * MB, tx: 0, conns: 3 }],
      ),
      '1.2.3.4',
    );
  }

  assert.equal(before('service_traffic'), svcBefore, '快照被累加进去就会得出天文数字');
  assert.equal(before('peer_traffic'), peerBefore);
});

test('丢弃的同时要留一条事件说明原因', () => {
  // 空的排行榜会让人去查为什么，前提是面板告诉过他发生了什么。
  // 不说的话，这就成了另一个"安静地错着"的功能
  const ev = db
    .prepare("SELECT message FROM events WHERE node_id=? AND kind='agent' ORDER BY ts DESC LIMIT 1")
    .get(NODE) as { message: string } | undefined;
  assert.ok(ev, '应该记下一条事件');
  assert.match(ev.message, /版本过旧|升级/, `事件要说清怎么恢复，实际是：${ev.message}`);
});

test('提示不会每两秒刷一条', () => {
  const count = () =>
    (db.prepare("SELECT COUNT(*) n FROM events WHERE node_id=? AND kind='agent'").get(NODE) as {
      n: number;
    }).n;
  const before = count();
  for (let i = 0; i < 10; i++) {
    ingest.ingestReport(snapshotReport([{ service: 'x', rx: MB, tx: 0, conns: 1 }]), '1.2.3.4');
  }
  assert.equal(before, count(), '同一台机器在窗口内只提示一次，否则事件流会被同一句话填满');
});

// ————————————————————————————————————————————————————————
// 保留策略
// ————————————————————————————————————————————————————————

test('过期的归因明细会被清掉，日流量总账不动', () => {
  db.prepare(
    `INSERT INTO service_traffic (node_id,day,service,category,rx,tx,conns,ports,pids)
     VALUES (?, '2020-01-01', 'old', 'other', 1, 1, 1, '[]', '[]')`,
  ).run(NODE);
  db.prepare(
    `INSERT INTO peer_traffic (node_id,day,ip,rx,tx,conns,ports,first_seen,last_seen)
     VALUES (?, '2020-01-01', '198.51.100.200', 1, 1, 1, '[]', 0, 0)`,
  ).run(NODE);
  db.prepare(`INSERT INTO daily_traffic (node_id,day,rx,tx) VALUES (?, '2020-01-01', 1, 1)`).run(
    NODE,
  );

  dbMod.pruneTrafficDetail(30);

  const left = (t: string) =>
    (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE day='2020-01-01'`).get() as { n: number }).n;
  assert.equal(left('service_traffic'), 0);
  assert.equal(left('peer_traffic'), 0);
  assert.equal(
    left('daily_traffic'),
    1,
    '日流量总账每机每天只有一行，却是唯一能回答"去年这个月用了多少"的账本 —— 不该跟着归因明细一起删',
  );
});

test('保留期为 0 表示永久保留', () => {
  db.prepare(
    `INSERT INTO service_traffic (node_id,day,service,category,rx,tx,conns,ports,pids)
     VALUES (?, '2019-01-01', 'ancient', 'other', 1, 1, 1, '[]', '[]')`,
  ).run(NODE);

  assert.equal(dbMod.pruneTrafficDetail(0), 0, '0 是"别删"，不是"全删"');
  const n = (
    db.prepare(`SELECT COUNT(*) n FROM service_traffic WHERE day='2019-01-01'`).get() as {
      n: number;
    }
  ).n;
  assert.equal(n, 1);
});
