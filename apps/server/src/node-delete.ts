import { db, NODE_OWNED_TABLES } from './db.js';
import { forgetAgentNode } from './agent-ingest.js';
import { pendingCount } from './commands.js';
import { getSettings } from './settings.js';
import { markDeleted } from './tombstones.js';

/**
 * 删除机器
 *
 * 难的不是删，是删干净、删了不回来、删得明白：
 *
 *   干净 —— 十张表里挂着这台机器的行要一起走，漏一张就是一批永远查不到主人、
 *           也永远不会被清理的孤儿。内存里的累计值缓存也要清，否则同一个标识
 *           日后重新接入，第一拍会被旧值污染。
 *
 *   不回来 —— agent 的注册是"没有就新建"，删完不立墓碑，那台机器下次重启就回来了。
 *
 *   明白 —— 有些东西面板删不掉：封禁还在机器的防火墙里，面板装上去的公钥还在
 *           authorized_keys 里。删完之后面板再也管不到它们，所以必须在删之前
 *           让人看见，见 deletionImpact。
 */

export class NodeDeleteError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'NodeDeleteError';
  }
}

/** 一条可能还留在机器上的 SSH 授权 */
export interface LiveGrant {
  id: string;
  ownerName: string;
  keyLabel: string;
  fingerprint: string;
  remoteUser: string;
  /** pending = 命令发出去了、实况里还没看到；active = 实况确认在机器上 */
  state: 'pending' | 'active';
  expiresAt: number;
}

/** 一条还在机器防火墙里生效的封禁 */
export interface ActiveBlock {
  id: string;
  target: string;
  /** 0 = 永久。永久封禁删机器之后就再也没有人能解开了 */
  expiresAt: number;
}

export interface DeletionImpact {
  id: string;
  name: string;
  source: 'agent' | 'sim';
  createdAt: number;
  /** 采集端最近一次上报；模拟机器恒为 0 */
  lastReport: number;
  /**
   * 采集端此刻还在上报。
   *
   * 删掉之后它不会自己停，只会一直被拒绝 —— 得有人去机器上把它停掉。
   */
  agentActive: boolean;
  /** 会被清掉的历史 */
  history: {
    metricSamples: number;
    trafficDays: number;
    /** 流量账本最早的一天。账本是唯一能回答"去年这个月用了多少"的数据 */
    firstTrafficDay: string | null;
    attributionRows: number;
    trafficRules: number;
    /** 还没被 agent 取走或还没回执的指令，删掉就不会再执行了 */
    pendingCommands: number;
  };
  /** 删掉之后留在机器防火墙里、面板再也解不开的封禁 */
  activeBlocks: ActiveBlock[];
  /** 删掉之后可能留在机器上、面板再也不会对账的公钥 */
  liveGrants: LiveGrant[];
}

function count(sql: string, id: string): number {
  return Number((db.prepare(sql).get(id) as { n: number }).n);
}

/**
 * 删除前的影响评估：会失去什么，会留下什么。
 *
 * 删除对话框靠它说话，deleteNode 也靠它决定要不要拦 —— 两边用同一份口径，
 * 不会出现"对话框说没有残留授权、服务端却拒绝"的对不上。
 */
