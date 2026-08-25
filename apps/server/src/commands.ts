import { randomUUID } from 'node:crypto';
import { db } from './db.js';

/**
 * 面板 → agent 的指令队列
 *
 * 这条通道以前是空的：`/api/agent/report` 一直 `return { ok: true, commands: [] }`，
 * 封禁的执行代码 agent 侧写好了，面板从没真发过。SSH 远程下发需要它，所以在这里补齐。
 *
 * ——————————————————————————————————————————————
 *
 * 这是整个面板唯一一处"远程改变机器状态"的能力，所以有四条硬规矩：
 *
 * 1. **payload 是结构化参数，不是命令字符串。** agent 拿到参数自己构造操作，
 *    preview 里那些命令文本只用于展示和存档，agent 一个字都不看。
 *    面板一旦被攻破，也没法借下发在机器上执行任意代码。
 *
 * 2. **只发给完成了密钥升级的 agent。** 共享的 SONAR_AGENT_TOKEN 在每台机器上
 *    都能读到，拿它既能拉取别的机器的待办指令，也能冒充别的机器发回执 ——
 *    后者尤其恶劣，它会让面板显示一个虚假的"已撤销"。见 agent-ingest 的 secret 校验。
 *
 * 3. **失败要能终止。** 一条指令连续失败到上限就进 failed 并停止重发。
 *    自动化最危险的不是做错事，是不停地做错事。
 *
 * 4. **状态由实况决定，不由回执决定。** ack 说"删掉了"只更新这条指令自己的状态；
 *    业务对象（如 ssh_grants）要等下一拍实况上报才改，见 ssh-store 的 reconcileGrants。
 */

/** 单条指令最多试几次。超了就停手，交给人。 */
export const MAX_ATTEMPTS = 3;

/** 领走之后多久没回执就算超时，可以重新下发。取 agent 上报间隔的十几倍。 */
const CLAIM_TIMEOUT_MS = 60_000;

export type CommandKind = 'ssh_grant' | 'ssh_revoke' | 'block' | 'unblock';
export type CommandState = 'pending' | 'sent' | 'done' | 'failed';

export interface AgentCommand {
  id: string;
  nodeId: string;
  kind: CommandKind;
  payload: Record<string, unknown>;
  preview: string[];
  state: CommandState;
  attempts: number;
  createdAt: number;
  finishedAt: number;
  result: string;
  operator: string;
  refId: string;
}

function rowToCommand(r: Record<string, unknown>): AgentCommand {
  return {
    id: r.id as string,
    nodeId: r.node_id as string,
    kind: r.kind as CommandKind,
    payload: safeJson(r.payload as string, {}),
    preview: safeJson(r.preview as string, []),
    state: r.state as CommandState,
    attempts: Number(r.attempts ?? 0),
    createdAt: Number(r.created_at ?? 0),
    finishedAt: Number(r.finished_at ?? 0),
    result: (r.result as string) ?? '',
    operator: (r.operator as string) ?? '',
    refId: (r.ref_id as string) ?? '',
  };
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw || '') as T;
  } catch {
    return fallback;
  }
}

export function enqueue(input: {
  nodeId: string;
  kind: CommandKind;
  payload: Record<string, unknown>;
  preview: string[];
  operator: string;
  refId?: string;
}): AgentCommand {
  const id = `c:${randomUUID()}`;
  db.prepare(`
    INSERT INTO agent_commands (id,node_id,kind,payload,preview,state,created_at,operator,ref_id)
    VALUES (?,?,?,?,?,'pending',?,?,?)
  `).run(
    id,
    input.nodeId,
    input.kind,
    JSON.stringify(input.payload),
    JSON.stringify(input.preview),
    Date.now(),
    input.operator,
    input.refId ?? '',
  );
  return getCommand(id)!;
}

