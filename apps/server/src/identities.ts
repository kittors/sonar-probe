import { randomUUID } from 'node:crypto';
import { db } from './db.js';

/**
 * 登录身份
 *
 * 一个用户可以有多种登录方式：用密码进来，同时绑着 GitHub，两条路指向同一个账号。
 *
 * 拆表之前这件事表达不出来 —— users 表里只有一个 github_id，一行放不下第二种身份，
 * 于是"用 GitHub 登录的人"和"用密码登录的人"注定是两个账号，权限、审计、SSH 授权
 * 全都要分别配一遍，而它们其实是同一个人。
 *
 * provider_uid 的含义随 provider 变：
 *   password —— 用户名
 *   github   —— GitHub 的数字 id（不是 login，那个能改）
 *
 * secret 只有 password 用（scrypt 哈希）。github 那行恒为空：OAuth 的凭据在
 * GitHub 手里，我们这边不该留下任何可以复用的东西。
 */

export type Provider = 'password' | 'github';

export interface Identity {
  id: string;
  userId: string;
  provider: Provider;
  /** password 是用户名，github 是数字 id */
  providerUid: string;
  meta: Record<string, unknown>;
  createdAt: number;
  lastUsedAt: number;
}

export class IdentityError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function rowToIdentity(r: Record<string, unknown>): Identity {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse((r.meta as string) || '{}') as Record<string, unknown>;
  } catch {
    // 存坏了就当没有附加信息，不该让整个用户查询失败
  }
  return {
    id: r.id as string,
    userId: r.user_id as string,
    provider: r.provider as Provider,
    providerUid: r.provider_uid as string,
    meta,
    createdAt: Number(r.created_at ?? 0),
    lastUsedAt: Number(r.last_used_at ?? 0),
  };
}

// ————————————————————————————————————————————————————————
// 读
// ————————————————————————————————————————————————————————

export function listIdentities(userId: string): Identity[] {
  const rows = db
    .prepare('SELECT * FROM identities WHERE user_id=? ORDER BY created_at ASC')
    .all(userId) as Array<Record<string, unknown>>;
  return rows.map(rowToIdentity);
}

export function findIdentity(provider: Provider, providerUid: string): Identity | null {
  const r = db
    .prepare('SELECT * FROM identities WHERE provider=? AND provider_uid=?')
    .get(provider, providerUid) as Record<string, unknown> | undefined;
  return r ? rowToIdentity(r) : null;
}

/** 取密码哈希。只有登录校验会用到，所以单独一个函数，不混进 Identity 里到处传。 */
export function passwordSecret(userId: string): { identityId: string; secret: string } | null {
  const r = db
    .prepare("SELECT id, secret FROM identities WHERE user_id=? AND provider='password'")
    .get(userId) as { id: string; secret: string } | undefined;
  return r && r.secret ? { identityId: r.id, secret: r.secret } : null;
}

export function hasProvider(userId: string, provider: Provider): boolean {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM identities WHERE user_id=? AND provider=?')
    .get(userId, provider) as { n: number };
  return Number(r.n) > 0;
}

export function identityCount(userId: string): number {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM identities WHERE user_id=?')
    .get(userId) as { n: number };
  return Number(r.n);
}

// ————————————————————————————————————————————————————————
// 写
// ————————————————————————————————————————————————————————

/**
 * 绑定一种登录方式。
 *
 * provider + provider_uid 上有唯一索引：同一个 GitHub 账号不能同时绑到两个人身上，
 * 否则"谁做的这件事"在审计里就有两个答案。
 */
export function bindIdentity(input: {
  userId: string;
  provider: Provider;
  providerUid: string;
  secret?: string;
  meta?: Record<string, unknown>;
}): Identity {
  const existing = findIdentity(input.provider, input.providerUid);
  if (existing) {
    if (existing.userId === input.userId) return existing;
    throw new IdentityError(
      input.provider === 'github'
        ? '这个 GitHub 账号已经绑定到另一个用户了'
        : '这个用户名已经被占用了',
      409,
    );
  }

  const now = Date.now();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO identities (id,user_id,provider,provider_uid,secret,meta,created_at,last_used_at)
    VALUES (?,?,?,?,?,?,?,0)
  `).run(
    id,
    input.userId,
    input.provider,
    input.providerUid,
    input.secret ?? '',
    JSON.stringify(input.meta ?? {}),
    now,
  );

  return findIdentity(input.provider, input.providerUid)!;
}

/** 换密码：只动 secret，不动绑定关系。 */
export function updatePasswordSecret(userId: string, secret: string): void {
  const res = db
    .prepare("UPDATE identities SET secret=? WHERE user_id=? AND provider='password'")
    .run(secret, userId);
  if (Number(res.changes ?? 0) === 0) {
    throw new IdentityError('这个账号还没有设置密码登录', 404);
  }
}

export function touchIdentity(identityId: string): void {
  db.prepare('UPDATE identities SET last_used_at=? WHERE id=?').run(Date.now(), identityId);
}

/**
 * 解绑。
 *
 * **最后一种登录方式不能解绑。** 这是这个模块里唯一真正危险的操作：解开之后
 * 账号还在、权限还在、数据还在，但没有任何一条路能再登进去，而且没有任何界面
 * 能撤销它 —— 只能去改数据库。和封禁那边"不许封掉自己的出口 IP"是同一类保护。
 */
export function unbindIdentity(userId: string, provider: Provider): void {
  if (!hasProvider(userId, provider)) {
    throw new IdentityError('没有绑定这种登录方式', 404);
  }
  if (identityCount(userId) <= 1) {
    throw new IdentityError('这是账号唯一的登录方式，解绑后就再也登不进来了', 409);
  }
  db.prepare('DELETE FROM identities WHERE user_id=? AND provider=?').run(userId, provider);
}

/**
 * 把旧的 users.github_id 迁进 identities。
 *
 * 幂等：已经迁过的（identities 里查得到）跳过。只在启动时跑一次，
 * 迁完不清 users.github_id —— 留着它，万一这次改动要回滚，旧代码还能照常登录。
 */
export function migrateLegacyGithubIdentities(): number {
  const rows = db
    .prepare(`
      SELECT u.id, u.github_id, u.login, u.avatar
      FROM users u
      WHERE u.github_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM identities i WHERE i.provider='github' AND i.provider_uid = CAST(u.github_id AS TEXT)
        )
    `)
    .all() as Array<{ id: string; github_id: number; login: string; avatar: string }>;

  let migrated = 0;
  for (const r of rows) {
    try {
      bindIdentity({
        userId: r.id,
        provider: 'github',
        providerUid: String(r.github_id),
        meta: { login: r.login, avatar: r.avatar },
      });
      migrated++;
    } catch {
      // 撞上唯一索引说明这个 GitHub 账号已经绑在别人身上了，跳过而不是中断启动
    }
  }
  return migrated;
}
