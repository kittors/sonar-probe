import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * 流量周期 + 校准的端到端检查。
 *
 * 走真实的 SQLite（临时库），因为要验的正是建表迁移、按周期区间查询、
 * 以及"改账单日的同时做校准"这几件事的配合 —— 纯函数测试覆盖不到。
 *
 * db.ts 在模块加载时就读 SONAR_DB 并建库，所以环境变量必须在 import 之前设好，
 * 这里只能用动态 import。
 */

const GB = 1024 ** 3;
let dir: string;
let store: typeof import('./store.js');
let db: import('node:sqlite').DatabaseSync;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sonar-test-'));
  process.env.SONAR_DB = join(dir, 'test.db');
  db = (await import('./db.js')).db;
  store = await import('./store.js');

  db.prepare(
    `INSERT INTO nodes (id, name, hostname, ip, traffic_quota, created_at, last_seen, source)
     VALUES ('n1', '测试机', 'h', '1.2.3.4', ?, 0, 0, 'agent')`,
  ).run(1000 * GB);

  // 8/18、8/20 在 8/21 之前（上一周期），8/21 起是本周期
  const days: Array<[string, number]> = [
    ['2026-08-18', 5],
    ['2026-08-20', 7],
    ['2026-08-21', 10],
    ['2026-08-22', 15],
  ];
  for (const [day, gb] of days) {
    db.prepare('INSERT INTO daily_traffic (node_id, day, rx, tx) VALUES (?,?,?,?)').run(
      'n1',
      day,
      gb * GB,
      0,
    );
  }
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('迁移把新列加上了', () => {
  const cols = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  for (const c of ['billing_day', 'traffic_offset', 'traffic_offset_cycle']) {
    assert.ok(cols.includes(c), `缺少列 ${c}`);
  }
});

test('自然月：统计整个 8 月', () => {
  // 默认 billing_day=0，8 月全部 4 天都算进来
  assert.equal(store.measuredCycleTraffic('n1'), 37 * GB);
});

test('账单日 21 号：只统计 8/21 起的部分', () => {
  store.updateNode('n1', { billingDay: 21 });
  // 8/18 和 8/20 属于上一周期，应该被排除
  assert.equal(store.measuredCycleTraffic('n1'), 25 * GB);
});

test('校准：存的是差额，不是绝对值', () => {
  store.updateNode('n1', { trafficUsedActual: 800 * GB });

  const row = db.prepare('SELECT traffic_offset, traffic_offset_cycle FROM nodes WHERE id=?').get(
    'n1',
  ) as { traffic_offset: number; traffic_offset_cycle: string };

  assert.equal(row.traffic_offset, 775 * GB, '差额应为 800 − 25');
  assert.equal(row.traffic_offset_cycle, '2026-08-21', '差额要挂在当前周期上');
  assert.equal(store.currentCycleTraffic('n1'), 800 * GB);
});

test('校准之后新增的流量照常累加', () => {
  db.prepare('INSERT INTO daily_traffic (node_id, day, rx, tx) VALUES (?,?,?,?)').run(
    'n1',
    '2026-08-23',
    3 * GB,
    0,
  );
  // 差额不变，实测涨了 3 → 总量 803
  assert.equal(store.currentCycleTraffic('n1'), 803 * GB);
});

test('进入新周期后校准自动失效', () => {
  // 把差额挂到一个早已过去的周期上，模拟"周期已翻页"
  db.prepare("UPDATE nodes SET traffic_offset_cycle='2026-07-21' WHERE id='n1'").run();
  assert.equal(store.currentCycleTraffic('n1'), 28 * GB, '过期的差额不该再计入');
});

test('撤销校准', () => {
  store.updateNode('n1', { trafficUsedActual: 500 * GB });
  assert.equal(store.currentCycleTraffic('n1'), 500 * GB);

  store.updateNode('n1', { trafficUsedActual: null });
  const row = db.prepare('SELECT traffic_offset, traffic_offset_cycle FROM nodes WHERE id=?').get(
    'n1',
  ) as { traffic_offset: number; traffic_offset_cycle: string };
  assert.equal(row.traffic_offset, 0);
  assert.equal(row.traffic_offset_cycle, '');
  assert.equal(store.currentCycleTraffic('n1'), 28 * GB);
});

test('同时改账单日和校准：差额要按新周期算', () => {
  // 改回自然月的同时校准。若实现顺序错了（先按旧周期 21 号的 28GB 去减），
  // 差额会算成 100−28；正确的是按新周期（整个 8 月 40GB）算 100−40
  store.updateNode('n1', { billingDay: 0, trafficUsedActual: 100 * GB });

  const row = db.prepare('SELECT traffic_offset FROM nodes WHERE id=?').get('n1') as {
    traffic_offset: number;
  };
  assert.equal(row.traffic_offset, 60 * GB, '应按改完之后的周期算差额');
  assert.equal(store.currentCycleTraffic('n1'), 100 * GB);
});

test('校准值小于实测时不会出现负数总量', () => {
  store.updateNode('n1', { trafficUsedActual: 0 });
  assert.equal(store.currentCycleTraffic('n1'), 0);
  assert.ok(store.currentCycleTraffic('n1') >= 0);
});

test('节点状态里带上周期起止', () => {
  const n = store.getNodeState('n1');
  assert.ok(n);
  assert.equal(n.cycleStart, '2026-08-01');
  assert.equal(n.cycleEnd, '2026-09-01');
  assert.equal(n.billingDay, 0);
});
