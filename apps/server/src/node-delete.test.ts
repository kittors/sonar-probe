import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * 删除机器。
 *
 * 这件事出错的方式都很安静：漏清一张表不会报错，只会留下一批永远查不到主人的行；
 * 忘了立墓碑也不会报错，只是那台机器下次重启又回到了面板上；内存里的累计值
 * 没清，要等到同一个标识重新接入那天才会在流量账本里多出一截。
 * 这些用例把每一种安静的失败都显式地锁住。
 */

const GB = 1024 ** 3;
const DAY = 86_400_000;

let dir: string;
let db: import('node:sqlite').DatabaseSync;
let dbMod: typeof import('./db.js');
let ingest: typeof import('./agent-ingest.js');
let removal: typeof import('./node-delete.js');
let tombs: typeof import('./tombstones.js');
let sim: typeof import('./sim/simulator.js');

/** 要删的那台 */
const A = 'hk-156';
/** 旁边那台，删 A 时它的数据一行都不能少 */
const B = 'lax-bwg';
/** 模拟种子里的一台在线机器 */
const S = 'hkg-edge-01';

const NOW = Date.now();

function insertNode(id: string, source: 'agent' | 'sim', lastReport: number) {
  db.prepare(
    `INSERT INTO nodes (id, name, hostname, ip, cpu_cores, mem_total, disk_total,
                        created_at, last_seen, source, agent_last_report)
     VALUES (?, ?, 'h', '203.0.113.9', 2, ?, ?, 0, ?, ?, ?)`,
  ).run(id, `机器 ${id}`, 4 * GB, 40 * GB, lastReport, source, lastReport);
}

/** 给每张"跟着机器走"的表都插一行，用来证明删除时一张不漏、也不误伤 */
function seedEveryTable(id: string, alias: string) {
  db.prepare(
    `INSERT INTO metrics (node_id, ts, cpu, mem_used, swap_used, disk_used, load1, load5, load15,
       net_rx, net_tx, net_rx_total, net_tx_total, tcp_conns, udp_conns, processes, uptime)
     VALUES (?, ?, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1)`,
  ).run(id, NOW - 5000);
  db.prepare(`INSERT INTO daily_traffic (node_id, day, rx, tx) VALUES (?, '2026-01-02', 10, 20)`).run(id);
  db.prepare(`INSERT INTO daily_traffic (node_id, day, rx, tx) VALUES (?, '2026-03-04', 10, 20)`).run(id);
  db.prepare(`INSERT INTO service_traffic (node_id, day, service) VALUES (?, '2026-03-04', 'nginx')`).run(id);
  db.prepare(`INSERT INTO peer_traffic (node_id, day, ip) VALUES (?, '2026-03-04', '198.51.100.7')`).run(id);
  db.prepare(
    `INSERT INTO block_rules (id, node_id, target, created_at) VALUES (?, ?, '192.0.2.1', ?)`,
  ).run(`b-seed-${id}`, id, NOW);
  db.prepare(
    `INSERT INTO agent_commands (id, node_id, kind, created_at) VALUES (?, ?, 'block', ?)`,
  ).run(`c-${id}`, id, NOW);
  db.prepare(`INSERT INTO ssh_endpoints (node_id, alias) VALUES (?, ?)`).run(id, alias);
  db.prepare(
    `INSERT INTO ssh_observed_keys (node_id, remote_user, fingerprint, seen_at) VALUES (?, 'root', 'SHA256:x', ?)`,
  ).run(id, NOW);
  db.prepare(
    `INSERT INTO traffic_rules (id, node_id, threshold, created_at) VALUES (?, ?, 100, ?)`,
  ).run(`r-${id}`, id, NOW);
  db.prepare(
    `INSERT INTO ssh_grants (id, node_id, key_id, remote_user, state, request_state)
     VALUES (?, ?, 'k1', 'seed', 'revoked', 'approved')`,
  ).run(`g-seed-${id}`, id);
  db.prepare(`INSERT INTO events (id, node_id, level, kind, message, ts) VALUES (?, ?, 'warn', 'agent', ?, ?)`).run(
    `e-${id}`,
    id,
    `机器 ${id} 离线`,
    NOW,
  );
}

