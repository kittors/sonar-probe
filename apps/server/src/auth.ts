import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from './db.js';
import type { Capability, Role } from './permissions.js';
import { capabilitiesFor, getRole, roleAssignable, roleExists } from './roles.js';
import {
  bindIdentity,
  findIdentity,
  hasProvider,
  identityCount,
  listIdentities,
  passwordSecret,
  touchIdentity,
  updatePasswordSecret,
  type Provider,
} from './identities.js';
import {
  burnPasswordTime,
  checkPasswordStrength,
  generatePassword,
  hashPassword,
  verifyPassword,
} from './password.js';
import { readStoredOAuth } from './setup.js';

/**
 * 认证与会话
 *
 * 两类账号：正式用户和访客。
 *
 * 正式用户可以有多种登录方式 —— 密码、GitHub，或者两者都有，指向同一个账号
 * （见 identities.ts）。用哪种进来只影响这一次登录，不影响他是谁、有什么权限。
 *
 * 访客不需要任何凭据，但会被完整记录（谁、什么时候、看了哪些页面），
 * 管理员能在后台看到访客的实时在线情况。访客不能绑定身份，会话也短得多。
 *
 * 冷启动靠 ensureRootAdmin()：面板第一次跑起来就有一个超级管理员，
 * 不再依赖"第一个 GitHub 登录的人"—— 那个模式要求你必须先配好 OAuth 才能进门。
 */

const SESSION_COOKIE = 'sonar_session';
const SESSION_TTL_MS = 7 * 86_400_000;
const GUEST_TTL_MS = 12 * 3600_000;

export type UserKind = 'user' | 'guest';

export interface SessionUser {
  id: string;
  kind: UserKind;
  /** 密码登录的用户名。GitHub-only 的账号是空串 */
  username: string;
  /** 展示用的短标识，GitHub 用户是它的 login */
  login: string;
  name: string;
  avatar: string;
  email: string;
  role: Role;
  granted: string[];
  revoked: string[];
  disabled: boolean;
  /** 超级管理员：不可删除、不可停用、不可降权 */
  isRoot: boolean;
  /** 用系统生成的初始密码登录后，换掉之前什么都干不了 */
  mustChangePassword: boolean;
  createdAt: number;
  lastSeen: number;
  note: string;
}

