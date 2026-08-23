import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { resolveCapabilities, type Capability, type Role } from './permissions.js';
import { readStoredOAuth } from './setup.js';

/**
 * 认证与会话
 *
 * 两种身份：GitHub 登录和访客。**第一个通过 GitHub 登录的人自动成为管理员**，
 * 之后的 GitHub 用户默认是 viewer，要由管理员提权。
 *
 * 访客不需要任何凭据，但会被完整记录（谁、什么时候、看了哪些页面），
 * 管理员能在后台看到访客的实时在线情况。
 */

const SESSION_COOKIE = 'sonar_session';
const SESSION_TTL_MS = 7 * 86_400_000;
const GUEST_TTL_MS = 12 * 3600_000;

export interface SessionUser {
  id: string;
  kind: 'github' | 'guest';
  login: string;
  name: string;
  avatar: string;
  email: string;
  role: Role;
  granted: string[];
  revoked: string[];
  disabled: boolean;
  createdAt: number;
  lastSeen: number;
  note: string;
}

export interface AuthContext {
  user: SessionUser;
  sessionId: string;
  caps: Set<Capability>;
}

// ————————————————————————————————————————————————————————
// 用户
// ————————————————————————————————————————————————————————

function rowToUser(r: Record<string, unknown>): SessionUser {
  return {
    id: r.id as string,
    kind: r.kind as 'github' | 'guest',
    login: r.login as string,
    name: r.name as string,
    avatar: r.avatar as string,
    email: r.email as string,
    role: r.role as Role,
    granted: JSON.parse((r.granted as string) || '[]'),
    revoked: JSON.parse((r.revoked as string) || '[]'),
    disabled: Number(r.disabled) === 1,
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
    .prepare("SELECT * FROM users ORDER BY (kind = 'github') DESC, last_seen DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToUser);
}

/** 有没有人当过管理员 —— 决定下一个 GitHub 登录者是不是首任管理员。 */
export function hasAnyAdmin(): boolean {
  const r = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as {
    n: number;
  };
  return r.n > 0;
}

export interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

/**
 * GitHub 登录后落库。
 *
 * 首个登录者拿 admin —— 这是典型的"首次安装即所有者"模式。判定和写入必须在
 * 同一个事务里，否则两个人同时首次登录会各自看到"还没有管理员"，双双成为 admin。
 */
export function upsertGithubUser(profile: GithubProfile): { user: SessionUser; firstAdmin: boolean } {
  let firstAdmin = false;

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT * FROM users WHERE github_id = ?').get(profile.id) as
      | Record<string, unknown>
      | undefined;

    const now = Date.now();
    const name = profile.name ?? profile.login;

    if (existing) {
      db.prepare(
        'UPDATE users SET login=?, name=?, avatar=?, email=?, last_seen=? WHERE github_id=?',
      ).run(profile.login, name, profile.avatar_url, profile.email ?? '', now, profile.id);
    } else {
      firstAdmin = !hasAnyAdmin();
      db.prepare(`
        INSERT INTO users (id,kind,github_id,login,name,avatar,email,role,granted,revoked,note,disabled,created_at,last_seen)
        VALUES (?,?,?,?,?,?,?,?,'[]','[]','',0,?,?)
      `).run(
        `gh:${profile.id}`,
        'github',
        profile.id,
        profile.login,
        name,
        profile.avatar_url,
        profile.email ?? '',
        firstAdmin ? 'admin' : 'viewer',
        now,
        now,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(profile.id) as Record<
    string,
    unknown
  >;
  return { user: rowToUser(user), firstAdmin };
}

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
  patch: { role?: Role; granted?: string[]; revoked?: string[]; disabled?: boolean; note?: string },
): SessionUser | null {
  const user = getUser(id);
  if (!user) return null;

  const next = {
    role: patch.role ?? user.role,
    granted: JSON.stringify(patch.granted ?? user.granted),
    revoked: JSON.stringify(patch.revoked ?? user.revoked),
    disabled: (patch.disabled ?? user.disabled) ? 1 : 0,
    note: patch.note ?? user.note,
  };

  db.prepare('UPDATE users SET role=?, granted=?, revoked=?, disabled=?, note=? WHERE id=?').run(
    next.role, next.granted, next.revoked, next.disabled, next.note, id,
  );

  // 停用账号要立刻踢掉它所有的会话，否则已登录的窗口还能继续用
  if (next.disabled === 1) revokeUserSessions(id);

  return getUser(id);
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

  return {
    user,
    sessionId: row.id as string,
    caps: resolveCapabilities(user.role, user.granted, user.revoked),
  };
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
const pendingStates = new Map<string, { createdAt: number; redirect: string }>();

export function issueState(redirect = '/'): string {
  // 顺手清掉过期的，省得再开一个定时器
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of pendingStates) {
    if (v.createdAt < cutoff) pendingStates.delete(k);
  }
  const state = randomBytes(24).toString('base64url');
  pendingStates.set(state, { createdAt: Date.now(), redirect });
  return state;
}

export function consumeState(state: string | undefined): { ok: boolean; redirect: string } {
  if (!state) return { ok: false, redirect: '/' };
  const entry = pendingStates.get(state);
  if (!entry) return { ok: false, redirect: '/' };
  pendingStates.delete(state);
  if (Date.now() - entry.createdAt > 10 * 60_000) return { ok: false, redirect: '/' };
  return { ok: true, redirect: entry.redirect };
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
