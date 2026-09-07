import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = process.env.SONAR_DB ?? resolve(process.cwd(), 'data/sonar.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA synchronous = NORMAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

/*
 * 归因口径的一次性迁移，必须跑在建表之前。
 *
 * 0.1.0 的 service_traffic / peer_traffic 存的是 conntrack 的**瞬时快照**：
 * agent 每拍报一次当前活跃连接的累计字节，面板整天覆盖写。conntrack 条目
 * 在连接关闭后就过期消失，所以那两张表回答的始终是"此刻谁连着"，
 * 而人问的是"这段时间谁把流量吃掉了"。
 *
 * 实测一台生产机：近 7 天归因合计 11.03 GB，同期实际走了 278.45 GB —— 覆盖率 4%。
 * 跨天把这些快照 SUM 起来，得到的是几个互不相关的瞬间之和，没有物理意义。
 *
 * 新版 agent 改报增量、面板改成累加，两种口径的行会长得一模一样却不能相加，
 * 所以旧数据在这里清掉。留着只会让图表前低后高得莫名其妙，而它本来
 * 也没有可回溯的价值。
 */
function migrateAttributionToCumulative(): void {
  const cols = db.prepare(`PRAGMA table_info(peer_traffic)`).all() as Array<{ name: string }>;
  // 空数组 = 全新的库，没有要迁的东西
  if (cols.length === 0 || cols.some((c) => c.name === 'day')) return;

  db.exec('BEGIN');
  try {
    // peer_traffic 的主键要从 (node_id, ip) 变成 (node_id, day, ip)。
    // SQLite 改不了主键，只能重建 —— 反正里面全是要丢的快照。
    db.exec('DROP TABLE IF EXISTS peer_traffic');
    db.exec('DELETE FROM service_traffic');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
migrateAttributionToCumulative();

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

/*
 * 对端流量按天分桶。
 *
 * 原先主键是 (node_id, ip)，每次上报整表覆盖 —— 那张表回答的是"此刻谁连着"，
 * 而人想问的是"这段时间谁把流量吃掉了"。没有 day 维度就没法按区间查，
 * 也没法按保留期清理，只能永远显示最后一拍的快照。
 */
CREATE TABLE IF NOT EXISTS peer_traffic (
  node_id       TEXT NOT NULL,
  day           TEXT NOT NULL,
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
  PRIMARY KEY (node_id, day, ip)
) WITHOUT ROWID;

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

/*
 * 角色表。
 *
 * 角色原先是 permissions.ts 里的一个 Record 常量 —— 加一个角色要改代码、
 * 重新构建、重新部署，而"给这批人一个只能看流量不能看 IP 的身份"是运行期
 * 才会冒出来的需求，不该是发版才能满足的事。
 *
 * 但**能力点仍然是代码常量**，只有角色到能力的映射挪进了库。原因是能力点
 * 一一对应路由上的 requireCap：凭空造一个 'node:destroy' 存进来，没有任何
 * 代码会读它，它只是一行让人误以为有效的配置。
 *
 * id 直接沿用旧的角色字符串（admin/operator/viewer/guest/anonymous），
 * 于是 users.role 原地变成外键，历史数据一行都不用迁。
 */
CREATE TABLE IF NOT EXISTS roles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  -- 系统角色：不可删除、id 不可改。admin/anonymous 另有更强的约束，见 roles.ts
  system       INTEGER NOT NULL DEFAULT 0,
  -- 能力集锁定：admin 恒等于全部能力，锁住避免把自己关在门外
  locked       INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 100,
  created_at   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);

/*
 * 身份表：一个人可以有多种登录方式。
 *
 * 原先身份和用户是一张表 —— users.kind 决定你是 github 用户还是访客，
 * users.github_id 是唯一的外部标识。这个结构里"同一个人既能用密码登录、
 * 又绑着 GitHub"根本表达不出来，因为一行只放得下一个 github_id。
 *
 * provider_uid 的含义随 provider 而变：password 存用户名，github 存数字 id。
 * secret 只有 password 用（scrypt 哈希），github 那行恒为空 —— OAuth 的凭据
 * 在 GitHub 手里，我们这儿不该有任何可复用的东西。
 */
CREATE TABLE IF NOT EXISTS identities (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  provider_uid TEXT NOT NULL,
  secret       TEXT NOT NULL DEFAULT '',
  meta         TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identities_uid ON identities(provider, provider_uid);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

/*
 * ——————————————————————————————————————————————
 * SSH 管理
 * ——————————————————————————————————————————————
 *
 * 三张主表分别回答三个问题：我有哪些钥匙、哪把钥匙开哪台机器、这台机器怎么连。
 * 第四张（ssh_observed_keys）存的是 agent 从机器上扫回来的**实况**，
 * 和前三张的"面板记录"分开放 —— 两者的差异才是这套东西最有价值的部分。
 */

/** 我的钥匙。公钥原文要存（生成命令时用），私钥永远不经过面板。 */
CREATE TABLE IF NOT EXISTS ssh_keys (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  key_type      TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  bits          INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'manual',
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL DEFAULT 0,
  disabled      INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

/*
 * 同一把公钥不允许被两个人登记。
 *
 * 允许的话，"这台机器上的这把 key 是谁的"就有两个答案，而这正是出事之后
 * 唯一要回答的问题。谁先登记算谁的，第二个人会看到明确的冲突提示。
 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_ssh_keys_fp ON ssh_keys(fingerprint);
CREATE INDEX IF NOT EXISTS idx_ssh_keys_owner ON ssh_keys(owner_user_id);

/** 授权：谁的哪把钥匙，开哪台机器的哪个账号。 */
CREATE TABLE IF NOT EXISTS ssh_grants (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL,
  key_id        TEXT NOT NULL,
  remote_user   TEXT NOT NULL DEFAULT 'root',
  -- pending=命令已生成还没看到落地, active=实况里确认存在, drifted=面板有机器上没有,
  -- revoked=已撤销, failed=下发失败
  state         TEXT NOT NULL DEFAULT 'pending',
  -- 审批流。关掉审批时直接是 approved
  request_state TEXT NOT NULL DEFAULT 'approved',
  expires_at    INTEGER NOT NULL DEFAULT 0,
  -- command=人工粘贴, agent=经 agent 远程下发
  method        TEXT NOT NULL DEFAULT 'command',
  requested_by  TEXT NOT NULL DEFAULT '',
  granted_by    TEXT NOT NULL DEFAULT '',
  granted_at    INTEGER NOT NULL DEFAULT 0,
  approved_by   TEXT NOT NULL DEFAULT '',
  approved_at   INTEGER NOT NULL DEFAULT 0,
  reject_reason TEXT NOT NULL DEFAULT '',
  -- 机器实况里第一次看到它的时刻。**只有它才算真的生效**，见 store 里的对账逻辑
  applied_at    INTEGER NOT NULL DEFAULT 0,
  revoked_by    TEXT NOT NULL DEFAULT '',
  revoked_at    INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (key_id) REFERENCES ssh_keys(id) ON DELETE CASCADE
);

/*
 * 一把钥匙对一台机器的一个账号，只能有一条有效授权。
 *
 * 部分索引把已撤销的排除在外 —— 否则"授权、撤销、再授权"这个完全正常的
 * 序列会在第三步撞上唯一约束。
 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_ssh_grants_live
  ON ssh_grants(node_id, key_id, remote_user) WHERE state != 'revoked';
CREATE INDEX IF NOT EXISTS idx_ssh_grants_node ON ssh_grants(node_id, state);
CREATE INDEX IF NOT EXISTS idx_ssh_grants_key ON ssh_grants(key_id);

/** 怎么连：别名、地址、端口、跳板，以及 agent 上报的 sshd 实况。 */
CREATE TABLE IF NOT EXISTS ssh_endpoints (
  node_id           TEXT PRIMARY KEY,
  alias             TEXT NOT NULL,
  -- 留空则回落到 nodes.ip。见 store 里的说明：出口 IP 不等于入口地址
  hostname          TEXT NOT NULL DEFAULT '',
  port              INTEGER NOT NULL DEFAULT 22,
  default_user      TEXT NOT NULL DEFAULT 'root',
  proxy_jump        TEXT NOT NULL DEFAULT '',
  identity_file     TEXT NOT NULL DEFAULT '',
  -- —— 以下由 agent 上报，人改不了
  host_keys         TEXT NOT NULL DEFAULT '[]',
  sshd_version      TEXT NOT NULL DEFAULT '',
  sshd_port         INTEGER NOT NULL DEFAULT 0,
  password_auth     INTEGER NOT NULL DEFAULT -1,
  permit_root_login TEXT NOT NULL DEFAULT '',
  observed_at       INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ssh_endpoints_alias ON ssh_endpoints(alias);

/*
 * 机器实况：agent 扫出来的 authorized_keys。
 *
 * **只存指纹，不存公钥原文。** 公钥本身不是秘密，但"哪些公钥能进哪些机器"
 * 的完整地图对定向攻击极有价值 —— 面板被拖库时，指纹足够做对账和展示，
 * 却不足以复原出可用的公钥。
 */
CREATE TABLE IF NOT EXISTS ssh_observed_keys (
  node_id     TEXT NOT NULL,
  remote_user TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  key_type    TEXT NOT NULL DEFAULT '',
  comment     TEXT NOT NULL DEFAULT '',
  -- 带 sonar: 前缀的才是我们装的，删除时只认这个
  managed     INTEGER NOT NULL DEFAULT 0,
  options     TEXT NOT NULL DEFAULT '',
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (node_id, remote_user, fingerprint)
) WITHOUT ROWID;

/*
 * 面板下发给 agent 的指令队列。
 *
 * 封禁那条链路一直是"agent 侧写好了、面板从没真发过"（index.ts 里
 * 那句 return { ok: true, commands: [] }）。SSH 远程下发要用它，所以在这里补齐，
 * 顺带把封禁也接上。
 *
 * payload 存结构化参数而不是命令字符串 —— agent 拿到参数自己构造操作，
 * 一个字都不看面板给的展示文本。面板被攻破也没法借此在机器上执行任意代码。
 */
CREATE TABLE IF NOT EXISTS agent_commands (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  -- 仅供展示与存档，agent 不执行它
  preview     TEXT NOT NULL DEFAULT '[]',
  state       TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  claimed_at  INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER NOT NULL DEFAULT 0,
  result      TEXT NOT NULL DEFAULT '',
  operator    TEXT NOT NULL DEFAULT '',
  -- 关联的业务对象（如 ssh_grants.id），回执时用它更新对应状态
  ref_id      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_agent_commands_pending ON agent_commands(node_id, state);

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

// —— 用户：密码登录与超级管理员

/*
 * 登录用户名。密码身份的 provider_uid 也是它，两处保持一致由 identities.ts 保证。
 *
 * 单独在 users 上留一列而不是每次去 join identities：用户列表、审计、在线列表
 * 都要显示它，join 一次能省，join 二十次就是无谓的复杂度。
 */
addColumnIfMissing('users', 'username', "TEXT NOT NULL DEFAULT ''");

/*
 * 超级管理员。
 *
 * "第一个 GitHub 登录者自动成为管理员"解决了冷启动，但没解决"这个面板永远
 * 有人管得住"—— admin 之间可以互相降权，最后一个 admin 的保护也只在
 * activeAdminCount() 这一处，绕过它的路径（删除用户、改角色能力集）一多就漏。
 *
 * is_root 是一个不依赖计数的锚点：它不可删除、不可停用、不可降权、
 * 角色恒为 admin。面板可以没有其他任何人，但一定有它。
 */
addColumnIfMissing('users', 'is_root', 'INTEGER NOT NULL DEFAULT 0');

/** 初始密码是系统生成的，第一次登录必须换掉才能用面板。 */
addColumnIfMissing('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username != ''`);

/*
 * kind 的语义调整：'github' → 'user'。
 *
 * 拆出 identities 之后，"用什么方式登录"不再是用户的属性 —— 同一个人可以
 * 既有密码又绑着 GitHub，kind='github' 就自相矛盾了。剩下的真实区别只有
 * "正式用户"和"临时访客"：后者会话短、自动创建、不能绑身份。
 */
db.exec(`UPDATE users SET kind='user' WHERE kind='github'`);

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
 * 清理过期的流量归因明细。
 *
 * 归因改成累加之后这两张表只增不减：每台机器每天最多 60 个服务 + 200 个对端，
 * 十台机器一年就是近百万行。而 daily_traffic **不在这里清** —— 它每机每天
 * 只有一行，却是唯一能回答"去年这个月用了多少"的账本，删掉换不来什么空间。
 *
 * retainDays 传 0 表示永久保留。
 */
export function pruneTrafficDetail(retainDays: number): number {
  if (!Number.isFinite(retainDays) || retainDays <= 0) return 0;
  // 按天字符串比较即可，两张表的 day 都是 YYYY-MM-DD
  const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString().slice(0, 10);
  let rows = 0;
  for (const table of ['service_traffic', 'peer_traffic']) {
    const res = db.prepare(`DELETE FROM ${table} WHERE day < ?`).run(cutoff);
    rows += Number(res.changes ?? 0);
  }
  return rows;
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
