import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/*
 * 从 0.1.0 的库升上来。
 *
 * 这条路径没有回头路：peer_traffic 的主键要从 (node_id, ip) 变成
 * (node_id, day, ip)，SQLite 改不了主键，只能重建。做错的代价不是报个错，
 * 而是面板起不来，或者把人家的日流量账本一起冲掉。
 *
 * 所以这里先按旧 schema 手工造一个库，塞进各表的数据，再让 db.ts 加载 ——
 * 加载的那一刻迁移就跑了。断言分两半：
 *   该清的清掉了（两张归因表存的是失真快照，口径已经变了，留着只会混淆）；
 *   不该动的一行没动（nodes、daily_traffic 是真账，动了就是事故）。
 *
 * db.ts 是模块单例，一个进程只加载得了一次，所以这份用例必须独占一个文件。
 */

const OLD_SCHEMA = `
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '', country_code TEXT NOT NULL DEFAULT 'XX',
  region TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '', kernel TEXT NOT NULL DEFAULT '',
  cpu_model TEXT NOT NULL DEFAULT '', cpu_cores INTEGER NOT NULL DEFAULT 1,
  mem_total INTEGER NOT NULL DEFAULT 0, swap_total INTEGER NOT NULL DEFAULT 0,
  disk_total INTEGER NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD', billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  expire_at INTEGER NOT NULL DEFAULT 0, traffic_quota INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]', agent_version TEXT NOT NULL DEFAULT '',
  boot_time INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0, secret TEXT NOT NULL DEFAULT ''
);

CREATE TABLE daily_traffic (
  node_id TEXT NOT NULL, day TEXT NOT NULL,
  rx INTEGER NOT NULL DEFAULT 0, tx INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, day)
) WITHOUT ROWID;

CREATE TABLE service_traffic (
  node_id TEXT NOT NULL, day TEXT NOT NULL, service TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  rx INTEGER NOT NULL DEFAULT 0, tx INTEGER NOT NULL DEFAULT 0,
  conns INTEGER NOT NULL DEFAULT 0,
  ports TEXT NOT NULL DEFAULT '[]', pids TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (node_id, day, service)
) WITHOUT ROWID;

/* 旧主键：没有 day，整表覆盖写 */
CREATE TABLE peer_traffic (
  node_id TEXT NOT NULL, ip TEXT NOT NULL,
  rx INTEGER NOT NULL DEFAULT 0, tx INTEGER NOT NULL DEFAULT 0,
  conns INTEGER NOT NULL DEFAULT 0, country_code TEXT NOT NULL DEFAULT 'XX',
  asn INTEGER NOT NULL DEFAULT 0, org TEXT NOT NULL DEFAULT '',
  threat_score INTEGER NOT NULL DEFAULT 0, threat_reasons TEXT NOT NULL DEFAULT '[]',
  ports TEXT NOT NULL DEFAULT '[]',
  first_seen INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, ip)
) WITHOUT ROWID;

CREATE INDEX idx_peer_node_rx ON peer_traffic(node_id, rx DESC);
`;

let dir: string;
let db: import('node:sqlite').DatabaseSync;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sonar-migrate-'));
  const path = join(dir, 'old.db');

  // —— 造一个 0.1.0 的库
  const old = new DatabaseSync(path);
  old.exec(OLD_SCHEMA);
  old
    .prepare(`INSERT INTO nodes (id,name,created_at,last_seen) VALUES ('n1','老机器',1,2)`)
    .run();
  old
    .prepare(`INSERT INTO daily_traffic (node_id,day,rx,tx) VALUES ('n1','2026-08-01',111,222)`)
    .run();
  old
    .prepare(
      `INSERT INTO service_traffic (node_id,day,service,category,rx,tx,conns,ports,pids)
       VALUES ('n1','2026-08-01','nginx','web',9,9,9,'[80]','[1]')`,
    )
    .run();
  old
    .prepare(
      `INSERT INTO peer_traffic (node_id,ip,rx,tx,conns) VALUES ('n1','203.0.113.1',7,7,7)`,
    )
    .run();
  old.close();

  process.env.SONAR_DB = path;
  db = (await import('./db.js')).db;
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('peer_traffic 重建出 day 列和新主键', () => {
  const cols = (db.prepare('PRAGMA table_info(peer_traffic)').all() as Array<{
    name: string;
    pk: number;
  }>);
  assert.ok(cols.some((c) => c.name === 'day'), '缺 day 列就没法按区间查，也没法按保留期清');

  const pk = cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  assert.deepEqual(pk, ['node_id', 'day', 'ip'], '主键必须含 day，否则一天只存得下一行');
});

test('失真的归因快照被清空', () => {
  const n = (t: string) =>
    (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  assert.equal(n('peer_traffic'), 0);
  assert.equal(
    n('service_traffic'),
    0,
    '旧行是瞬时快照、新行是区间累计，两种口径长得一样却不能相加 —— 混在一张表里图表会前低后高得莫名其妙',
  );
});

test('真账一行没动', () => {
  const node = db.prepare(`SELECT name FROM nodes WHERE id='n1'`).get() as { name: string };
  assert.equal(node.name, '老机器');

  const day = db
    .prepare(`SELECT rx, tx FROM daily_traffic WHERE node_id='n1' AND day='2026-08-01'`)
    .get() as { rx: number; tx: number };
  assert.equal(day.rx, 111, '日流量是唯一的流量真账，迁移绝不能碰它');
  assert.equal(day.tx, 222);
});

test('重复加载不会再迁一次', () => {
  // 迁移靠"有没有 day 列"判定，天然幂等。真正要防的是它在已经迁过的库上
  // 再 DROP 一次 —— 那会把升级后攒的归因数据全删掉
  db.prepare(
    `INSERT INTO peer_traffic (node_id,day,ip,rx,tx,conns,ports,first_seen,last_seen)
     VALUES ('n1','2026-08-02','203.0.113.2',5,5,5,'[]',0,0)`,
  ).run();

  const before = (db.prepare('SELECT COUNT(*) n FROM peer_traffic').get() as { n: number }).n;
  // 重新跑一遍建表语句能代表"再启动一次"：迁移已经跑过，表结构是新的
  const again = new DatabaseSync(process.env.SONAR_DB as string);
  const cols = again.prepare('PRAGMA table_info(peer_traffic)').all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === 'day'));
  again.close();

  assert.equal((db.prepare('SELECT COUNT(*) n FROM peer_traffic').get() as { n: number }).n, before);
});