export interface AuthContext {
  user: SessionUser;
  sessionId: string;
  caps: Set<Capability>;
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// ————————————————————————————————————————————————————————
// 用户
// ————————————————————————————————————————————————————————

function rowToUser(r: Record<string, unknown>): SessionUser {
  return {
    id: r.id as string,
    kind: (r.kind as UserKind) === 'guest' ? 'guest' : 'user',
    username: (r.username as string) ?? '',
    login: r.login as string,
    name: r.name as string,
    avatar: r.avatar as string,
    email: r.email as string,
    role: r.role as Role,
    granted: JSON.parse((r.granted as string) || '[]'),
    revoked: JSON.parse((r.revoked as string) || '[]'),
    disabled: Number(r.disabled) === 1,
    isRoot: Number(r.is_root) === 1,
    mustChangePassword: Number(r.must_change_password) === 1,
    createdAt: r.created_at as number,
    lastSeen: r.last_seen as number,
    note: (r.note as string) ?? '',
  };
}

export function getUser(id: string): SessionUser | null {
  const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToUser(r) : null;
}

export function listUsers(): SessionUser[] {
  const rows = db
    /*
     * 字符串必须用单引号。
     *
     * SQLite 里双引号是**标识符**（列名/表名），所以 "github" 会被当成一个叫
     * github 的列去解析，直接报 no such column —— 整个用户列表接口 500。
     * 它只在双引号里的内容恰好不是任何列名时才会退化成字符串，这个"宽容"
     * 反而让这类错误在别处能跑通、到这里才炸。
     */
    .prepare("SELECT * FROM users ORDER BY is_root DESC, (kind = 'user') DESC, last_seen DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToUser);
}

export function findUserByUsername(username: string): SessionUser | null {
  const r = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToUser(r) : null;
}

/** 有没有启用中的管理员。ensureRootAdmin 靠它决定要不要造一个。 */
export function hasAnyAdmin(): boolean {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")
    .get() as { n: number };
  return r.n > 0;
}

export function rootAdmin(): SessionUser | null {
  const r = db.prepare('SELECT * FROM users WHERE is_root = 1 LIMIT 1').get() as
    | Record<string, unknown>
    | undefined;
  return r ? rowToUser(r) : null;
}

// ————————————————————————————————————————————————————————
// 建号
// ————————————————————————————————————————————————————————

/** 用户名会出现在登录框、审计日志和 SSH 授权记录里，收得严一点，省得日后要处理歧义。 */
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

export function validateUsername(username: string): string | null {
  if (!USERNAME_RE.test(username)) {
    return '用户名 2-32 位，字母或数字开头，只能包含字母、数字、点、下划线、连字符';
  }
  return null;
}

export interface CreateUserInput {
  username: string;
  password: string;
  name?: string;
  email?: string;
  role?: string;
  note?: string;
  /** 系统生成的初始密码，登录后强制修改 */
  mustChangePassword?: boolean;
  isRoot?: boolean;
}

/**
 * 建一个密码账号。
 *
 * 用户名的唯一性有两道保证：users.username 上的部分唯一索引，以及
 * identities(provider,provider_uid) 上的唯一索引。两处都建在库里而不是靠
 * 先查后插 —— 那个写法在并发下必然漏，而漏掉的结果是两个人共用一个登录名。
 */
export async function createUser(input: CreateUserInput): Promise<SessionUser> {
  const username = String(input.username ?? '').trim();
  const usernameError = validateUsername(username);
  if (usernameError) throw new AuthError(usernameError);

  const name = String(input.name ?? '').trim() || username;
  const pwError = checkPasswordStrength(input.password, { username, name });
  if (pwError) throw new AuthError(pwError);

  const role = String(input.role ?? 'viewer');
  if (!roleExists(role)) throw new AuthError(`角色 ${role} 不存在`);
  if (!roleAssignable(role)) throw new AuthError(`「${getRole(role)?.name ?? role}」不能指派给账号`);

  if (findUserByUsername(username)) throw new AuthError('这个用户名已经被占用了', 409);

  // 哈希放在事务外面：scrypt 要跑上百毫秒，握着写事务等它会把整个库锁住
  const secret = await hashPassword(input.password);

  const now = Date.now();
  const id = `u:${randomUUID()}`;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO users (id,kind,github_id,username,login,name,avatar,email,role,granted,revoked,note,
        disabled,is_root,must_change_password,created_at,last_seen)
      VALUES (?,'user',NULL,?,?,?,'',?,?,'[]','[]',?,0,?,?,?,0)
    `).run(
      id,
      username,
      username,
      name,
      String(input.email ?? '').trim(),
      role,
      String(input.note ?? '').trim(),
      input.isRoot ? 1 : 0,
      input.mustChangePassword ? 1 : 0,
      now,
    );

    bindIdentity({ userId: id, provider: 'password', providerUid: username, secret });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getUser(id)!;
}

/**
 * 冷启动：保证面板永远有一个管得住它的账号。
 *
 * 旧的做法是"第一个 GitHub 登录成功的人自动成为管理员"。它能解决冷启动，
 * 但有两个现实问题：一是必须先配好 OAuth 才进得了门，而 OAuth 的配置本身
 * 就在面板里；二是面板一旦先于配置暴露在公网，管理员就是**谁先到谁拿**。
 *
 * 现在改成开箱就有 root：随机密码写进 data/initial-admin.txt（0600）并打印一次，
 * 首次登录强制改密。和 Jenkins 的 initialAdminPassword、GitLab 的 root 是同一个套路。
 */
export async function ensureRootAdmin(dataDir: string): Promise<{ username: string; password: string } | null> {
  if (rootAdmin() || hasAnyAdmin()) return null;

  const username = process.env.SONAR_ROOT_USER?.trim() || 'admin';
  /*
   * 允许用环境变量指定初始密码，给自动化部署用。
   *
   * 但它只在这一次冷启动时读 —— 不做"每次启动都把密码重置成 env 里那个"，
   * 那等于在环境变量里长期存着一把永远有效的万能钥匙。
   */
  const preset = process.env.SONAR_ROOT_PASSWORD?.trim();
  const password = preset || generatePassword(20);

  const user = await createUser({
    username,
    password,
    name: '超级管理员',
    role: 'admin',
    isRoot: true,
    // 自己设的密码不用强制改，系统生成的必须改
    mustChangePassword: !preset,
    note: '面板初始化时自动创建',
  });

  if (!preset) writeInitialPassword(dataDir, user.username, password);
  return { username: user.username, password };
}

function writeInitialPassword(dataDir: string, username: string, password: string): void {
  try {
    const path = resolve(dataDir, 'initial-admin.txt');
    writeFileSync(
      path,
      [
        'Sonar 初始管理员账号',
        '',
        `用户名：${username}`,
        `密码：  ${password}`,
        '',
        '首次登录后会强制要求修改密码。改完之后请删除本文件。',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
  } catch {
    // 写不进去不影响启动 —— 密码同时会打印到日志里
  }
}

// ————————————————————————————————————————————————————————
// 密码登录
// ————————————————————————————————————————————————————————

/**
 * 用户名密码登录。
 *
 * 失败一律返回同一句话，不区分"没这个人"和"密码不对"—— 区分了就等于
 * 提供了一个用户名枚举接口。时间上的差异同样要抹平，见 burnPasswordTime。
 */
export async function authenticatePassword(
  username: string,
  password: string,
): Promise<SessionUser> {
  const name = String(username ?? '').trim();
  const pw = String(password ?? '');

  const user = name ? findUserByUsername(name) : null;
  const stored = user ? passwordSecret(user.id) : null;

  if (!user || !stored) {
    // 账号不存在时也烧掉一次 scrypt 的时间，否则响应快慢本身就是答案
    await burnPasswordTime(pw);
    throw new AuthError('用户名或密码不正确', 401);
  }

  const ok = await verifyPassword(pw, stored.secret);
  if (!ok) throw new AuthError('用户名或密码不正确', 401);

  // 停用的账号要在密码校验**之后**才报错，否则"账号已停用"这句话
  // 就成了一个不需要密码的账号存在性探测接口
  if (user.disabled) throw new AuthError('这个账号已被停用，请联系管理员', 403);

  touchIdentity(stored.identityId);
  return user;
}

/**
 * 改密码。
 *
 * 改完踢掉该用户其它所有会话 —— 换密码的场景多半是"怀疑密码泄露了"，
 * 只改凭据却留着已经建立的会话，等于这次修改对入侵者毫无影响。
 */
export async function changePassword(
  userId: string,
  input: { current?: string; next: string; requireCurrent?: boolean },
  keepSessionId?: string,
): Promise<void> {
  const user = getUser(userId);
  if (!user) throw new AuthError('用户不存在', 404);

  const stored = passwordSecret(userId);

  if (input.requireCurrent !== false) {
    if (!stored) throw new AuthError('这个账号还没有设置密码登录', 400);
    const ok = await verifyPassword(String(input.current ?? ''), stored.secret);
    if (!ok) throw new AuthError('当前密码不正确', 403);
  }

  const err = checkPasswordStrength(input.next, { username: user.username, name: user.name });
  if (err) throw new AuthError(err);

  if (stored) {
    const same = await verifyPassword(input.next, stored.secret);
    if (same) throw new AuthError('新密码不能和当前密码相同');
  }

  const secret = await hashPassword(input.next);

  if (stored) {
    updatePasswordSecret(userId, secret);
  } else {
    // 原本只有 GitHub 登录的账号，这一步等于新增一种登录方式
    const username = user.username || user.login;
    const nameError = validateUsername(username);
    if (nameError) throw new AuthError(`无法为这个账号启用密码登录：${nameError}`);
    bindIdentity({ userId, provider: 'password', providerUid: username, secret });
    db.prepare('UPDATE users SET username=? WHERE id=?').run(username, userId);
  }

  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(userId);
  revokeOtherSessions(userId, keepSessionId);
}

/** 管理员重置他人密码：不需要旧密码，但一定强制对方下次登录改掉。 */
export async function resetPassword(userId: string, next?: string): Promise<string> {
  const user = getUser(userId);
  if (!user) throw new AuthError('用户不存在', 404);

  const password = next?.trim() || generatePassword(20);
  const err = checkPasswordStrength(password, { username: user.username, name: user.name });
  if (err) throw new AuthError(err);

  const secret = await hashPassword(password);
  if (passwordSecret(userId)) {
    updatePasswordSecret(userId, secret);
  } else {
    const username = user.username || user.login;
    const nameError = validateUsername(username);
    if (nameError) throw new AuthError(`无法为这个账号启用密码登录：${nameError}`);
    bindIdentity({ userId, provider: 'password', providerUid: username, secret });
    db.prepare('UPDATE users SET username=? WHERE id=?').run(username, userId);
  }

  db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(userId);
  revokeUserSessions(userId);
  return password;
}

// ————————————————————————————————————————————————————————
// GitHub
// ————————————————————————————————————————————————————————

export interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

/** 关掉之后，只有已经绑过 GitHub 的账号能用它登录，陌生账号一律拒绝。 */
export function githubSignupEnabled(): boolean {
  return process.env.SONAR_DISABLE_GITHUB_SIGNUP !== '1';
}

/**
 * GitHub 登录。
 *
 * 三种情况：
 *   1. 这个 GitHub 已经绑过 → 更新资料，登进对应账号
 *   2. 没绑过，且允许自助注册 → 建一个新账号（默认 viewer），绑上
 *   3. 没绑过，且关闭了自助注册 → 拒绝
 *
 * 第三种是公开部署的默认姿势：面板挂在公网、OAuth 配好之后，任何一个
 * GitHub 用户都能给自己建号 —— 权限再低，也已经越过了"我认识你"这条线。
 *
 * 注意这里**不再有"首个登录者成为管理员"**。冷启动交给 ensureRootAdmin，
 * 管理员身份不该是先到先得的。
 */
export function upsertGithubUser(profile: GithubProfile): { user: SessionUser; created: boolean } {
  const uid = String(profile.id);
  const now = Date.now();
  const name = profile.name ?? profile.login;

  const existing = findIdentity('github', uid);
  if (existing) {
    db.prepare('UPDATE users SET login=?, name=?, avatar=?, email=COALESCE(NULLIF(?,\'\'), email), last_seen=? WHERE id=?')
      .run(profile.login, name, profile.avatar_url, profile.email ?? '', now, existing.userId);
    db.prepare('UPDATE identities SET meta=?, last_used_at=? WHERE id=?')
      .run(JSON.stringify({ login: profile.login, avatar: profile.avatar_url }), now, existing.id);

    const user = getUser(existing.userId);
    if (!user) throw new AuthError('这个 GitHub 绑定的账号已经不存在了', 404);
    return { user, created: false };
  }

  if (!githubSignupEnabled()) {
    throw new AuthError('这个 GitHub 账号还没有被授权访问本面板', 403);
  }

  const id = `u:${randomUUID()}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO users (id,kind,github_id,username,login,name,avatar,email,role,granted,revoked,note,
        disabled,is_root,must_change_password,created_at,last_seen)
      VALUES (?,'user',?,'',?,?,?,?,'viewer','[]','[]','',0,0,0,?,?)
    `).run(id, profile.id, profile.login, name, profile.avatar_url, profile.email ?? '', now, now);

    bindIdentity({
      userId: id,
      provider: 'github',
      providerUid: uid,
      meta: { login: profile.login, avatar: profile.avatar_url },
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { user: getUser(id)!, created: true };
}

/** 给已登录的账号绑一个 GitHub。用户自己在个人设置里发起。 */
export function linkGithub(userId: string, profile: GithubProfile): SessionUser {
  const user = getUser(userId);
  if (!user) throw new AuthError('用户不存在', 404);
  if (user.kind === 'guest') throw new AuthError('访客账号不能绑定登录方式', 403);

  bindIdentity({
    userId,
    provider: 'github',
    providerUid: String(profile.id),
    meta: { login: profile.login, avatar: profile.avatar_url },
  });

  // 头像和昵称是这次绑定的附带收获，但不覆盖用户自己设过的名字
  db.prepare("UPDATE users SET avatar=COALESCE(NULLIF(avatar,''), ?), email=COALESCE(NULLIF(email,''), ?) WHERE id=?")
    .run(profile.avatar_url, profile.email ?? '', userId);

  return getUser(userId)!;
}

export function userIdentities(userId: string) {
  return listIdentities(userId).map((i) => ({
    provider: i.provider,
    /** 密码身份不回显任何凭据，GitHub 回显 login 好让人认出绑的是哪个号 */
    label: i.provider === 'github' ? String(i.meta.login ?? i.providerUid) : i.providerUid,
    createdAt: i.createdAt,
    lastUsedAt: i.lastUsedAt,
  }));
}

export { hasProvider, identityCount, type Provider };

/** 创建一个匿名访客。每次访客登录都是一个新身份，便于区分不同来访者。 */
export function createGuest(label?: string): SessionUser {
  const now = Date.now();
  const id = `guest:${randomUUID()}`;
  const shortId = id.slice(6, 12);
  db.prepare(`
    INSERT INTO users (id,kind,github_id,login,name,avatar,email,role,granted,revoked,note,disabled,created_at,last_seen)
    VALUES (?,?,NULL,?,?,'','','guest','[]','[]',?,0,?,?)
  `).run(id, 'guest', `guest-${shortId}`, label?.trim() || `访客 ${shortId}`, '', now, now);
  return getUser(id)!;
}

export function updateUser(
  id: string,
  patch: {
    role?: Role;
    granted?: string[];
    revoked?: string[];
    disabled?: boolean;
    note?: string;
    name?: string;
    email?: string;
  },
): SessionUser | null {
  const user = getUser(id);
  if (!user) return null;

  /*
   * 超级管理员不能被降权或停用。
   *
   * 这一条挡在最里层而不是只挡在路由上：改角色、停用、删除、批量导入，
   * 每条路径都会经过这里。只在接口上判的话，日后多一个入口就多一个缺口，
   * 而这个缺口的后果是面板永久失去管理员。
   */
  if (user.isRoot) {
    if (patch.role !== undefined && patch.role !== 'admin') {
      throw new AuthError('超级管理员的角色不能修改', 409);
    }
    if (patch.disabled === true) {
      throw new AuthError('超级管理员不能被停用', 409);
    }
  }

  if (patch.role !== undefined) {
    if (!roleExists(patch.role)) throw new AuthError(`角色 ${patch.role} 不存在`, 400);
    if (!roleAssignable(patch.role)) {
      throw new AuthError(`「${getRole(patch.role)?.name ?? patch.role}」不能指派给账号`, 400);
    }
  }

  const next = {
    role: patch.role ?? user.role,
    granted: JSON.stringify(patch.granted ?? user.granted),
    revoked: JSON.stringify(patch.revoked ?? user.revoked),
    disabled: (patch.disabled ?? user.disabled) ? 1 : 0,
    note: patch.note ?? user.note,
    name: (patch.name ?? user.name).trim() || user.name,
    email: patch.email ?? user.email,
  };

  db.prepare(
    'UPDATE users SET role=?, granted=?, revoked=?, disabled=?, note=?, name=?, email=? WHERE id=?',
  ).run(
    next.role, next.granted, next.revoked, next.disabled, next.note, next.name, next.email, id,
  );

  // 停用账号要立刻踢掉它所有的会话，否则已登录的窗口还能继续用
  if (next.disabled === 1) revokeUserSessions(id);

  return getUser(id);
}

/**
 * 删除用户。
 *
 * identities 上挂着 ON DELETE CASCADE，身份跟着一起走。审计日志**不删** ——
 * 那是这个人做过什么的唯一记录，随账号一起消失的话，删号就成了洗白操作记录的手段。
 */
export function deleteUser(id: string): void {
  const user = getUser(id);
  if (!user) throw new AuthError('用户不存在', 404);
  if (user.isRoot) throw new AuthError('超级管理员不能删除', 409);
  if (user.role === 'admin' && activeAdminCount() <= 1) {
    throw new AuthError('这是最后一个管理员，先提升另一位再删', 409);
  }

  revokeUserSessions(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
}

/** 还剩几个启用中的管理员 —— 用来阻止把最后一个管理员降权或停用。 */
export function activeAdminCount(): number {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0")
    .get() as { n: number };
  return r.n;
}

// ————————————————————————————————————————————————————————
// 会话
// ————————————————————————————————————————————————————————

export function createSession(userId: string, ip: string, ua: string, ttlMs?: number): string {
  const id = randomBytes(32).toString('base64url');
  const now = Date.now();
  const user = getUser(userId);
  const ttl = ttlMs ?? (user?.kind === 'guest' ? GUEST_TTL_MS : SESSION_TTL_MS);

  db.prepare(`
    INSERT INTO sessions (id,user_id,created_at,expires_at,last_active,ip,user_agent,revoked)
    VALUES (?,?,?,?,?,?,?,0)
  `).run(id, userId, now, now + ttl, now, ip, ua.slice(0, 400));

  return id;
}

export interface SessionRow {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastActive: number;
  ip: string;
  userAgent: string;
}

export function loadSession(token: string | undefined): AuthContext | null {
  if (!token) return null;

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(token) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  if (Number(row.revoked) === 1) return null;
  if ((row.expires_at as number) < Date.now()) return null;

  const user = getUser(row.user_id as string);
  if (!user || user.disabled) return null;

  /*
   * 还没改初始密码的人，权限降到和陌生人一样。
   *
   * 初始密码要么是系统生成后写进了服务器上的文件，要么是管理员设好口头转告的 ——
   * 两种情况下都不止一个人知道它。在它被换掉之前，这个会话不该比一个未登录的
   * 访客拥有更多东西。
   *
   * 降级而不是一律拒绝：直接封死的话，人连公开的概览页都打不开，
   * 那比未登录还糟，而他要做的其实只是改个密码。改密码那条路走的是
   * requireAccount 而不是 requireCap，不受这里影响。
   */
  const caps = user.mustChangePassword
    ? capabilitiesFor('anonymous')
    : capabilitiesFor(user.role, user.granted, user.revoked);

  return { user, sessionId: row.id as string, caps };
}

/** 刷新活跃时间。在线用户列表和"谁正在看"都靠它。 */
export function touchSession(sessionId: string, userId: string): void {
  const now = Date.now();
  db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(now, sessionId);
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, userId);
}

export function revokeSession(id: string): void {
  db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(id);
}

export function revokeUserSessions(userId: string): void {
  db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(userId);
}

/**
 * 踢掉这个人除当前会话外的全部会话。
 *
 * 改密码时用：把自己也踢下线只会让人以为"改密码 = 被登出了"，
 * 但留着其它会话又等于这次修改对已经拿到会话的人毫无作用。
 */
export function revokeOtherSessions(userId: string, keepSessionId?: string): void {
  if (keepSessionId) {
    db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id != ?').run(
      userId,
      keepSessionId,
    );
  } else {
    revokeUserSessions(userId);
  }
}

export interface OnlineEntry {
  user: SessionUser;
  sessionId: string;
  ip: string;
  userAgent: string;
  lastActive: number;
  since: number;
  /** 最近在看哪个页面 */
  currentView: string;
}

/**
 * 当前在线的人。
 *
 * "在线"= 最近 90 秒内有过活动。前端每 30 秒心跳一次，留三倍余量避免网络抖动
 * 把人误判成离线。
 */
export function listOnline(windowMs = 90_000): OnlineEntry[] {
  const since = Date.now() - windowMs;
  const rows = db
    .prepare(
      `SELECT s.*, (
         SELECT target FROM access_log a
         WHERE a.session_id = s.id AND a.action = 'view'
         ORDER BY a.ts DESC LIMIT 1
       ) AS current_view
       FROM sessions s
       WHERE s.revoked = 0 AND s.last_active >= ? AND s.expires_at > ?
       ORDER BY s.last_active DESC`,
    )
    .all(since, Date.now()) as Array<Record<string, unknown>>;

  const out: OnlineEntry[] = [];
  for (const r of rows) {
    const user = getUser(r.user_id as string);
    if (!user) continue;
    out.push({
      user,
      sessionId: r.id as string,
      ip: r.ip as string,
      userAgent: r.user_agent as string,
      lastActive: r.last_active as number,
      since: r.created_at as number,
      currentView: (r.current_view as string) ?? '',
    });
  }
  return out;
}

export function listSessions(userId?: string, limit = 100): SessionRow[] {
  const rows = userId
    ? db
        .prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY last_active DESC LIMIT ?')
        .all(userId, limit)
    : db.prepare('SELECT * FROM sessions ORDER BY last_active DESC LIMIT ?').all(limit);
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    createdAt: r.created_at as number,
    expiresAt: r.expires_at as number,
    lastActive: r.last_active as number,
    ip: r.ip as string,
    userAgent: r.user_agent as string,
  }));
}

/** 清掉过期会话，避免 sessions 表无限增长。 */
export function pruneSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now() - 86_400_000);
}

// ————————————————————————————————————————————————————————
// 审计
// ————————————————————————————————————————————————————————

export interface AuditEntry {
  id: string;
  userId: string;
  sessionId: string;
  action: string;
  target: string;
  detail: string;
  ip: string;
  userAgent: string;
  ts: number;
  user?: SessionUser | null;
}

export function audit(input: {
  userId: string;
  sessionId: string;
  action: string;
  target?: string;
  detail?: string;
  ip: string;
  userAgent: string;
}): void {
  db.prepare(`
    INSERT INTO access_log (id,user_id,session_id,action,target,detail,ip,user_agent,ts)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    randomUUID(),
    input.userId,
    input.sessionId,
    input.action,
    input.target ?? '',
    input.detail ?? '',
    input.ip,
    input.userAgent.slice(0, 400),
    Date.now(),
  );
}

export function listAudit(opts: { limit?: number; userId?: string; action?: string } = {}): AuditEntry[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.userId) {
    where.push('user_id = ?');
    params.push(opts.userId);
  }
  if (opts.action) {
    where.push('action = ?');
    params.push(opts.action);
  }
  const sql = `SELECT * FROM access_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    sessionId: r.session_id as string,
    action: r.action as string,
    target: r.target as string,
    detail: r.detail as string,
    ip: r.ip as string,
    userAgent: r.user_agent as string,
    ts: r.ts as number,
    user: getUser(r.user_id as string),
  }));
}

/** 访客到访汇总，管理员一眼看清"最近有哪些人来看过"。 */
export function visitorSummary(sinceMs = 7 * 86_400_000) {
  const since = Date.now() - sinceMs;
  const rows = db
    .prepare(
      `SELECT u.id, u.kind, u.name, u.login, u.avatar, u.role, u.created_at,
              COUNT(a.id) AS actions,
              MAX(a.ts) AS last_ts,
              MIN(a.ts) AS first_ts,
              COUNT(DISTINCT a.ip) AS ip_count,
              COUNT(DISTINCT a.session_id) AS visits
       FROM users u
       LEFT JOIN access_log a ON a.user_id = u.id AND a.ts >= ?
       GROUP BY u.id
       HAVING actions > 0
       ORDER BY last_ts DESC`,
    )
    .all(since) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    userId: r.id as string,
    kind: r.kind as string,
    name: r.name as string,
    login: r.login as string,
    avatar: r.avatar as string,
    role: r.role as Role,
    actions: r.actions as number,
    visits: r.visits as number,
    ipCount: r.ip_count as number,
    firstSeen: r.first_ts as number,
    lastSeen: r.last_ts as number,
  }));
}

// ————————————————————————————————————————————————————————
// OAuth
// ————————————————————————————————————————————————————————

/**
 * OAuth 凭据来源有两处，env 优先。
 *
 * 另一处是初始配置通道写进 data/oauth.json 的 —— 那条路存在的意义是让
 * client secret 从浏览器直达服务端，不必经过任何人的剪贴板和日志。
 */
export const githubConfig = (() => {
  const base = {
    clientId: process.env.GITHUB_CLIENT_ID ?? '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    callbackUrl: process.env.GITHUB_CALLBACK_URL ?? '',
  };
  if (base.clientId && base.clientSecret) return base;
  const stored = readStoredOAuth();
  return stored ? { ...base, ...stored } : base;
})();

export function githubEnabled(): boolean {
  return Boolean(githubConfig.clientId && githubConfig.clientSecret);
}

/**
 * OAuth state：防 CSRF。
 *
 * 存在内存里而不是数据库 —— 它只需要活几分钟，且面板重启后进行中的登录本来就该重来。
 */
/** login 是"用 GitHub 进来"，link 是"把 GitHub 绑到当前已登录的账号上"。 */
export type OAuthMode = 'login' | 'link';

interface PendingState {
  createdAt: number;
  redirect: string;
  mode: OAuthMode;
  /** link 模式下发起绑定的人。回调时必须是同一个人，否则拒绝 */
  userId: string;
}

const pendingStates = new Map<string, PendingState>();

export function issueState(redirect = '/', mode: OAuthMode = 'login', userId = ''): string {
  // 顺手清掉过期的，省得再开一个定时器
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of pendingStates) {
    if (v.createdAt < cutoff) pendingStates.delete(k);
  }
  const state = randomBytes(24).toString('base64url');
  pendingStates.set(state, { createdAt: Date.now(), redirect, mode, userId });
  return state;
}

export function consumeState(
  state: string | undefined,
): { ok: boolean; redirect: string; mode: OAuthMode; userId: string } {
  const miss = { ok: false, redirect: '/', mode: 'login' as OAuthMode, userId: '' };
  if (!state) return miss;
  const entry = pendingStates.get(state);
  if (!entry) return miss;
  pendingStates.delete(state);
  if (Date.now() - entry.createdAt > 10 * 60_000) return miss;
  return { ok: true, redirect: entry.redirect, mode: entry.mode, userId: entry.userId };
}

export function githubAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: githubConfig.clientId,
    redirect_uri: githubConfig.callbackUrl,
    scope: 'read:user user:email',
    state,
    allow_signup: 'false',
  });
  return `https://github.com/login/oauth/authorize?${p}`;
}

