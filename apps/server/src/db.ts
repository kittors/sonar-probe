import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = process.env.SONAR_DB ?? resolve(process.cwd(), 'data/sonar.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA synchronous = NORMAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  ip            TEXT NOT NULL,
  country_code  TEXT NOT NULL DEFAULT 'XX',
  region        TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT '',
  os            TEXT NOT NULL DEFAULT '',
  platform      TEXT NOT NULL DEFAULT 'linux',
  arch          TEXT NOT NULL DEFAULT 'amd64',
  kernel        TEXT NOT NULL DEFAULT '',
  cpu_model     TEXT NOT NULL DEFAULT '',
  cpu_cores     INTEGER NOT NULL DEFAULT 1,
  mem_total     INTEGER NOT NULL DEFAULT 0,
  swap_total    INTEGER NOT NULL DEFAULT 0,
  disk_total    INTEGER NOT NULL DEFAULT 0,
  price         REAL NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD',
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  expire_at     INTEGER NOT NULL DEFAULT 0,
  traffic_quota INTEGER NOT NULL DEFAULT 0,
  tags          TEXT NOT NULL DEFAULT '[]',
  agent_version TEXT NOT NULL DEFAULT '',
  boot_time     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0,
  last_seen     INTEGER NOT NULL DEFAULT 0,
  secret        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS metrics (
  node_id      TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  cpu          REAL NOT NULL,
  mem_used     INTEGER NOT NULL,
  swap_used    INTEGER NOT NULL,
  disk_used    INTEGER NOT NULL,
  load1        REAL NOT NULL,
  load5        REAL NOT NULL,
  load15       REAL NOT NULL,
  net_rx       INTEGER NOT NULL,
  net_tx       INTEGER NOT NULL,
  net_rx_total INTEGER NOT NULL,
  net_tx_total INTEGER NOT NULL,
  tcp_conns    INTEGER NOT NULL,
  udp_conns    INTEGER NOT NULL,
  processes    INTEGER NOT NULL,
  uptime       INTEGER NOT NULL,
  temp_c       REAL,
  disk_read    INTEGER NOT NULL DEFAULT 0,
  disk_write   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);

CREATE TABLE IF NOT EXISTS daily_traffic (
  node_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  rx      INTEGER NOT NULL DEFAULT 0,
  tx      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS service_traffic (
  node_id  TEXT NOT NULL,
  day      TEXT NOT NULL,
  service  TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  rx       INTEGER NOT NULL DEFAULT 0,
  tx       INTEGER NOT NULL DEFAULT 0,
  conns    INTEGER NOT NULL DEFAULT 0,
  ports    TEXT NOT NULL DEFAULT '[]',
  pids     TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (node_id, day, service)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS peer_traffic (
  node_id       TEXT NOT NULL,
  ip            TEXT NOT NULL,
  rx            INTEGER NOT NULL DEFAULT 0,
  tx            INTEGER NOT NULL DEFAULT 0,
  conns         INTEGER NOT NULL DEFAULT 0,
  country_code  TEXT NOT NULL DEFAULT 'XX',
  asn           INTEGER NOT NULL DEFAULT 0,
  org           TEXT NOT NULL DEFAULT '',
  threat_score  INTEGER NOT NULL DEFAULT 0,
  threat_reasons TEXT NOT NULL DEFAULT '[]',
  ports         TEXT NOT NULL DEFAULT '[]',
  first_seen    INTEGER NOT NULL DEFAULT 0,
  last_seen     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, ip)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_peer_node_rx ON peer_traffic(node_id, rx DESC);

CREATE TABLE IF NOT EXISTS block_rules (
  id         TEXT PRIMARY KEY,
  node_id    TEXT NOT NULL,
  target     TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  mode       TEXT NOT NULL DEFAULT 'dry-run',
  state      TEXT NOT NULL DEFAULT 'pending',
  commands   TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0,
  operator   TEXT NOT NULL DEFAULT 'console',
  result     TEXT
);

CREATE INDEX IF NOT EXISTS idx_block_node ON block_rules(node_id, state);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'guest',
  github_id   INTEGER,
  login       TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  avatar      TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'guest',
  granted     TEXT NOT NULL DEFAULT '[]',
  revoked     TEXT NOT NULL DEFAULT '[]',
  note        TEXT NOT NULL DEFAULT '',
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github ON users(github_id) WHERE github_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT '',
  revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active DESC);

CREATE TABLE IF NOT EXISTS access_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  ts         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_ts ON access_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_access_user ON access_log(user_id, ts DESC);

CREATE TABLE IF NOT EXISTS traffic_rules (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL DEFAULT 'month',
  threshold   INTEGER NOT NULL,
  compare     TEXT NOT NULL DEFAULT 'absolute',
  enabled     INTEGER NOT NULL DEFAULT 1,
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  last_fired  INTEGER NOT NULL DEFAULT 0,
  fire_count  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_traffic_rules_node ON traffic_rules(node_id);

CREATE TABLE IF NOT EXISTS events (
  id      TEXT PRIMARY KEY,
  node_id TEXT,
  level   TEXT NOT NULL DEFAULT 'info',
  kind    TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  ts      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

/*
 * 面板设置与汇率快照。
 *
 * value 存 JSON 而不是一列一个设置项：加设置项比读设置项频繁得多，
 * 每加一个字段就 ALTER 一次表不划算。目前只有两行 —— 'panel' 是设置，
 * 'rates' 是拉回来的汇率缓存。
 */
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
`);

/**
 * 增量加列。
 *
 * SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，重复执行会直接报错中断启动，
 * 所以先查一遍表结构。已部署的库里有数据，不能靠删表重建。
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// 'sim' = 模拟器生成，'agent' = 真实机器上报。
// 模拟器每拍只推进 sim 节点，否则会把 agent 报上来的真实数据覆盖掉。
addColumnIfMissing('nodes', 'source', "TEXT NOT NULL DEFAULT 'sim'");
addColumnIfMissing('nodes', 'agent_last_report', 'INTEGER NOT NULL DEFAULT 0');

// 服务商控制台链接。排查问题时常要跳过去重启实例或看带宽账单，
// 存一个直达地址比每次翻收藏夹快。只接受 http/https，见 store.ts 的 sanitizeUrl。
addColumnIfMissing('nodes', 'panel_url', "TEXT NOT NULL DEFAULT ''");

// 流量周期的起始日（1-31）。很多 VPS 的额度是从开通日算的，不是每月 1 号。
// 0 表示按自然月。
addColumnIfMissing('nodes', 'billing_day', 'INTEGER NOT NULL DEFAULT 0');

/*
 * 流量校准。
 *
 * 探针总是中途才装上的，装之前那段流量库里根本没有对应的行 —— 不是记成 0，
 * 是压根不存在，所以面板的"已用"永远比服务商账单小一截。
 *
 * 这里存的是**差额**而不是"已用量"：已用量每秒都在变，存下来第二天就废了；
 * 存差额则后续增长照常实时累加。offset_cycle 记下这个差额属于哪个周期
 * （周期起始日的 YYYY-MM-DD），进入新周期后它自然失效，不需要定时任务清零。
 */
addColumnIfMissing('nodes', 'traffic_offset', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('nodes', 'traffic_offset_cycle', "TEXT NOT NULL DEFAULT ''");

/**
 * 清掉模拟器生成的所有数据。
 *
 * 模拟器一旦关闭，那 12 台虚构机器就是纯粹的垃圾 —— 留在真实部署的面板上
 * 只会让人分不清哪台是真的。只删 source='sim' 的，agent 上报的数据一条不动。
 */
export function purgeSimulatedData(): { nodes: number; rows: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  const done = db.prepare("SELECT value FROM meta WHERE key='sim_purged_at'").get() as
    | { value: string }
    | undefined;

  const simIds = (db.prepare("SELECT id FROM nodes WHERE source='sim'").all() as Array<{
    id: string;
  }>).map((r) => r.id);

  // 清过一次且没有新的模拟节点就不用再来。
  // 但只判断 simIds 为空是不够的 —— 上一轮可能已经把节点删了却漏掉事件，
  // 那时提前 return 会让假告警永远留在事件流里。
  if (simIds.length === 0 && done) return { nodes: 0, rows: 0 };

  const placeholders = simIds.length > 0 ? simIds.map(() => '?').join(',') : "''";
  let rows = 0;

  db.exec('BEGIN');
  try {
    for (const table of [
      'metrics',
      'daily_traffic',
      'service_traffic',
      'peer_traffic',
      'block_rules',
    ]) {
      const res = db
        .prepare(`DELETE FROM ${table} WHERE node_id IN (${placeholders})`)
        .run(...(simIds as never[]));
      rows += Number(res.changes ?? 0);
    }
    // 事件表整个清空，不只是删模拟节点的那些。
    // 模拟器运行期间会随机挑节点编造告警，真实机器也会被编进去 ——
    // 「香港 出站带宽触顶」这种事件从来没发生过，留着比没有更糟。
    const evRes = db.prepare('DELETE FROM events').run();
    rows += Number(evRes.changes ?? 0);

    if (simIds.length > 0) {
      db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...(simIds as never[]));
    }
    db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('sim_purged_at',?)").run(
      String(Date.now()),
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { nodes: simIds.length, rows };
}

/**
 * 只保留最近 N 小时的高频采样，避免库无限膨胀。
 *
 * 保留时长由面板设置决定（settings.metricRetentionHours），调用方负责传进来 ——
 * 这个模块被 settings.ts 依赖，反过来 import 它会成环。
 */
export function pruneMetrics(retainHours = 26): void {
  const cutoff = Date.now() - retainHours * 3600_000;
  db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
}

/**
 * 清理过期的审计日志。
 *
 * 这张表原先只写不清 —— 每次浏览都落一行，一台常看的面板一年能攒下几十万条，
 * 而没有人会去翻半年前谁点开过哪台机器。
 *
 * retainDays 传 0 表示永久保留：合规场景下确实有人需要，那时由他自己去管磁盘。
 */
export function pruneAuditLog(retainDays: number): number {
  if (!Number.isFinite(retainDays) || retainDays <= 0) return 0;
  const cutoff = Date.now() - retainDays * 86_400_000;
  const res = db.prepare('DELETE FROM access_log WHERE ts < ?').run(cutoff);
  return Number(res.changes ?? 0);
}

export function isFreshDatabase(): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number };
  return row.n === 0;
}
