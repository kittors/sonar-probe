import { db } from './db.js';
import { dayKeyIn, getSettings } from './settings.js';

/**
 * 已删除机器的墓碑
 *
 * agent 的注册是"没有就新建"。面板只删 nodes 那一行的话，那台机器上的 agent
 * 下次重启 —— 升级、宕机重启、systemd 把它拉起来 —— 就会把它原样建回来：
 * 换一个新的接入时间、历史清零，看起来就像删除没生效。人多半会以为是面板的 bug，
 * 再删一次，它再回来一次。
 *
 * 所以删除时在这里留一条，注册、上报、回执一律拒绝（路由层回 410）。
 *
 * 墓碑不会自己过期。一台被删的机器什么时候回来都不该被静默收下 ——
 * 想让同一个标识重新接入，得在「接入新机器」里显式解除，那是一次留审计的操作。
 */

export interface Tombstone {
  id: string;
  name: string;
  deletedAt: number;
  deletedBy: string;
  /** 删除之后那台机器的采集端最近一次来敲门的时刻。0 = 一次都没回来过 */
  lastAttempt: number;
}

/**
 * 已删除的机器试图注册或上报。
 *
 * 消息是写给机器上看 journalctl 的那个人的：他多半不记得这台机器在面板上
 * 被删过，得在这一行里同时看到"为什么被拒"和"接下来两条路各怎么走"。
 */
export class NodeDeletedError extends Error {
  constructor(readonly tombstone: Tombstone) {
    const day = dayKeyIn(getSettings().timezone, tombstone.deletedAt);
    super(
      `这台机器（${tombstone.id}）已于 ${day} 从面板删除，上报被拒绝。` +
        '不再需要监控的话，停用采集端：systemctl disable --now sonar-agent；' +
        '要重新接入，先在面板「接入新机器」里输入这个标识，允许它回来',
    );
    this.name = 'NodeDeletedError';
  }
}

function rowToTombstone(r: Record<string, unknown>): Tombstone {
  return {
    id: r.id as string,
    name: (r.name as string) ?? '',
    deletedAt: Number(r.deleted_at ?? 0),
    deletedBy: (r.deleted_by as string) ?? '',
    lastAttempt: Number(r.last_attempt ?? 0),
  };
}

export function deletedNode(id: string): Tombstone | null {
  const r = db.prepare('SELECT * FROM deleted_nodes WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToTombstone(r) : null;
}

export function listDeletedNodes(): Tombstone[] {
  const rows = db.prepare('SELECT * FROM deleted_nodes ORDER BY deleted_at DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToTombstone);
}

/**
 * 立一块墓碑。
 *
 * 由 deleteNode 在它的事务里调用 —— 和清数据必须是同一个原子单元：
 * 数据删了墓碑没立上，机器下一拍就回来了；墓碑立了数据没删，又会留下一批孤儿行。
 *
 * 同一个标识删过、解除、再删，覆盖旧记录并清零来访痕迹：那是一次新的删除。
 */
export function markDeleted(input: { id: string; name: string; deletedBy: string; at: number }): void {
  db.prepare(`
    INSERT INTO deleted_nodes (id, name, deleted_at, deleted_by, last_attempt, warned_at)
    VALUES (?, ?, ?, ?, 0, 0)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by,
      last_attempt = 0, warned_at = 0
  `).run(input.id, input.name, input.at, input.deletedBy);
}

/**
 * 解除墓碑，允许这个标识重新接入。
 *
 * 只是撤掉拦截，不恢复任何数据 —— 删除时它们已经清掉了。重新接入的机器
 * 从零开始累计，和一台新机器没有区别。
 */
export function allowReenroll(id: string): Tombstone | null {
  const tomb = deletedNode(id);
  if (!tomb) return null;
  db.prepare('DELETE FROM deleted_nodes WHERE id=?').run(id);
  return tomb;
}

/** 来访时刻精确到分钟，足够回答"那台机器上的采集端还在不在跑" */
const ATTEMPT_RESOLUTION_MS = 60_000;
/** 同一台机器一天最多提醒一次。再多就是刷屏，人会学会对整个事件流视而不见 */
const WARN_INTERVAL_MS = 24 * 3600_000;

/**
 * 记一次被拒的来访，返回要不要往事件流里发一条提醒。
 *
 * 老版本 agent 收到 410 也照旧每两秒重试，每次都写库纯属浪费，所以按分钟节流。
 */
export function noteRejectedAttempt(id: string, now = Date.now()): boolean {
  const r = db.prepare('SELECT last_attempt, warned_at FROM deleted_nodes WHERE id=?').get(id) as
    | { last_attempt: number; warned_at: number }
    | undefined;
  if (!r) return false;
  const warn = now - r.warned_at >= WARN_INTERVAL_MS;
  if (warn || now - r.last_attempt >= ATTEMPT_RESOLUTION_MS) {
    db.prepare('UPDATE deleted_nodes SET last_attempt=?, warned_at=? WHERE id=?').run(
      now,
      warn ? now : r.warned_at,
      id,
    );
  }
  return warn;
}