export async function exchangeGithubCode(code: string): Promise<GithubProfile> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: githubConfig.clientId,
      client_secret: githubConfig.clientSecret,
      code,
      redirect_uri: githubConfig.callbackUrl,
    }),
  });

  const tokenBody = (await tokenRes.json()) as { access_token?: string; error_description?: string };
  if (!tokenBody.access_token) {
    throw new Error(tokenBody.error_description ?? 'GitHub 未返回 access_token');
  }

  const headers = {
    Authorization: `Bearer ${tokenBody.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'sonar-panel',
  };

  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) throw new Error(`拉取 GitHub 用户失败：${userRes.status}`);
  const profile = (await userRes.json()) as GithubProfile;

  // 用户把邮箱设为私密时 /user 不返回，单独取一次主邮箱
  if (!profile.email) {
    try {
      const mailRes = await fetch('https://api.github.com/user/emails', { headers });
      if (mailRes.ok) {
        const mails = (await mailRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
        profile.email = mails.find((m) => m.primary && m.verified)?.email ?? null;
      }
    } catch {
      // 邮箱拿不到不影响登录
    }
  }

  return profile;
}

// ————————————————————————————————————————————————————————
// Cookie
// ————————————————————————————————————————————————————————

export const cookieName = SESSION_COOKIE;

export function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** 常量时间比较，用于校验邀请码之类的短密钥。 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