export function getCommand(id: string): AgentCommand | null {
  const r = db.prepare('SELECT * FROM agent_commands WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToCommand(r) : null;
}

/**
 * 取出该机器的待执行指令，并标记为已下发。
 *
 * 领取和标记必须在同一个事务里 —— agent 上报很频繁（默认 2 秒一次），
 * 中间断开的话同一条指令会被连发好几次。SSH 那两个操作本身是幂等的，
 * 但 attempts 会被虚耗掉，几拍之内就撞上 MAX_ATTEMPTS 被误判成失败。
 */
export function claimFor(nodeId: string, limit = 5): AgentCommand[] {
  const now = Date.now();
  let claimed: AgentCommand[] = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db
      .prepare(`
        SELECT * FROM agent_commands
        WHERE node_id = ? AND (
          state = 'pending'
          -- 领走了却迟迟没有回执：agent 可能在执行中途挂了，超时后重新下发。
          -- 两个操作都是幂等的，重复执行不会有副作用
          OR (state = 'sent' AND claimed_at < ?)
        )
        ORDER BY created_at ASC LIMIT ?
      `)
      .all(nodeId, now - CLAIM_TIMEOUT_MS, limit) as Array<Record<string, unknown>>;

    const mark = db.prepare("UPDATE agent_commands SET state='sent', claimed_at=?, attempts=attempts+1 WHERE id=?");
    const fail = db.prepare("UPDATE agent_commands SET state='failed', finished_at=?, result=? WHERE id=?");

    for (const r of rows) {
      const attempts = Number(r.attempts ?? 0);
      if (attempts >= MAX_ATTEMPTS) {
        // 停手，交给人。不停地重试一条注定失败的指令，只会把审计日志刷满
        fail.run(now, `连续 ${attempts} 次没有成功，已停止重试`, r.id as string);
        continue;
      }
      mark.run(now, r.id as string);
      claimed.push(rowToCommand({ ...r, state: 'sent', attempts: attempts + 1 }));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return claimed;
}

export interface AckInput {
  id: string;
  ok: boolean;
  skipped?: boolean;
  output?: string;
}

/**
 * 记录回执。
 *
 * 返回这条指令，调用方据此去更新业务对象。注意 ok=true **不等于**业务生效了 ——
 * 它只说明 agent 那边没报错。真正的确认要等下一拍的实况上报。
 */
export function ack(nodeId: string, input: AckInput): AgentCommand | null {
  const cmd = getCommand(input.id);
  // 只认自己那台机器的回执：不加这一条，任何一台被攻破的机器都能替别的机器"确认"
  if (!cmd || cmd.nodeId !== nodeId) return null;

  const now = Date.now();
  const output = String(input.output ?? '').slice(0, 2000);

  if (input.ok || input.skipped) {
    db.prepare("UPDATE agent_commands SET state='done', finished_at=?, result=? WHERE id=?")
      .run(now, output, input.id);
  } else if (cmd.attempts >= MAX_ATTEMPTS) {
    db.prepare("UPDATE agent_commands SET state='failed', finished_at=?, result=? WHERE id=?")
      .run(now, output, input.id);
  } else {
    // 还有重试机会，放回队列
    db.prepare("UPDATE agent_commands SET state='pending', result=? WHERE id=?").run(output, input.id);
  }

  return getCommand(input.id);
}

export function listCommands(nodeId?: string, limit = 100): AgentCommand[] {
  const rows = nodeId
    ? db.prepare('SELECT * FROM agent_commands WHERE node_id=? ORDER BY created_at DESC LIMIT ?').all(nodeId, limit)
    : db.prepare('SELECT * FROM agent_commands ORDER BY created_at DESC LIMIT ?').all(limit);
  return (rows as Array<Record<string, unknown>>).map(rowToCommand);
}

export function pendingCount(nodeId: string): number {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM agent_commands WHERE node_id=? AND state IN ('pending','sent')")
    .get(nodeId) as { n: number };
  return Number(r.n);
}

/** 清掉早就结束的指令，避免这张表无限增长。 */
export function pruneCommands(retainDays = 30): number {
  const cutoff = Date.now() - retainDays * 86_400_000;
  const res = db
    .prepare("DELETE FROM agent_commands WHERE state IN ('done','failed') AND finished_at < ?")
    .run(cutoff);
  return Number(res.changes ?? 0);
}