export function deletionImpact(id: string, now = Date.now()): DeletionImpact | null {
  const node = db
    .prepare('SELECT id, name, source, created_at, agent_last_report FROM nodes WHERE id=?')
    .get(id) as
    | { id: string; name: string; source: string; created_at: number; agent_last_report: number }
    | undefined;
  if (!node) return null;

  const source = node.source === 'agent' ? 'agent' : 'sim';
  const lastReport = source === 'agent' ? Number(node.agent_last_report ?? 0) : 0;

  const traffic = db
    .prepare('SELECT COUNT(*) AS n, MIN(day) AS first FROM daily_traffic WHERE node_id=?')
    .get(id) as { n: number; first: string | null };

  /*
   * 只有 enforced 模式的规则才会变成 active —— dry-run 从没碰过防火墙，不算残留。
   * 过期但还没被定时任务扫到的也排除：nftables 的元素带 timeout，内核已经摘掉了。
   */
  const activeBlocks = (
    db
      .prepare(`
        SELECT id, target, expires_at FROM block_rules
        WHERE node_id = ? AND state = 'active' AND (expires_at = 0 OR expires_at > ?)
        ORDER BY created_at DESC
      `)
      .all(id, now) as Array<{ id: string; target: string; expires_at: number }>
  ).map((r) => ({ id: r.id, target: r.target, expiresAt: Number(r.expires_at) }));

  /*
   * "可能还留在机器上"的口径：
   *   - 已批准 —— 待审批和被驳回的从没下发过
   *   - pending 或 active —— pending 是命令发出去了、实况里还没看到。人可能已经
   *     执行了，只是机器离线没报上来，按"在"算才不会漏
   *   - 没过期 —— 过期的那把 sshd 自己会拒（expiry-time），agent 也会本地摘掉
   * drifted（面板有、机器上已经没了）和 failed（下发失败）不算。
   */
  const liveGrants = (
    db
      .prepare(`
        SELECT g.id, g.remote_user, g.state, g.expires_at,
               k.label AS key_label, k.fingerprint, u.name AS owner_name
        FROM ssh_grants g
        JOIN ssh_keys k ON k.id = g.key_id
        LEFT JOIN users u ON u.id = k.owner_user_id
        WHERE g.node_id = ?
          AND g.request_state = 'approved'
          AND g.state IN ('pending', 'active')
          AND (g.expires_at = 0 OR g.expires_at > ?)
        ORDER BY g.granted_at DESC
      `)
      .all(id, now) as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id as string,
    ownerName: (r.owner_name as string) ?? '',
    keyLabel: (r.key_label as string) ?? '',
    fingerprint: (r.fingerprint as string) ?? '',
    remoteUser: r.remote_user as string,
    state: r.state as LiveGrant['state'],
    expiresAt: Number(r.expires_at ?? 0),
  }));

  return {
    id: node.id,
    name: node.name,
    source,
    createdAt: Number(node.created_at ?? 0),
    lastReport,
    // 和概览上的在线判定用同一条线，否则会出现"卡片显示离线、删除时却说它还在报"
    agentActive: source === 'agent' && now - lastReport < getSettings().offlineAfterSeconds * 1000,
    history: {
      metricSamples: count('SELECT COUNT(*) AS n FROM metrics WHERE node_id=?', id),
      trafficDays: Number(traffic.n),
      firstTrafficDay: traffic.first ?? null,
      attributionRows:
        count('SELECT COUNT(*) AS n FROM service_traffic WHERE node_id=?', id) +
        count('SELECT COUNT(*) AS n FROM peer_traffic WHERE node_id=?', id),
      trafficRules: count('SELECT COUNT(*) AS n FROM traffic_rules WHERE node_id=?', id),
      pendingCommands: pendingCount(id),
    },
    activeBlocks,
    liveGrants,
  };
}

export interface DeletionResult {
  /** 删除前一刻的快照。审计要据此记下删掉了什么、留下了什么 */
  impact: DeletionImpact;
  /** 每张表实际删掉的行数 */
  rows: Record<string, number>;
  /** 有没有立墓碑。模拟机器不需要 —— 模拟器不走注册 */
  tombstoned: boolean;
}

/**
 * 删除一台机器。
 *
 * 全程同步：评估、校验、删除之间没有 await，Node 单线程下不会有别的请求
 * 插进来改变刚评估过的状态。
 */
export function deleteNode(
  id: string,
  opts: { operator: string; acknowledgeGrants?: boolean },
  now = Date.now(),
): DeletionResult {
  const impact = deletionImpact(id, now);
  if (!impact) throw new NodeDeleteError('机器不存在', 404);

  /*
   * 还有可能留在机器上的公钥时，要调用方显式确认。
   *
   * 删公钥的规矩是"有生效授权就拒绝，先撤销"（见 ssh-store 的 deleteKey）。
   * 删机器不能照搬：撤销要等实况确认，撤销前的预检也要求实况新鲜，而一台已经被
   * 服务商回收的机器永远不会再上报 —— 硬拒绝等于它永远删不掉。
   *
   * 所以这里退一步，但只退到"确认"为止：不能让人在不知情的情况下，
   * 把一把钥匙的来历连同机器一起抹掉。授权明细会完整写进审计，来历仍然查得到。
   */
  if (impact.liveGrants.length > 0 && !opts.acknowledgeGrants) {
    throw new NodeDeleteError(
      `这台机器上可能还留着 ${impact.liveGrants.length} 把面板装上去的公钥。` +
        '机器还在的话先去撤销；机器已经不在了，确认后再删',
      409,
    );
  }

  const rows: Record<string, number> = {};
  const tombstoned = impact.source === 'agent';

  db.exec('BEGIN');
  try {
    for (const table of NODE_OWNED_TABLES) {
      rows[table] = Number(db.prepare(`DELETE FROM ${table} WHERE node_id = ?`).run(id).changes ?? 0);
    }
    db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    if (tombstoned) markDeleted({ id, name: impact.name, deletedBy: opts.operator, at: now });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  forgetAgentNode(id);
  return { impact, rows, tombstoned };
}
