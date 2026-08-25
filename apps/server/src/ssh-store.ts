import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { getSettings } from './settings.js';
import {
  FACTS_STALE_MS,
  SONAR_TAG,
  fingerprintOf,
  parsePublicKey,
  type HostFacts,
  type ParsedKey,
} from './ssh.js';
import { validateAlias, validateHostname, validateProxyJump } from './ssh-config.js';
import type {
  GrantRequestState,
  GrantState,
  SshDrift,
  SshEndpoint,
  SshGrant,
  SshKey,
} from './types.js';

/**
 * SSH 数据访问
 *
 * 这里最要紧的一段是**对账**：面板记录的授权，和 agent 从机器上扫回来的实况，
 * 两者的差异比任何一边单独看都有价值。
 *
 * 一条原则贯穿始终：**授权的状态只由实况决定，不由"命令发出去了"决定。**
 * agent 回执说"删掉了"不算数，下一拍实况里看不到它了才算数。少了这一条，
 * 面板会显示一个假的"已撤销"，而那把钥匙还在机器上 —— 那比没有这个功能更糟，
 * 因为人会依据一个假状态做安全决策。
 */

export class SshStoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// ————————————————————————————————————————————————————————
// 公钥
// ————————————————————————————————————————————————————————

function rowToKey(r: Record<string, unknown>): SshKey {
  return {
    id: r.id as string,
    ownerUserId: r.owner_user_id as string,
    ownerName: (r.owner_name as string) ?? '',
    label: (r.label as string) ?? '',
    keyType: r.key_type as string,
    publicKey: r.public_key as string,
    fingerprint: r.fingerprint as string,
    bits: Number(r.bits ?? 0),
    source: (r.source as 'manual' | 'github') ?? 'manual',
    createdAt: Number(r.created_at ?? 0),
    lastUsedAt: Number(r.last_used_at ?? 0),
    disabled: Number(r.disabled) === 1,
    grantCount: Number(r.grant_count ?? 0),
  };
}

const KEY_SELECT = `
  SELECT k.*, u.name AS owner_name,
    (SELECT COUNT(*) FROM ssh_grants g WHERE g.key_id = k.id AND g.state != 'revoked') AS grant_count
  FROM ssh_keys k
  LEFT JOIN users u ON u.id = k.owner_user_id
`;

export function listKeys(ownerUserId?: string): SshKey[] {
  const rows = ownerUserId
    ? db.prepare(`${KEY_SELECT} WHERE k.owner_user_id = ? ORDER BY k.created_at DESC`).all(ownerUserId)
    : db.prepare(`${KEY_SELECT} ORDER BY k.created_at DESC`).all();
  return (rows as Array<Record<string, unknown>>).map(rowToKey);
}