function grant(id: string, user: string, state: string, requestState: string, expiresAt = 0) {
  db.prepare(
    `INSERT INTO ssh_grants (id, node_id, key_id, remote_user, state, request_state, expires_at, granted_at)
     VALUES (?, ?, 'k1', ?, ?, ?, ?, ?)`,
  ).run(id, A, user, state, requestState, expiresAt, NOW);
}

function block(id: string, state: string, expiresAt: number) {
  db.prepare(
    `INSERT INTO block_rules (id, node_id, target, state, mode, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'enforced', ?, ?)`,
  ).run(id, A, `198.51.100.${id.length}`, state, NOW, expiresAt);
}

function rowsOf(table: string, id: string): number {
  return Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE node_id=?`).get(id) as { n: number }).n,
  );
}

function report(nodeId: string, rxTotal: number) {
  return {
    nodeId,
    metric: {
      cpu: 1, memUsed: GB, swapUsed: 0, diskUsed: GB,
      load1: 0.1, load5: 0.1, load15: 0.1,
      netRx: 0, netTx: 0, netRxTotal: rxTotal, netTxTotal: 0,
      tcpConns: 1, udpConns: 0, processes: 10, uptime: 100, tempC: null,
      diskRead: 0, diskWrite: 0,
    },
  } as Parameters<typeof ingest.ingestReport>[0];
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sonar-node-delete-'));
  process.env.SONAR_DB = join(dir, 'test.db');
  process.env.SONAR_AGENT_TOKEN = 'test-token';
  dbMod = await import('./db.js');
  db = dbMod.db;
  ingest = await import('./agent-ingest.js');
  removal = await import('./node-delete.js');
  tombs = await import('./tombstones.js');
  sim = await import('./sim/simulator.js');

  db.prepare(`INSERT INTO users (id, name, created_at) VALUES ('u1', '小王', 0)`).run();
  db.prepare(
    `INSERT INTO ssh_keys (id, owner_user_id, label, key_type, public_key, fingerprint, created_at)
     VALUES ('k1', 'u1', '笔记本', 'ssh-ed25519', 'ssh-ed25519 AAAA', 'SHA256:laptop', 0)`,
  ).run();

  // A 的采集端还在报，B 早就停了
  insertNode(A, 'agent', NOW);
  insertNode(B, 'agent', 0);
  seedEveryTable(A, 'hk156');
  seedEveryTable(B, 'bwg');

  // 全局流量规则：node_id 为空，删哪台机器都不该碰它
  db.prepare(`INSERT INTO traffic_rules (id, node_id, threshold, created_at) VALUES ('r-global', '', 1, 0)`).run();

  // —— A 上的授权，逐条对应"算不算残留"的口径
  grant('g-active', 'root', 'active', 'approved');
  grant('g-pending', 'deploy', 'pending', 'approved');
  grant('g-awaiting', 'ops', 'pending', 'pending_approval'); // 还没批，从没下发过
  grant('g-drifted', 'git', 'drifted', 'approved'); // 机器上已经没了
  grant('g-expired', 'tmp', 'active', 'approved', NOW - 1000); // sshd 已经拒了

  // —— A 上的封禁
  block('b-forever', 'active', 0);
  block('b-later', 'active', NOW + DAY);
  block('b-lapsed', 'active', NOW - 1000); // nftables 的 timeout 已经把它摘了
  block('b-dryrun', 'pending', 0); // 从没碰过防火墙
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('库里每一张带 node_id 的表都登记了删除策略', () => {
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
  ).map((t) => t.name);
  const withNodeId = tables.filter((t) =>
    (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).some((c) => c.name === 'node_id'),
  );
  const registered = new Set<string>([...dbMod.NODE_OWNED_TABLES, ...dbMod.NODE_HISTORY_TABLES]);

  const missing = withNodeId.filter((t) => !registered.has(t));
  assert.deepEqual(
    missing,
    [],
    `这些表带 node_id 却没决定删机器时清不清：${missing.join(', ')}。去 db.ts 的 NODE_OWNED_TABLES 或 NODE_HISTORY_TABLES 里登记`,
  );
  // 反过来也要成立：清单里拼错一个表名，删除时那句 DELETE 会直接让整个事务回滚
  for (const t of registered) {
    assert.ok(withNodeId.includes(t), `清单里的 ${t} 不存在或没有 node_id 列`);
  }
});

test('影响评估：只把真会留在机器上的封禁和授权算作残留', () => {
  const impact = removal.deletionImpact(A, NOW)!;
  assert.ok(impact);
  assert.equal(impact.source, 'agent');
  assert.equal(impact.agentActive, true, 'A 刚刚还在上报');

  assert.deepEqual(
    impact.liveGrants.map((g) => g.id).sort(),
    ['g-active', 'g-pending'],
    '待审批的没下发过、漂移的机器上已经没了、过期的 sshd 会拒 —— 都不算',
  );
  const live = impact.liveGrants.find((g) => g.id === 'g-active')!;
  assert.equal(live.ownerName, '小王');
  assert.equal(live.fingerprint, 'SHA256:laptop');

  assert.deepEqual(
    impact.activeBlocks.map((b) => b.id).sort(),
    ['b-forever', 'b-later'],
    'dry-run 没碰过防火墙，已过期的内核已经摘掉了',
  );

  assert.equal(impact.history.trafficDays, 2);
  assert.equal(impact.history.firstTrafficDay, '2026-01-02');
  assert.equal(impact.history.attributionRows, 2);
  assert.equal(impact.history.trafficRules, 1, '全局规则不属于这台机器');
  assert.equal(impact.history.pendingCommands, 1);
});

test('离线的机器不算采集端仍在上报', () => {
  assert.equal(removal.deletionImpact(B, NOW)!.agentActive, false);
});

test('机器不存在时如实说不存在', () => {
  assert.equal(removal.deletionImpact('no-such-node'), null);
  assert.throws(
    () => removal.deleteNode('no-such-node', { operator: 't' }),
    (e: unknown) => e instanceof removal.NodeDeleteError && e.status === 404,
  );
});

test('还有可能留在机器上的公钥时，没确认就拒绝，而且一行都不动', () => {
  const before = rowsOf('metrics', A);
  assert.throws(
    () => removal.deleteNode(A, { operator: 't' }, NOW),
    (e: unknown) => e instanceof removal.NodeDeleteError && e.status === 409 && /2 把/.test(e.message),
  );
  assert.ok(db.prepare('SELECT 1 FROM nodes WHERE id=?').get(A), '机器还在');
  assert.equal(rowsOf('metrics', A), before);
  assert.equal(tombs.deletedNode(A), null, '没删成就不能立墓碑');
});

test('删除：A 的每一张表都清空，B 和全局数据原样不动', () => {
  // 先让 A 在内存里留下累计值，后面验证它被清掉了
  ingest.ingestReport(report(A, 100 * GB), '203.0.113.9');

  const bBefore = Object.fromEntries(dbMod.NODE_OWNED_TABLES.map((t) => [t, rowsOf(t, B)]));
  const result = removal.deleteNode(A, { operator: 'yr', acknowledgeGrants: true }, NOW);

  assert.equal(result.tombstoned, true);
  assert.equal(result.impact.liveGrants.length, 2, '快照要带着残留授权，审计靠它');
  assert.ok(result.rows.ssh_grants! >= 6);

  assert.equal(db.prepare('SELECT 1 FROM nodes WHERE id=?').get(A), undefined);
  for (const t of dbMod.NODE_OWNED_TABLES) {
    assert.equal(rowsOf(t, A), 0, `${t} 里还留着 A 的行`);
    assert.equal(rowsOf(t, B), bBefore[t], `删 A 误伤了 B 在 ${t} 里的数据`);
  }

  assert.equal(rowsOf('events', A), 1, '事件是历史，机器没了也不改写');
  assert.ok(db.prepare(`SELECT 1 FROM traffic_rules WHERE id='r-global'`).get(), '全局规则被误删了');
  assert.ok(db.prepare(`SELECT 1 FROM ssh_keys WHERE id='k1'`).get(), '公钥属于人，不属于机器');

  const tomb = tombs.deletedNode(A)!;
  assert.equal(tomb.name, `机器 ${A}`);
  assert.equal(tomb.deletedBy, 'yr');
  assert.equal(tomb.deletedAt, NOW);
});

test('被删的机器不能借注册回来', () => {
  assert.throws(
    () => ingest.registerAgentNode({ id: A, name: '换个名字也没用' }),
    (e: unknown) => e instanceof tombs.NodeDeletedError && e.message.includes(A),
  );
  assert.equal(db.prepare('SELECT 1 FROM nodes WHERE id=?').get(A), undefined, '拒绝了却还是建出了一行');
});

test('被删的机器的上报也被拒绝，而且说得出原因', () => {
  assert.throws(
    () => ingest.ingestReport(report(A, 101 * GB), '203.0.113.9'),
    (e: unknown) => e instanceof tombs.NodeDeletedError,
  );
  assert.throws(
    () => ingest.ingestReport(report('never-existed', 1), '203.0.113.9'),
    (e: unknown) => !(e instanceof tombs.NodeDeletedError) && /未知节点/.test(String(e)),
    '从没存在过的机器不能被说成"已删除"',
  );
  assert.equal(rowsOf('metrics', A), 0);
});

test('被拒的来访：按分钟记时间，一天最多提醒一次', () => {
  const t0 = NOW + 10_000;
  assert.equal(tombs.noteRejectedAttempt(A, t0), true, '第一次回来要提醒');
  assert.equal(tombs.deletedNode(A)!.lastAttempt, t0);

  assert.equal(tombs.noteRejectedAttempt(A, t0 + 2000), false, '两秒后的重试不再提醒');
  assert.equal(tombs.deletedNode(A)!.lastAttempt, t0, '一分钟内不重复写库');

  assert.equal(tombs.noteRejectedAttempt(A, t0 + 61_000), false);
  assert.equal(tombs.deletedNode(A)!.lastAttempt, t0 + 61_000);

  assert.equal(tombs.noteRejectedAttempt(A, t0 + DAY), true, '隔天还在报，再提醒一次');
  assert.equal(tombs.noteRejectedAttempt('not-deleted', t0), false);
});

test('解除墓碑后同一个标识能重新接入，且从零开始计流量', () => {
  const tomb = tombs.allowReenroll(A);
  assert.equal(tomb?.id, A);
  assert.equal(tombs.deletedNode(A), null);
  assert.equal(tombs.allowReenroll(A), null, '解除过的不能再解除一次');

  assert.deepEqual(ingest.registerAgentNode({ id: A, name: '重装后的 156' }), { created: true });

  // 删除前内存里记着 100 GB。缓存没清的话，这一拍会凭空记下 50 GB
  ingest.ingestReport(report(A, 150 * GB), '203.0.113.9');
  const total = db
    .prepare('SELECT COALESCE(SUM(rx + tx), 0) AS n FROM daily_traffic WHERE node_id=?')
    .get(A) as { n: number };
  assert.equal(total.n, 0, '重新接入的第一拍没有"上一次"可比，不该记任何流量');

  ingest.ingestReport(report(A, 151 * GB), '203.0.113.9');
  const after = db
    .prepare('SELECT COALESCE(SUM(rx + tx), 0) AS n FROM daily_traffic WHERE node_id=?')
    .get(A) as { n: number };
  assert.equal(after.n, GB, '之后照常按差值累加');
});

test('再删一次：墓碑覆盖旧记录，来访痕迹清零', () => {
  removal.deleteNode(A, { operator: 'admin' }, NOW + 5 * DAY);
  const tomb = tombs.deletedNode(A)!;
  assert.equal(tomb.deletedBy, 'admin');
  assert.equal(tomb.deletedAt, NOW + 5 * DAY);
  assert.equal(tomb.lastAttempt, 0);
  assert.equal(tomb.name, '重装后的 156');
});

test('模拟机器：删掉后模拟器不再给它写数据，也不立墓碑', () => {
  insertNode(S, 'sim', NOW);
  sim.ensureRuntimeLoaded();
  sim.tick(2);
  assert.ok(rowsOf('metrics', S) > 0, '前提：删之前模拟器在推进它');
  assert.equal(rowsOf('metrics', 'nrt-app-01'), 0, '库里没有的种子从一开始就不该被推进');

  const result = removal.deleteNode(S, { operator: 't' });
  assert.equal(result.tombstoned, false);
  assert.equal(tombs.deletedNode(S), null);

  sim.tick(2);
  for (const t of dbMod.NODE_OWNED_TABLES) {
    assert.equal(rowsOf(t, S), 0, `模拟器在删除之后又往 ${t} 里写了 ${S} 的数据`);
  }
});