export function getKey(id: string): SshKey | null {
  const r = db.prepare(`${KEY_SELECT} WHERE k.id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToKey(r) : null;
}

export function addKey(input: {
  ownerUserId: string;
  publicKey: string;
  label?: string;
  source?: 'manual' | 'github';
}): SshKey {
  const parsed = parsePublicKey(input.publicKey);

  /*
   * 同一把公钥不允许被两个人登记。
   *
   * 允许的话，"机器上这把 key 是谁的"就有两个答案 —— 而那是出事之后
   * 唯一需要回答的问题。库里有唯一索引兜底，这里先查一次是为了给出人话。
   */
  const existing = db
    .prepare('SELECT k.id, k.owner_user_id, u.name FROM ssh_keys k LEFT JOIN users u ON u.id=k.owner_user_id WHERE k.fingerprint = ?')
    .get(parsed.fingerprint) as { id: string; owner_user_id: string; name: string } | undefined;
  if (existing) {
    throw new SshStoreError(
      existing.owner_user_id === input.ownerUserId
        ? '这把公钥你已经登记过了'
        : `这把公钥已经登记在「${existing.name}」名下`,
      409,
    );
  }

  const id = `k:${randomUUID()}`;
  db.prepare(`
    INSERT INTO ssh_keys (id,owner_user_id,label,key_type,public_key,fingerprint,bits,source,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    input.ownerUserId,
    // 标签留空就用公钥自带的注释，那通常正是 user@hostname，比空白有用
    (input.label ?? '').trim().slice(0, 60) || parsed.comment.slice(0, 60) || '未命名',
    parsed.type,
    parsed.normalized,
    parsed.fingerprint,
    parsed.bits,
    input.source ?? 'manual',
    Date.now(),
  );
  return getKey(id)!;
}

export function updateKey(id: string, patch: { label?: string; disabled?: boolean }): SshKey {
  const key = getKey(id);
  if (!key) throw new SshStoreError('公钥不存在', 404);
  db.prepare('UPDATE ssh_keys SET label=?, disabled=? WHERE id=?').run(
    patch.label === undefined ? key.label : String(patch.label).trim().slice(0, 60) || key.label,
    (patch.disabled ?? key.disabled) ? 1 : 0,
    id,
  );
  return getKey(id)!;
}

/**
 * 删除公钥。
 *
 * 还有生效中的授权就拒绝 —— 直接删掉的话，面板这边记录没了，机器上那把钥匙
 * 却还在，从此无人知道它的来历。必须先撤销，那一步会生成撤销命令。
 */
export function deleteKey(id: string): void {
  const key = getKey(id);
  if (!key) throw new SshStoreError('公钥不存在', 404);
  if (key.grantCount > 0) {
    throw new SshStoreError(
      `这把公钥还授权着 ${key.grantCount} 台机器，先撤销那些授权再删 —— 否则机器上会留下一把没人认识的钥匙`,
      409,
    );
  }
  db.prepare('DELETE FROM ssh_keys WHERE id=?').run(id);
}

/** 按指纹找登记在册的钥匙，对账时用来判断"面板认不认识这把"。 */
export function keyByFingerprint(fp: string): SshKey | null {
  const r = db.prepare(`${KEY_SELECT} WHERE k.fingerprint = ?`).get(fp) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToKey(r) : null;
}

// ————————————————————————————————————————————————————————
// 接入方式
// ————————————————————————————————————————————————————————

function rowToEndpoint(r: Record<string, unknown>, now = Date.now()): SshEndpoint {
  const observedAt = Number(r.observed_at ?? 0);
  const pa = Number(r.password_auth ?? -1);
  let hostKeys: Array<{ type: string; blob: string; fingerprint: string }> = [];
  try {
    const raw = JSON.parse((r.host_keys as string) || '[]') as Array<{ type: string; blob: string }>;
    hostKeys = raw.map((k) => ({
      ...k,
      fingerprint: safeFingerprint(k.blob),
    }));
  } catch {
    // 存坏了就当没采到，不该让整个列表接口挂掉
  }

  const hostname = (r.hostname as string) ?? '';
  return {
    nodeId: r.node_id as string,
    nodeName: (r.node_name as string) ?? (r.node_id as string),
    alias: r.alias as string,
    hostname,
    effectiveHostname: hostname || ((r.node_ip as string) ?? ''),
    port: Number(r.port ?? 22),
    defaultUser: (r.default_user as string) ?? 'root',
    proxyJump: (r.proxy_jump as string) ?? '',
    identityFile: (r.identity_file as string) ?? '',
    hostKeys,
    sshdVersion: (r.sshd_version as string) ?? '',
    sshdPort: Number(r.sshd_port ?? 0),
    passwordAuth: pa === -1 ? null : pa === 1,
    permitRootLogin: (r.permit_root_login as string) ?? '',
    observedAt,
    factsStale: observedAt === 0 || now - observedAt > FACTS_STALE_MS,
  };
}

function safeFingerprint(blob: string): string {
  try {
    return fingerprintOf(Buffer.from(blob, 'base64'));
  } catch {
    return '';
  }
}

const ENDPOINT_SELECT = `
  SELECT e.*, n.name AS node_name, n.ip AS node_ip
  FROM ssh_endpoints e
  LEFT JOIN nodes n ON n.id = e.node_id
`;

export function listEndpoints(): SshEndpoint[] {
  const rows = db.prepare(`${ENDPOINT_SELECT} ORDER BY e.alias ASC`).all();
  return (rows as Array<Record<string, unknown>>).map((r) => rowToEndpoint(r));
}

export function getEndpoint(nodeId: string): SshEndpoint | null {
  const r = db.prepare(`${ENDPOINT_SELECT} WHERE e.node_id = ?`).get(nodeId) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToEndpoint(r) : null;
}

/**
 * 第一次给某台机器配 SSH 时建一行。
 *
 * 别名默认取 node.id —— 它已经保证唯一，而且接入机器时就强制过
 * `^[A-Za-z0-9._-]+$`（见 EnrollDialog），正好是合法的 ssh Host 名。
 */
export function ensureEndpoint(nodeId: string): SshEndpoint {
  const existing = getEndpoint(nodeId);
  if (existing) return existing;

  const node = db.prepare('SELECT id FROM nodes WHERE id=?').get(nodeId) as { id: string } | undefined;
  if (!node) throw new SshStoreError('机器不存在', 404);

  // 别名撞了就加后缀。撞的前提是有人手工改过别的机器的别名占了这个名字
  let alias = nodeId;
  for (let i = 2; aliasTaken(alias, nodeId); i++) alias = `${nodeId}-${i}`;

  db.prepare(`
    INSERT INTO ssh_endpoints (node_id,alias,updated_at) VALUES (?,?,?)
  `).run(nodeId, alias, Date.now());
  return getEndpoint(nodeId)!;
}

function aliasTaken(alias: string, exceptNode: string): boolean {
  const r = db
    .prepare('SELECT node_id FROM ssh_endpoints WHERE alias = ? AND node_id != ?')
    .get(alias, exceptNode) as { node_id: string } | undefined;
  return Boolean(r);
}

export function updateEndpoint(
  nodeId: string,
  patch: {
    alias?: string;
    hostname?: string;
    port?: number;
    defaultUser?: string;
    proxyJump?: string;
    identityFile?: string;
  },
): SshEndpoint {
  const current = ensureEndpoint(nodeId);

  if (patch.alias !== undefined) {
    const err = validateAlias(patch.alias);
    if (err) throw new SshStoreError(err);
    if (aliasTaken(patch.alias, nodeId)) throw new SshStoreError('这个别名已经被别的机器占用了', 409);
  }
  if (patch.hostname !== undefined && patch.hostname.trim()) {
    const err = validateHostname(patch.hostname);
    if (err) throw new SshStoreError(err);
  }
  if (patch.proxyJump !== undefined) {
    const err = validateProxyJump(patch.proxyJump);
    if (err) throw new SshStoreError(err);
  }
  const port = patch.port === undefined ? current.port : Math.trunc(Number(patch.port));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshStoreError('端口必须是 1-65535 的整数');
  }
  const user = patch.defaultUser === undefined ? current.defaultUser : String(patch.defaultUser).trim();
  if (!/^[a-zA-Z0-9._-]{1,32}$/.test(user)) {
    throw new SshStoreError('默认账号只能包含字母、数字、点、下划线、连字符');
  }

  db.prepare(`
    UPDATE ssh_endpoints
    SET alias=?, hostname=?, port=?, default_user=?, proxy_jump=?, identity_file=?, updated_at=?
    WHERE node_id=?
  `).run(
    patch.alias ?? current.alias,
    patch.hostname === undefined ? current.hostname : String(patch.hostname).trim(),
    port,
    user,
    patch.proxyJump === undefined ? current.proxyJump : String(patch.proxyJump).trim(),
    patch.identityFile === undefined ? current.identityFile : String(patch.identityFile).trim().slice(0, 200),
    Date.now(),
    nodeId,
  );
  return getEndpoint(nodeId)!;
}

// ————————————————————————————————————————————————————————
// agent 上报的实况
// ————————————————————————————————————————————————————————

export interface ObservedKeyInput {
  remoteUser: string;
  fingerprint: string;
  keyType?: string;
  comment?: string;
  options?: string;
}

export interface SshFactsInput {
  sshdVersion?: string;
  sshdPort?: number;
  /** null / undefined 表示采不到 */
  passwordAuth?: boolean | null;
  permitRootLogin?: string;
  hostKeys?: Array<{ type: string; blob: string }>;
  keys?: ObservedKeyInput[];
}

/**
 * 写入一台机器的 SSH 实况。
 *
 * 覆盖写而不是累加：这张表表达的是"此刻机器上有什么"，
 * 累加会让一把早就被删掉的钥匙永远留在对账视图里。
 */
export function ingestSshFacts(nodeId: string, facts: SshFactsInput): void {
  const now = Date.now();
  ensureEndpoint(nodeId);

  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE ssh_endpoints
      SET sshd_version=?, sshd_port=?, password_auth=?, permit_root_login=?, host_keys=?, observed_at=?
      WHERE node_id=?
    `).run(
      String(facts.sshdVersion ?? '').slice(0, 40),
      Math.trunc(Number(facts.sshdPort ?? 0)) || 0,
      facts.passwordAuth === undefined || facts.passwordAuth === null ? -1 : facts.passwordAuth ? 1 : 0,
      String(facts.permitRootLogin ?? '').slice(0, 20),
      JSON.stringify((facts.hostKeys ?? []).slice(0, 8)),
      now,
      nodeId,
    );

    if (facts.keys) {
      db.prepare('DELETE FROM ssh_observed_keys WHERE node_id=?').run(nodeId);
      const ins = db.prepare(`
        INSERT OR REPLACE INTO ssh_observed_keys
          (node_id,remote_user,fingerprint,key_type,comment,managed,options,seen_at)
        VALUES (?,?,?,?,?,?,?,?)
      `);
      for (const k of facts.keys.slice(0, 500)) {
        const comment = String(k.comment ?? '').slice(0, 200);
        ins.run(
          nodeId,
          String(k.remoteUser).slice(0, 32),
          String(k.fingerprint).slice(0, 60),
          String(k.keyType ?? '').slice(0, 40),
          comment,
          // 带 sonar: 前缀的才算我们装的。删除时只认这个标记
          comment.startsWith(`${SONAR_TAG}:`) ? 1 : 0,
          String(k.options ?? '').slice(0, 200),
          now,
        );
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (facts.keys) reconcileGrants(nodeId, now);
}

/**
 * 对账：拿实况去修正授权的状态。
 *
 * **这是唯一会把 grant 置为 active 的地方。** 命令生成、agent 回执都不算数 ——
 * 它们只说明"我们试过了"，而实况才说明"机器上真的有"。
 *
 * 反过来也一样：一条 active 的授权在实况里消失了，说明有人手工删了它，
 * 这时置为 drifted 而不是 revoked —— 后者意味着"我们撤的"，事实并非如此。
 */
export function reconcileGrants(nodeId: string, now = Date.now()): void {
  const observed = db
    .prepare('SELECT remote_user, fingerprint FROM ssh_observed_keys WHERE node_id=?')
    .all(nodeId) as Array<{ remote_user: string; fingerprint: string }>;
  const present = new Set(observed.map((o) => `${o.remote_user} ${o.fingerprint}`));

  const grants = db
    .prepare(`
      SELECT g.id, g.remote_user, g.state, g.applied_at, k.fingerprint
      FROM ssh_grants g JOIN ssh_keys k ON k.id = g.key_id
      WHERE g.node_id = ? AND g.state != 'revoked'
    `)
    .all(nodeId) as Array<{
    id: string;
    remote_user: string;
    state: GrantState;
    applied_at: number;
    fingerprint: string;
  }>;

  const setActive = db.prepare('UPDATE ssh_grants SET state=?, applied_at=? WHERE id=?');
  const setState = db.prepare('UPDATE ssh_grants SET state=? WHERE id=?');

  for (const g of grants) {
    const here = present.has(`${g.remote_user} ${g.fingerprint}`);
    if (here) {
      if (g.state !== 'active') setActive.run('active', g.applied_at || now, g.id);
    } else if (g.state === 'active') {
      // 之前确实生效过，现在没了 —— 有人手工删了，或者密钥过期被 sshd 摘掉
      setState.run('drifted', g.id);
    }
    // pending 的保持 pending：命令可能还没被执行，这不是漂移
  }
}

/** 某台机器某个账号的实况，预检要用。 */
export function hostFacts(nodeId: string, remoteUser: string, agentOnline: boolean): HostFacts {
  const ep = getEndpoint(nodeId);
  const rows = db
    .prepare('SELECT fingerprint, managed FROM ssh_observed_keys WHERE node_id=? AND remote_user=?')
    .all(nodeId, remoteUser) as Array<{ fingerprint: string; managed: number }>;

  return {
    sshdVersion: ep?.sshdVersion ?? '',
    observedFingerprints: rows.map((r) => r.fingerprint),
    managedFingerprints: rows.filter((r) => r.managed === 1).map((r) => r.fingerprint),
    passwordAuth: ep?.passwordAuth ?? null,
    observedAt: ep?.observedAt ?? 0,
    agentOnline,
  };
}

/**
 * 对账视图：机器上实际有哪些钥匙，面板认不认识。
 *
 * `known=false` 的那些是这整套东西最有价值的输出 —— 一台买了两年、装过各种
 * 一键脚本的 VPS，这个数字往往不是 0，而今天没有任何工具会告诉你。
 */
export function listDrift(nodeId?: string): SshDrift[] {
  const sql = `
    SELECT o.*, n.name AS node_name, k.id AS key_id, u.name AS owner_name
    FROM ssh_observed_keys o
    LEFT JOIN nodes n ON n.id = o.node_id
    LEFT JOIN ssh_keys k ON k.fingerprint = o.fingerprint
    LEFT JOIN users u ON u.id = k.owner_user_id
    ${nodeId ? 'WHERE o.node_id = ?' : ''}
    ORDER BY o.node_id, o.remote_user, o.managed DESC
  `;
  const rows = (nodeId ? db.prepare(sql).all(nodeId) : db.prepare(sql).all()) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    nodeId: r.node_id as string,
    nodeName: (r.node_name as string) ?? (r.node_id as string),
    remoteUser: r.remote_user as string,
    fingerprint: r.fingerprint as string,
    keyType: (r.key_type as string) ?? '',
    comment: (r.comment as string) ?? '',
    managed: Number(r.managed) === 1,
    known: Boolean(r.key_id),
    ownerName: (r.owner_name as string) ?? '',
    seenAt: Number(r.seen_at ?? 0),
  }));
}

// ————————————————————————————————————————————————————————
// 授权
// ————————————————————————————————————————————————————————

const GRANT_SELECT = `
  SELECT g.*, n.name AS node_name, k.fingerprint AS key_fp, k.label AS key_label,
         k.owner_user_id, u.name AS owner_name
  FROM ssh_grants g
  JOIN ssh_keys k ON k.id = g.key_id
  LEFT JOIN nodes n ON n.id = g.node_id
  LEFT JOIN users u ON u.id = k.owner_user_id
`;

function rowToGrant(r: Record<string, unknown>): SshGrant {
  return {
    id: r.id as string,
    nodeId: r.node_id as string,
    nodeName: (r.node_name as string) ?? (r.node_id as string),
    keyId: r.key_id as string,
    keyFingerprint: (r.key_fp as string) ?? '',
    keyLabel: (r.key_label as string) ?? '',
    ownerUserId: (r.owner_user_id as string) ?? '',
    ownerName: (r.owner_name as string) ?? '',
    remoteUser: r.remote_user as string,
    state: r.state as GrantState,
    requestState: r.request_state as GrantRequestState,
    expiresAt: Number(r.expires_at ?? 0),
    method: (r.method as 'command' | 'agent') ?? 'command',
    requestedBy: (r.requested_by as string) ?? '',
    grantedBy: (r.granted_by as string) ?? '',
    grantedAt: Number(r.granted_at ?? 0),
    approvedBy: (r.approved_by as string) ?? '',
    approvedAt: Number(r.approved_at ?? 0),
    rejectReason: (r.reject_reason as string) ?? '',
    appliedAt: Number(r.applied_at ?? 0),
    revokedBy: (r.revoked_by as string) ?? '',
    revokedAt: Number(r.revoked_at ?? 0),
    note: (r.note as string) ?? '',
  };
}

export function listGrants(filter: { nodeId?: string; keyId?: string; ownerUserId?: string } = {}): SshGrant[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.nodeId) {
    where.push('g.node_id = ?');
    params.push(filter.nodeId);
  }
  if (filter.keyId) {
    where.push('g.key_id = ?');
    params.push(filter.keyId);
  }
  if (filter.ownerUserId) {
    where.push('k.owner_user_id = ?');
    params.push(filter.ownerUserId);
  }
  const sql = `${GRANT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.granted_at DESC`;
  const rows = db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
  return rows.map(rowToGrant);
}

export function getGrant(id: string): SshGrant | null {
  const r = db.prepare(`${GRANT_SELECT} WHERE g.id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToGrant(r) : null;
}

export function createGrant(input: {
  nodeId: string;
  keyId: string;
  remoteUser: string;
  expiresAt?: number;
  method?: 'command' | 'agent';
  requestState: GrantRequestState;
  requestedBy: string;
  grantedBy: string;
  approvedBy?: string;
  note?: string;
}): SshGrant {
  const key = getKey(input.keyId);
  if (!key) throw new SshStoreError('公钥不存在', 404);
  if (key.disabled) throw new SshStoreError('这把公钥已被停用', 409);

  const live = db
    .prepare("SELECT id, state FROM ssh_grants WHERE node_id=? AND key_id=? AND remote_user=? AND state != 'revoked'")
    .get(input.nodeId, input.keyId, input.remoteUser) as { id: string; state: string } | undefined;
  if (live) {
    throw new SshStoreError(`这把公钥对该机器的 ${input.remoteUser} 已经有一条授权了（${live.state}）`, 409);
  }

  const id = `g:${randomUUID()}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO ssh_grants
      (id,node_id,key_id,remote_user,state,request_state,expires_at,method,
       requested_by,granted_by,granted_at,approved_by,approved_at,note)
    VALUES (?,?,?,?,'pending',?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    input.nodeId,
    input.keyId,
    input.remoteUser,
    input.requestState,
    Math.max(0, Math.trunc(Number(input.expiresAt ?? 0))),
    input.method ?? 'command',
    input.requestedBy,
    input.grantedBy,
    now,
    input.approvedBy ?? '',
    input.approvedBy ? now : 0,
    (input.note ?? '').slice(0, 200),
  );
  return getGrant(id)!;
}

export function approveGrant(id: string, approver: string): SshGrant {
  const g = getGrant(id);
  if (!g) throw new SshStoreError('授权申请不存在', 404);
  if (g.requestState !== 'pending_approval') throw new SshStoreError('这条申请不在待审批状态', 409);
  /*
   * 四眼原则：自己不能批自己的申请。
   *
   * 少了这条，审批流就只是多点一次鼠标 —— 一个有 ssh:grant + ssh:approve 的人
   * 可以给自己开任意机器的门，而流程记录看起来一切正常。
   */
  if (g.requestedBy === approver) {
    throw new SshStoreError('不能审批自己发起的申请，请让另一个人来批', 409);
  }
  db.prepare("UPDATE ssh_grants SET request_state='approved', approved_by=?, approved_at=? WHERE id=?")
    .run(approver, Date.now(), id);
  return getGrant(id)!;
}

export function rejectGrant(id: string, approver: string, reason: string): SshGrant {
  const g = getGrant(id);
  if (!g) throw new SshStoreError('授权申请不存在', 404);
  if (g.requestState !== 'pending_approval') throw new SshStoreError('这条申请不在待审批状态', 409);
  db.prepare(`
    UPDATE ssh_grants SET request_state='rejected', state='revoked',
      approved_by=?, approved_at=?, reject_reason=? WHERE id=?
  `).run(approver, Date.now(), String(reason ?? '').slice(0, 200), id);
  return getGrant(id)!;
}

export function markGrantRevoked(id: string, operator: string): SshGrant {
  const g = getGrant(id);
  if (!g) throw new SshStoreError('授权不存在', 404);
  db.prepare("UPDATE ssh_grants SET state='revoked', revoked_by=?, revoked_at=? WHERE id=?")
    .run(operator, Date.now(), id);
  return getGrant(id)!;
}

export function markGrantFailed(id: string, reason: string): void {
  db.prepare("UPDATE ssh_grants SET state='failed', note=? WHERE id=?")
    .run(String(reason ?? '').slice(0, 200), id);
}

/**
 * 某个人在所有机器上的授权 —— 人员离场时一键列出。
 *
 * 这是团队场景里最高频、最容易漏的动作，也是唯一能证明这套系统有价值的时刻。
 */
export function grantsOfUser(userId: string): SshGrant[] {
  return listGrants({ ownerUserId: userId }).filter((g) => g.state !== 'revoked');
}

/**
 * 已过期但还没被清理的授权。
 *
 * sshd 的 expiry-time 到点会拒绝这把 key，agent 也会本地摘除，但面板这边
 * 的记录不会自己变 —— 定时扫一遍，让界面上的状态和事实一致。
 */
export function expireGrants(now = Date.now()): number {
  const rows = db
    .prepare("SELECT id FROM ssh_grants WHERE state IN ('pending','active') AND expires_at > 0 AND expires_at < ?")
    .all(now) as Array<{ id: string }>;
  for (const r of rows) {
    db.prepare("UPDATE ssh_grants SET state='revoked', revoked_by='system', revoked_at=? WHERE id=?")
      .run(now, r.id);
  }
  return rows.length;
}

/** 今天的日期串，进 comment 用。跟着面板时区走，和流量归档同一个口径。 */
export function todayStamp(): string {
  const tz = getSettings().timezone;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts.replace(/-/g, '');
}

export type { ParsedKey };
