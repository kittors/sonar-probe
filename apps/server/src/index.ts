import { consume, retryAfter } from './ratelimit.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { WebSocket } from 'ws';

import { db, pruneAuditLog, pruneMetrics, pruneTrafficDetail, purgeSimulatedData } from './db.js';
import { refreshRates, refreshRatesIfStale, ratesPayload } from './rates.js';
import {
  COMMON_TIMEZONES,
  CURRENCIES,
  CURRENCY_META,
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
  type Settings,
} from './settings.js';
import { seedDatabase, tick, ensureRuntimeLoaded } from './sim/simulator.js';
import {
  createRule,
  expireRules,
  listRules,
  loadAllowlist,
  preflight,
  removeRule,
  unblockCommands,
} from './firewall.js';
import {
  getDailyTraffic,
  getFleetSummary,
  getMetricHistory,
  getNodeState,
  getPeerTraffic,
  getServiceTraffic,
  listEvents,
  listNodeStates,
  logEvent,
  nodeCycleRange,
  recentDays,
  updateNode,
  type DayRange,
  type NodePatch,
} from './store.js';
import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  checkEscalation,
  groupedCapabilities,
  type Capability,
  type Role,
} from './permissions.js';
import {
  capabilitiesFor,
  createRole,
  deleteRole,
  ensureSystemRoles,
  getRole,
  listRoles,
  roleUsage,
  RoleError,
  updateRole,
} from './roles.js';
import {
  activeAdminCount,
  audit,
  authenticatePassword,
  AuthError,
  changePassword,
  consumeState,
  cookieName,
  cookieOptions,
  createGuest,
  createSession,
  createUser,
  deleteUser,
  ensureRootAdmin,
  exchangeGithubCode,
  githubAuthorizeUrl,
  githubConfig,
  githubEnabled,
  githubSignupEnabled,
  hasAnyAdmin,
  issueState,
  linkGithub,
  listAudit,
  listOnline,
  listSessions,
  listUsers,
  loadSession,
  pruneSessions,
  resetPassword,
  revokeSession,
  revokeUserSessions,
  touchSession,
  updateUser,
  upsertGithubUser,
  userIdentities,
  visitorSummary,
  type AuthContext,
} from './auth.js';
import {
  IdentityError,
  listIdentities,
  migrateLegacyGithubIdentities,
  unbindIdentity,
  type Provider,
} from './identities.js';
import {
  SshKeyError,
  grantCommands,
  grantComment,
  parsePublicKey,
  preflightRevoke,
  preflightGrant,
  revokeCommands,
} from './ssh.js';
import { configSnippet, knownHostsEntries } from './ssh-config.js';
import {
  SshStoreError,
  addKey,
  approveGrant,
  createGrant,
  deleteKey,
  ensureEndpoint,
  expireGrants,
  getEndpoint,
  getGrant,
  getKey,
  grantsOfUser,
  hostFacts,
  ingestSshFacts,
  listDrift,
  listEndpoints,
  listGrants,
  listKeys,
  markGrantRevoked,
  markGrantFailed,
  rejectGrant,
  todayStamp,
  updateEndpoint,
  updateKey,
  type SshFactsInput,
} from './ssh-store.js';
import {
  ack as ackCommand,
  claimFor,
  enqueue,
  listCommands,
  pruneCommands,
} from './commands.js';
import {
  agentIngestEnabled,
  agentNodeIds,
  agentTokenValid,
  ingestReport,
  issueNodeSecret,
  nodeSecretValid,
  registerAgentNode,
  type AgentNodeInfo,
  type AgentReport,
} from './agent-ingest.js';
import {
  createTrafficRule,
  deleteTrafficRule,
  evaluateTrafficRules,
  listTrafficRules,
  markFired,
  setTrafficRuleEnabled,
  trafficLedger,
  type RuleCompare,
  type RuleScope,
} from './traffic-rules.js';
import { ensureSetupToken, setupTokenValid, writeOAuthCredentials } from './setup.js';
import type { BlockMode, NodeState, PublicSettings, ServerMessage } from './types.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const TICK_SECONDS = Number(process.env.SONAR_TICK ?? 2);
/** 反代后面跑 HTTPS 时要置 1，cookie 才会带 Secure。 */
const SECURE_COOKIE = process.env.SONAR_SECURE_COOKIE === '1';
const PUBLIC_URL = process.env.SONAR_PUBLIC_URL ?? `http://localhost:5273`;

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const app = Fastify({
  // 反代后面要靠 X-Forwarded-For 拿真实来访 IP，否则审计里全是网关地址
  trustProxy: true,
  logger: {
    level: process.env.LOG_LEVEL ?? 'warn',
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  },
});

/*
 * CORS：默认只放同源。
 *
 * 原来是 `origin: true` —— 反射任意 Origin，还配 credentials: true。
 * 意思是任何网站都能带着用户的会话 cookie 来调这些接口并读走响应。
 *
 * 现在没被利用是因为 cookie 是 SameSite=lax，跨站 fetch 根本带不上 cookie。
 * 但那样一来安全就同时压在两个设定上，将来任何一处改动（比如为了嵌入场景把
 * SameSite 放成 None）都会立刻变成数据泄露。面板和 API 本来就同源部署，
 * 跨域只有本地开发才需要。
 */
const CORS_ORIGINS = (process.env.SONAR_CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

await app.register(cors, {
  origin: (origin, cb) => {
    // 同源请求不带 Origin 头
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    // 开发时前端跑在 5173，和后端不同端口
    if (
      process.env.NODE_ENV !== 'production' &&
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    ) {
      return cb(null, true);
    }
    cb(null, false);
  },
  credentials: true,
});
await app.register(cookie);
await app.register(websocket);

/*
 * 安全响应头。
 *
 * 放在应用层而不是 nginx：这样自部署的人不用照着文档抄一遍 nginx 配置，
 * 也不会因为换了反代（Caddy、Traefik）就把这些头弄丢。
 */
app.addHook('onSend', async (_req, reply) => {
  // 点击劫持：面板上有「封禁」这种破坏性操作，被套进 iframe 诱导点击的代价很高
  reply.header('X-Frame-Options', 'DENY');
  // 别让浏览器去猜 MIME —— 猜错就可能把上传/返回的内容当脚本执行
  reply.header('X-Content-Type-Options', 'nosniff');
  // 跳到外部链接（比如服务商控制台）时不要把完整路径带过去，那里面有机器 ID
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('X-XSS-Protection', '0');

  /*
   * CSP。
   *
   * style-src 不得不放 'unsafe-inline'：React 的 style 属性和本项目大量的行内样式
   * 都算内联样式。代价是 CSS 注入防不住，但前端没有任何 innerHTML/dangerouslySetInnerHTML
   * 的写法，注入点本身不存在。
   *
   * frame-ancestors 是 X-Frame-Options 的现代版，两个都发是为了照顾老浏览器。
   */
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      // GitHub 头像来自 avatars.githubusercontent.com
      "img-src 'self' data: https://avatars.githubusercontent.com",
      "font-src 'self'",
      // WebSocket 走同源，ws/wss 要显式列出
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  );
});

/**
 * 生产环境由面板自己托管前端。
 *
 * 走 cloudflared 隧道时前面没有 nginx，静态文件得有人发。
 * 开发环境不注册 —— 那时是 vite dev server 在服务，注册了反而会抢路由。
 */
const STATIC_DIR = process.env.SONAR_STATIC_DIR
  ? resolve(process.env.SONAR_STATIC_DIR)
  : resolve(process.cwd(), '../dashboard/dist');
const SERVE_STATIC = existsSync(resolve(STATIC_DIR, 'index.html'));

if (SERVE_STATIC) {
  await app.register(fastifyStatic, { root: STATIC_DIR, prefix: '/' });

  // SPA 回退：/node/xxx、/admin 这些前端路由刷新时会打到服务端，
  // 得把 index.html 发回去让前端路由接管。但 /api 和 /ws 必须照常 404，
  // 否则接口写错路径会拿到一坨 HTML，排查起来很费劲。
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: '接口不存在' });
    }
    return reply.sendFile('index.html');
  });
}

// ————————————————————————————————————————————————————————
// 认证中间件
// ————————————————————————————————————————————————————————

/**
 * 未登录时的身份。
 *
 * 不再一刀切拒绝：概览页是公开状态页，谁都能看。
 * 拦不拦得住由每个路由的 requireCap 决定 —— anonymous 默认只有 node:list，
 * 所以详情、流量归因、封禁这些自然就进不去。
 *
 * caps 每次现算而不是模块加载时算死一份 —— anonymous 现在是 roles 表里的一行，
 * 管理员随时可以改"公开状态页显示到哪一层"，缓存住的话要重启才生效。
 * 角色表整份在内存里（roles.ts），这一次查是 Map 取值，不碰数据库。
 */
function anonymousContext(): AuthContext {
  return {
    user: {
      id: '',
      kind: 'guest',
      username: '',
      login: '',
      name: '未登录访客',
      avatar: '',
      email: '',
      role: 'anonymous',
      granted: [],
      revoked: [],
      disabled: false,
      isRoot: false,
      mustChangePassword: false,
      createdAt: 0,
      lastSeen: 0,
      note: '',
    },
    sessionId: '',
    caps: capabilitiesFor('anonymous'),
  };
}

app.decorateRequest('auth', null);

app.addHook('onRequest', async (req) => {
  const session = loadSession(req.cookies[cookieName]);
  if (session) {
    touchSession(session.sessionId, session.user.id);
    req.auth = session;
  } else {
    req.auth = anonymousContext();
  }
});

function ip(req: FastifyRequest): string {
  const raw = req.ip ?? '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function ua(req: FastifyRequest): string {
  return String(req.headers['user-agent'] ?? '');
}

/**
 * 把能力点列成人话。
 *
 * 提权被拒时给的是给人看的解释，不该甩一串 `node:full_ip` 这样的内部标识 ——
 * 那是代码里的名字，界面上从来没出现过，收到的人无从对照。
 */
function listCaps(caps: readonly string[], max = 3): string {
  const names = caps.map((c) => CAPABILITIES[c as Capability]?.label ?? c);
  return names.slice(0, max).join('、') + (names.length > max ? ` 等 ${names.length} 项` : '');
}

/** 被提权守卫拦住时，告诉人下一步该找谁要什么，而不是只说"不行"。 */
const ESCALATE_HINT = `确实需要这么做的话，请管理员授予「${CAPABILITIES['user:escalate'].label}」。`;

/**
 * 能力守卫。
 *
 * 前端也会按能力隐藏按钮，但那只是不碍眼 —— 真正拦住越权请求的是这里。
 * 任何有后果的接口都必须挂上它。
 */
function requireCap(cap: Capability) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.auth?.caps.has(cap)) return;

    /*
     * 权限被降到匿名级，只是因为初始密码还没改（见 auth.ts 的 loadSession）。
     *
     * 这一条必须先于下面那句"没有权限"回 —— 否则一个刚被创建的管理员会看到
     * "你没有权限执行这个操作"，然后去找人要权限，而他缺的根本不是权限。
     */
    if (req.auth?.sessionId && req.auth.user.mustChangePassword) {
      return reply.code(403).send({
        error: '请先修改初始密码，之后权限才会生效',
        code: 'password_change_required',
        required: cap,
      });
    }

    const anonymous = !req.auth?.sessionId;

    // 匿名和"登录了但权限不够"要分开回，前端据此决定是引导登录还是让人去找管理员
    if (anonymous) {
      return reply.code(401).send({
        error: '这一步需要先登录',
        code: 'unauthenticated',
        required: cap,
      });
    }

    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'denied',
      target: cap,
      detail: req.url,
      ip: ip(req),
      userAgent: ua(req),
    });
    return reply.code(403).send({
      error: '没有权限执行这个操作',
      code: 'forbidden',
      required: cap,
    });
  };
}

// ————————————————————————————————————————————————————————
// 数据脱敏
// ————————————————————————————————————————————————————————

function maskIp(addr: string): string {
  if (addr.includes(':')) {
    const seg = addr.split(':');
    return seg.slice(0, 2).join(':') + ':****';
  }
  const p = addr.split('.');
  if (p.length !== 4) return addr;
  return `${p[0]}.${p[1]}.*.*`;
}

/**
 * 按权限裁剪节点数据。
 *
 * 没有 node:full_ip 的人不该拿到完整地址 —— 前端打码不算数，
 * 只要接口返回了原值，打开开发者工具就能看到。
 */
function sanitizeNode(node: NodeState, caps: Set<Capability>): NodeState {
  const out = caps.has('node:full_ip') ? { ...node } : { ...node, ip: maskIp(node.ip) };
  if (!caps.has('node:hardware')) {
    out.cpuModel = '';
    out.kernel = '';
    out.os = out.os.split(' ')[0] ?? out.os;
  }
  return out;
}

function sanitizeNodes(nodes: NodeState[], caps: Set<Capability>): NodeState[] {
  return nodes.map((n) => sanitizeNode(n, caps));
}

/**
 * 展示口径。REST 和 WebSocket 共用同一份构造 —— 两处各拼一遍迟早会分叉，
 * 而分叉的表现是"刷新一下数字就变了"，极难被认出是同步问题。
 */
function publicSettings(): PublicSettings {
  const s = getSettings();
  const r = ratesPayload();
  return {
    panelName: s.panelName,
    panelTagline: s.panelTagline,
    displayCurrency: s.displayCurrency,
    costIncludeExpired: s.costIncludeExpired,
    byteBase: s.byteBase,
    binaryUnitLabels: s.binaryUnitLabels,
    trafficDirection: s.trafficDirection,
    timezone: s.timezone,
    expiryWarnDays: s.expiryWarnDays,
    quotaWarnPercent: s.quotaWarnPercent,
    rates: r.rates,
    ratesMeta: {
      fetchedAt: r.fetchedAt,
      source: r.source,
      usingFallback: r.usingFallback,
      stale: r.stale,
    },
  };
}

// ————————————————————————————————————————————————————————
// WebSocket
// ————————————————————————————————————————————————————————

/** 每条连接记住自己的权限，推送前按权限裁剪。 */
const clients = new Map<WebSocket, AuthContext>();

function broadcast(build: (caps: Set<Capability>) => ServerMessage): void {
  for (const [ws, ctx] of clients) {
    if (ws.readyState !== 1) {
      clients.delete(ws);
      continue;
    }
    ws.send(JSON.stringify(build(ctx.caps)));
  }
}

/** 只发给有某项能力的人，用于管理员专属的推送。 */
function broadcastTo(cap: Capability, msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const [ws, ctx] of clients) {
    if (ws.readyState !== 1) {
      clients.delete(ws);
      continue;
    }
    if (ctx.caps.has(cap)) ws.send(payload);
  }
}

/**
 * 权限变更后，重算受影响连接的能力集并通知前端刷新。
 *
 * 两件事都必须做，少一件都是缺陷：
 *
 *   **重算 ctx** —— clients 里存的是连接建立那一刻的权限快照。不重算的话，
 *   一个刚被收走 node:full_ip 的人，他那条 WebSocket 会继续按旧权限推送
 *   未打码的地址，直到他自己刷新页面为止。降权在他重连之前是不生效的。
 *
 *   **通知前端** —— 前端的按钮显隐来自 /api/me 的那一份 capabilities，
 *   不告诉它就只有下次整页加载才对得上。
 *
 * match 用会话去匹配而不是照着旧 ctx 判断：角色被改名、用户被换角色之后，
 * 旧 ctx 里的 role 已经不能代表现在的归属了。
 */
function refreshClients(match: (ctx: AuthContext) => boolean): void {
  const payload = JSON.stringify({ type: 'auth-refresh' } satisfies ServerMessage);
  for (const [ws, ctx] of clients) {
    if (ws.readyState !== 1) {
      clients.delete(ws);
      continue;
    }
    if (!match(ctx)) continue;

    // 会话可能已经在这次变更里被吊销（比如停用账号），那就退回匿名权限
    const fresh = ctx.sessionId ? loadSession(ctx.sessionId) : null;
    clients.set(ws, fresh ?? anonymousContext());
    ws.send(payload);
  }
}

/** 某个角色的能力集变了 —— 所有挂着它的人都要重算。 */
function pushAuthRefresh(roleId: string): void {
  refreshClients((ctx) => ctx.user.role === roleId);
}

/** 某个人的角色或个人授予变了。 */
function pushAuthRefreshTo(userId: string): void {
  refreshClients((ctx) => ctx.user.id === userId);
}

app.get('/ws', { websocket: true }, (socket, req) => {
  // 匿名也能连：概览页是公开状态页，实时刷新对未登录的人一样生效。
  // 推什么由 caps 决定，anonymous 拿到的节点数据是脱敏过的。
  const ctx = loadSession(req.cookies[cookieName]) ?? anonymousContext();

  clients.set(socket, ctx);
  // 口径先于数据发出去：晚一步的话客户端会先拿旧口径渲染一次快照，
  // 再因为设置到位而整页重排，那一下跳变正是缓存机制想避免的
  socket.send(JSON.stringify({ type: 'settings', settings: publicSettings() }));
  socket.send(
    JSON.stringify({
      type: 'snapshot',
      nodes: sanitizeNodes(listNodeStates(), ctx.caps),
      ts: Date.now(),
    }),
  );

  socket.on('message', (raw) => {
    // 前端每 30 秒发一次心跳，附带当前页面，用于在线列表的"正在看"
    try {
      const msg = JSON.parse(String(raw)) as { type?: string; view?: string };
      if (msg.type === 'ping') {
        // 匿名没有会话可刷、也没有身份可审计，心跳只用来维持连接
        if (!ctx.sessionId) return;
        touchSession(ctx.sessionId, ctx.user.id);
        if (msg.view) {
          audit({
            userId: ctx.user.id,
            sessionId: ctx.sessionId,
            action: 'view',
            target: msg.view,
            ip: ip(req),
            userAgent: ua(req),
          });
        }
      }
    } catch {
      // 心跳解析失败无所谓，丢掉即可
    }
  });

  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

// ————————————————————————————————————————————————————————
// 认证路由
// ————————————————————————————————————————————————————————

app.get('/api/auth/config', async () => ({
  github: githubEnabled(),
  githubSignup: githubSignupEnabled(),
  // 密码登录不需要任何外部配置，永远可用 —— 它是 GitHub 没配好时的唯一入口
  password: true,
  needsBootstrap: !hasAnyAdmin(),
  guestEnabled: process.env.SONAR_DISABLE_GUEST !== '1',
}));

/**
 * 用户名密码登录。
 *
 * 限流按 IP 和账号两个维度分别算：
 *   只按 IP 拦不住撞库（一个 IP 换着账号试），
 *   只按账号拦不住分布式爆破，但能防住"针对管理员这一个账号"的定点爆破 ——
 *   而后者恰恰是自托管面板最常见的攻击形态。
 */
app.post<{ Body: { username?: string; password?: string } }>(
  '/api/auth/login',
  async (req, reply) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');

    if (!consume(`login:ip:${ip(req)}`, 10, 600_000)) {
      return reply
        .code(429)
        .header('Retry-After', String(retryAfter(`login:ip:${ip(req)}`, 600_000)))
        .send({ error: '尝试过于频繁，请十分钟后再试' });
    }
    if (username && !consume(`login:user:${username.toLowerCase()}`, 5, 600_000)) {
      return reply
        .code(429)
        .header('Retry-After', String(retryAfter(`login:user:${username.toLowerCase()}`, 600_000)))
        .send({ error: '这个账号尝试过于频繁，请十分钟后再试' });
    }

    if (!username || !password) {
      return reply.code(400).send({ error: '请填写用户名和密码' });
    }

    let user;
    try {
      user = await authenticatePassword(username, password);
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 401;
      /*
       * 登录失败也要落审计。
       *
       * userId 留空 —— 这时还没有确认身份，把用户猜到的那个名字当成 user_id
       * 写进去，日后查"这个账号做过什么"就会混进一堆不是他做的事。
       * 名字放在 detail 里，够用来看出有人在爆破谁。
       */
      audit({
        userId: '',
        sessionId: '',
        action: 'login.failed',
        target: 'password',
        detail: `用户名 ${username}`,
        ip: ip(req),
        userAgent: ua(req),
      });
      return reply.code(status).send({ error: err instanceof Error ? err.message : '登录失败' });
    }

    const sid = createSession(user.id, ip(req), ua(req));
    audit({
      userId: user.id,
      sessionId: sid,
      action: 'login',
      target: 'password',
      detail: `以 ${getRole(user.role)?.name ?? user.role} 身份登录`,
      ip: ip(req),
      userAgent: ua(req),
    });

    reply.setCookie(cookieName, sid, cookieOptions(SECURE_COOKIE));
    return {
      user: publicUser(user),
      capabilities: [...capabilitiesFor(user.role, user.granted, user.revoked)],
      mustChangePassword: user.mustChangePassword,
    };
  },
);

app.get<{ Querystring: { redirect?: string; mode?: string } }>(
  '/api/auth/github',
  async (req, reply) => {
    if (!githubEnabled()) {
      return reply.code(503).send({ error: 'GitHub 登录未配置，请在服务端设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET' });
    }
    // 绑定模式必须已经登录 —— 否则这条路等价于一个不受 signup 开关约束的注册入口
    const link = req.query.mode === 'link';
    if (link && !req.auth?.sessionId) {
      return reply.code(401).send({ error: '请先登录再绑定 GitHub' });
    }
    const state = issueState(
      req.query.redirect ?? '/',
      link ? 'link' : 'login',
      link ? req.auth!.user.id : '',
    );
    return reply.redirect(githubAuthorizeUrl(state));
  },
);

app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
  '/api/auth/github/callback',
  async (req, reply) => {
    const { code, state, error } = req.query;
    if (error) return reply.redirect(`${PUBLIC_URL}/?login_error=${encodeURIComponent(error)}`);

    const checked = consumeState(state);
    if (!checked.ok) {
      return reply.redirect(`${PUBLIC_URL}/?login_error=state_mismatch`);
    }
    if (!code) return reply.redirect(`${PUBLIC_URL}/?login_error=missing_code`);

    try {
      const profile = await exchangeGithubCode(code);

      // —— 绑定：把这个 GitHub 挂到当前账号上，不新建、不换会话
      if (checked.mode === 'link') {
        /*
         * 发起绑定的人必须还是当前登录的人。
         *
         * state 里存了 userId，回来时和会话比一次。中间换了账号（比如在另一个
         * 标签页登出再登入别人）就拒绝 —— 否则 A 发起的绑定会落到 B 头上，
         * 而 B 从此可以用 A 的 GitHub 登录。
         */
        if (!req.auth?.sessionId || req.auth.user.id !== checked.userId) {
          return reply.redirect(`${PUBLIC_URL}/settings?link_error=session_changed`);
        }
        try {
          linkGithub(checked.userId, profile);
        } catch (err) {
          const msg = err instanceof Error ? err.message : '绑定失败';
          return reply.redirect(`${PUBLIC_URL}/settings?link_error=${encodeURIComponent(msg)}`);
        }
        audit({
          userId: checked.userId,
          sessionId: req.auth.sessionId,
          action: 'identity.link',
          target: 'github',
          detail: profile.login,
          ip: ip(req),
          userAgent: ua(req),
        });
        return reply.redirect(`${PUBLIC_URL}/settings?linked=github`);
      }

      // —— 登录
      const { user, created } = upsertGithubUser(profile);

      if (user.disabled) {
        return reply.redirect(`${PUBLIC_URL}/?login_error=disabled`);
      }

      const sid = createSession(user.id, ip(req), ua(req));
      audit({
        userId: user.id,
        sessionId: sid,
        action: 'login',
        target: 'github',
        detail: created
          ? '首次通过 GitHub 登录，已创建账号'
          : `以 ${getRole(user.role)?.name ?? user.role} 身份登录`,
        ip: ip(req),
        userAgent: ua(req),
      });
      if (created) {
        logEvent(null, 'info', 'auth', `${user.login} 首次通过 GitHub 登录，已创建账号（${getRole(user.role)?.name ?? user.role}）`);
      }

      reply.setCookie(cookieName, sid, cookieOptions(SECURE_COOKIE));
      return reply.redirect(`${PUBLIC_URL}${checked.redirect}`);
    } catch (err) {
      // 未授权的 GitHub 账号（关掉了自助注册）要给出可读的理由，不能一律 oauth_failed
      if (err instanceof AuthError) {
        return reply.redirect(`${PUBLIC_URL}/?login_error=${encodeURIComponent(err.message)}`);
      }
      app.log.error({ err }, 'github oauth failed');
      return reply.redirect(`${PUBLIC_URL}/?login_error=oauth_failed`);
    }
  },
);

app.post<{ Body: { label?: string } }>('/api/auth/guest', async (req, reply) => {
  if (process.env.SONAR_DISABLE_GUEST === '1') {
    return reply.code(403).send({ error: '访客登录已关闭' });
  }
  /*
   * 限流：一个 IP 十分钟内最多 5 个访客身份。
   *
   * 这个接口一次调用就落一个用户加一个会话，不拦的话几分钟能把表灌满。
   * 5 次足够正常人换设备或清 Cookie 重进，脚本刷号则会立刻撞墙。
   */
  if (!consume(`guest:${ip(req)}`, 5, 600_000)) {
    return reply
      .code(429)
      .header('Retry-After', String(retryAfter(`guest:${ip(req)}`, 600_000)))
      .send({ error: '访客登录过于频繁，请稍后再试' });
  }
  const user = createGuest(req.body?.label);
  const sid = createSession(user.id, ip(req), ua(req));
  audit({
    userId: user.id,
    sessionId: sid,
    action: 'login',
    target: 'guest',
    detail: req.body?.label ? `自称「${req.body.label}」` : '未留名',
    ip: ip(req),
    userAgent: ua(req),
  });
  logEvent(null, 'info', 'auth', `访客 ${user.name} 进入面板`);

  reply.setCookie(cookieName, sid, cookieOptions(SECURE_COOKIE));
  return { user: publicUser(user), capabilities: [...capabilitiesFor(user.role, user.granted, user.revoked)] };
});

app.post('/api/auth/logout', async (req, reply) => {
  if (req.auth) {
    audit({
      userId: req.auth.user.id,
      sessionId: req.auth.sessionId,
      action: 'logout',
      ip: ip(req),
      userAgent: ua(req),
    });
    revokeSession(req.auth.sessionId);
  }
  reply.clearCookie(cookieName, { path: '/' });
  return { ok: true };
});

function publicUser(u: {
  id: string; kind: string; username: string; login: string; name: string; avatar: string;
  role: Role; createdAt: number; lastSeen: number; note: string; email: string; disabled: boolean;
  isRoot: boolean; mustChangePassword: boolean;
}) {
  return {
    id: u.id,
    kind: u.kind,
    username: u.username,
    login: u.login,
    name: u.name,
    avatar: u.avatar,
    email: u.email,
    role: u.role,
    // 角色可能已被删除，回落到 id 而不是 undefined —— 界面上显示一个原始 id
    // 至少还能看出问题在哪，显示空白只会让人以为这个人没有角色
    roleLabel: getRole(u.role)?.name ?? u.role,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
    note: u.note,
    disabled: u.disabled,
    isRoot: u.isRoot,
    mustChangePassword: u.mustChangePassword,
  };
}

app.get('/api/me', async (req, reply) => {
  // 匿名也返回 200，但 user 为 null —— 前端要拿 capabilities 决定概览页能显示到哪一层，
  // 直接回 401 的话前端就得为"未登录"再单开一条取权限的路
  if (!req.auth?.sessionId) {
    return reply.send({
      user: null,
      capabilities: [...anonymousContext().caps],
      identities: [],
      sessionId: null,
    });
  }
  return reply.send({
    user: publicUser(req.auth.user),
    capabilities: [...req.auth.caps],
    identities: userIdentities(req.auth.user.id),
    sessionId: req.auth.sessionId,
  });
});

// ————————————————————————————————————————————————————————
// 个人设置
// ————————————————————————————————————————————————————————

/**
 * 这一组接口不挂 requireCap，只要求"是登录着的正式用户"。
 *
 * 改自己的密码、绑自己的 GitHub 不该需要任何被授予的能力 —— 那会导致一个
 * 被收走全部权限的人连密码都改不了。访客排除在外：那是临时身份，没有可维护的凭据。
 */
function requireAccount(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.auth?.sessionId) {
    reply.code(401).send({ error: '请先登录', code: 'unauthenticated' });
    return false;
  }
  if (req.auth.user.kind === 'guest') {
    reply.code(403).send({ error: '访客账号没有可维护的登录凭据' });
    return false;
  }
  return true;
}

app.patch<{ Body: { name?: string; email?: string } }>('/api/me', async (req, reply) => {
  if (!requireAccount(req, reply)) return;
  const updated = updateUser(req.auth!.user.id, {
    name: req.body?.name === undefined ? undefined : String(req.body.name).slice(0, 40),
    email: req.body?.email === undefined ? undefined : String(req.body.email).slice(0, 120),
  });
  return { user: publicUser(updated!) };
});

app.post<{ Body: { current?: string; next?: string } }>(
  '/api/me/password',
  async (req, reply) => {
    if (!requireAccount(req, reply)) return;

    // 改密要过 scrypt 两到三次，是个不便宜的操作，别让它变成放大器
    if (!consume(`pw:${req.auth!.user.id}`, 10, 600_000)) {
      return reply.code(429).send({ error: '操作过于频繁，请稍后再试' });
    }

    try {
      await changePassword(
        req.auth!.user.id,
        { current: req.body?.current, next: String(req.body?.next ?? '') },
        // 留着自己当前这条会话，其余全部踢掉
        req.auth!.sessionId,
      );
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : '修改失败' });
    }

    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'password.change',
      ip: ip(req),
      userAgent: ua(req),
    });
    return { ok: true };
  },
);

app.get('/api/me/identities', async (req, reply) => {
  if (!requireAccount(req, reply)) return;
  return { identities: userIdentities(req.auth!.user.id) };
});

app.delete<{ Params: { provider: string } }>(
  '/api/me/identities/:provider',
  async (req, reply) => {
    if (!requireAccount(req, reply)) return;
    const provider = req.params.provider as Provider;
    if (provider !== 'github' && provider !== 'password') {
      return reply.code(400).send({ error: '不认识的登录方式' });
    }
    try {
      unbindIdentity(req.auth!.user.id, provider);
    } catch (err) {
      const status = err instanceof IdentityError ? err.status : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : '解绑失败' });
    }
    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'identity.unlink',
      target: provider,
      ip: ip(req),
      userAgent: ua(req),
    });
    return { ok: true, identities: userIdentities(req.auth!.user.id) };
  },
);

// ————————————————————————————————————————————————————————
// 业务路由
// ————————————————————————————————————————————————————————

app.get('/api/summary', { preHandler: requireCap('node:list') }, async () => getFleetSummary());

app.get('/api/nodes', { preHandler: requireCap('node:list') }, async (req) =>
  sanitizeNodes(listNodeStates(), req.auth!.caps),
);

app.get<{ Params: { id: string } }>(
  '/api/nodes/:id',
  { preHandler: requireCap('node:detail') },
  async (req, reply) => {
    const node = getNodeState(req.params.id);
    if (!node) return reply.code(404).send({ error: '节点不存在' });
    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'view',
      target: `node:${node.id}`,
      detail: node.name,
      ip: ip(req),
      userAgent: ua(req),
    });
    return sanitizeNode(node, req.auth!.caps);
  },
);

app.patch<{ Params: { id: string }; Body: NodePatch }>(
  '/api/nodes/:id',
  { preHandler: requireCap('node:manage') },
  async (req, reply) => {
    const updated = updateNode(req.params.id, req.body ?? {});
    if (!updated) return reply.code(404).send({ error: '节点不存在' });

    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'node.update',
      target: req.params.id,
      detail: Object.keys(req.body ?? {}).join(', '),
      ip: ip(req),
      userAgent: ua(req),
    });

    // 改完立刻推给所有人，不用等下一拍
    const nodes = listNodeStates();
    broadcast((caps) => ({ type: 'tick', nodes: sanitizeNodes(nodes, caps), ts: Date.now() }));

    return sanitizeNode(updated, req.auth!.caps);
  },
);

const RANGES: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': 3600_000,
  '6h': 6 * 3600_000,
  '24h': 24 * 3600_000,
};

app.get<{ Params: { id: string }; Querystring: { range?: string } }>(
  '/api/nodes/:id/metrics',
  { preHandler: requireCap('node:detail') },
  async (req) => {
    const span = RANGES[req.query.range ?? '1h'] ?? RANGES['1h']!;
    return getMetricHistory(req.params.id, span);
  },
);

/*
 * 流量查询的时间范围。
 *
 * 三个流量接口共用一份解析，因为界面上它们本来就该跟着同一个区间走 ——
 * 「这段时间走了 338 GB，其中 nginx 吃掉 210 GB」这句话要成立，
 * 两个数字必须来自同一个区间，各查各的只会让人对着两个口径找原因。
 *
 * from/to 都是 YYYY-MM-DD 闭区间。省略时回退到 days（保持老前端能用），
 * 两者都没有就用默认天数。
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 最长可查两年。不设上限的话，一个 from=0001-01-01 就能让 SQLite 扫全表 */
const MAX_RANGE_DAYS = 730;

function parseRange(
  nodeId: string,
  q: { from?: string; to?: string; days?: string },
  defaultDays: number,
): DayRange {
  if (q.from === 'cycle') return nodeCycleRange(nodeId);
  if (!DAY_RE.test(q.from ?? '') || !DAY_RE.test(q.to ?? '')) {
    return recentDays(clampInt(q.days, defaultDays, 1, 366));
  }
  // 传反了就换过来，比返回空数组让人对着空图表猜要好
  let [from, to] = [q.from!, q.to!].sort() as [string, string];
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(span)) return recentDays(defaultDays);
  if (span > MAX_RANGE_DAYS) {
    from = new Date(Date.parse(`${to}T00:00:00Z`) - MAX_RANGE_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  return { from, to };
}

type RangeQuery = { from?: string; to?: string; days?: string };

app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
  '/api/nodes/:id/traffic/daily',
  { preHandler: requireCap('traffic:daily') },
  async (req) => getDailyTraffic(req.params.id, parseRange(req.params.id, req.query, 30)),
);

app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
  '/api/nodes/:id/traffic/services',
  { preHandler: requireCap('traffic:services') },
  async (req) => getServiceTraffic(req.params.id, parseRange(req.params.id, req.query, 7)),
);

app.get<{ Params: { id: string }; Querystring: RangeQuery & { limit?: string } }>(
  '/api/nodes/:id/traffic/peers',
  { preHandler: requireCap('traffic:peers') },
  async (req) => {
    const peers = getPeerTraffic(
      req.params.id,
      parseRange(req.params.id, req.query, 7),
      clampInt(req.query.limit, 50, 1, 200),
    );
    // 对端地址同样受 full_ip 管：看不到完整地址的人也没法照着去封
    if (req.auth!.caps.has('node:full_ip')) return peers;
    return peers.map((p) => ({ ...p, ip: maskIp(p.ip) }));
  },
);

app.get<{ Querystring: { limit?: string; node?: string } }>(
  '/api/events',
  { preHandler: requireCap('node:list') },
  async (req) => listEvents(clampInt(req.query.limit, 60, 1, 200), req.query.node),
);

// —— 封禁

app.get('/api/blocks', { preHandler: requireCap('block:view') }, async () => listRules());

app.get<{ Params: { id: string } }>(
  '/api/nodes/:id/blocks',
  { preHandler: requireCap('block:view') },
  async (req) => listRules(req.params.id),
);

interface BlockBody {
  target?: string;
  reason?: string;
  mode?: BlockMode;
  ttlSeconds?: number;
  confirm?: string;
}

app.post<{ Params: { id: string }; Body: BlockBody }>(
  '/api/nodes/:id/blocks/preflight',
  { preHandler: requireCap('block:preflight') },
  async (req, reply) => {
    const node = getNodeState(req.params.id);
    if (!node) return reply.code(404).send({ error: '节点不存在' });
    const target = (req.body?.target ?? '').trim();
    if (!target) return reply.code(400).send({ error: '缺少 target' });

    return preflight(target, req.body?.mode ?? 'dry-run', req.body?.ttlSeconds ?? 3600, {
      nodeIp: node.ip,
      operatorIp: ip(req),
      panelIp: process.env.SONAR_PANEL_IP,
      allowlist: loadAllowlist(),
    });
  },
);

app.post<{ Params: { id: string }; Body: BlockBody }>(
  '/api/nodes/:id/blocks',
  { preHandler: requireCap('block:dryrun') },
  async (req, reply) => {
    const node = getNodeState(req.params.id);
    if (!node) return reply.code(404).send({ error: '节点不存在' });

    const target = (req.body?.target ?? '').trim();
    const mode: BlockMode = req.body?.mode === 'enforced' ? 'enforced' : 'dry-run';
    const ttlSeconds = Math.max(0, Math.floor(req.body?.ttlSeconds ?? 3600));

    if (!target) return reply.code(400).send({ error: '缺少 target' });

    // enforce 是独立的能力点：能生成规则不代表能下发到机器
    if (mode === 'enforced' && !req.auth!.caps.has('block:enforce')) {
      audit({
        userId: req.auth!.user.id,
        sessionId: req.auth!.sessionId,
        action: 'denied',
        target: 'block:enforce',
        detail: `尝试 enforce 封禁 ${target}`,
        ip: ip(req),
        userAgent: ua(req),
      });
      return reply.code(403).send({
        error: '你可以生成规则，但没有下发到机器的权限',
        code: 'forbidden',
        required: 'block:enforce',
      });
    }

    if (mode === 'enforced' && req.body?.confirm !== target) {
      return reply.code(428).send({
        error: '需要二次确认',
        detail: 'enforce 模式必须在请求体里带上 confirm 字段，值等于要封禁的目标',
      });
    }

    const check = preflight(target, mode, ttlSeconds, {
      nodeIp: node.ip,
      operatorIp: ip(req),
      panelIp: process.env.SONAR_PANEL_IP,
      allowlist: loadAllowlist(),
    });

    if (!check.allowed) {
      return reply.code(422).send({ error: '预检未通过', preflight: check });
    }

    const operator = req.auth!.user.login || req.auth!.user.name;
    const rule = createRule({
      nodeId: node.id,
      target,
      reason: req.body?.reason ?? '',
      mode,
      ttlSeconds,
      commands: check.commands,
      operator,
    });

    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: mode === 'enforced' ? 'block.enforce' : 'block.dryrun',
      target,
      detail: `${node.name} · ${req.body?.reason ?? ''}`,
      ip: ip(req),
      userAgent: ua(req),
    });

    const ev = logEvent(
      node.id,
      mode === 'enforced' ? 'warn' : 'info',
      'block',
      mode === 'enforced'
        ? `${operator} 封禁了 ${target}${ttlSeconds > 0 ? `（${formatTtl(ttlSeconds)}后自动解除）` : '（永久）'}`
        : `${operator} 生成了 ${target} 的封禁规则（dry-run，未下发）`,
    );
    broadcastTo('block:view', { type: 'block', rule });
    broadcast(() => ({ type: 'event', event: ev }));

    return reply.code(201).send(rule);
  },
);

app.delete<{ Params: { id: string } }>(
  '/api/blocks/:id',
  { preHandler: requireCap('block:remove') },
  async (req, reply) => {
    const rule = removeRule(req.params.id);
    if (!rule) return reply.code(404).send({ error: '规则不存在' });
    const operator = req.auth!.user.login || req.auth!.user.name;
    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'block.remove',
      target: rule.target,
      ip: ip(req),
      userAgent: ua(req),
    });
    const ev = logEvent(rule.nodeId, 'info', 'unblock', `${operator} 解除了对 ${rule.target} 的封禁`);
    broadcast(() => ({ type: 'event', event: ev }));
    return { ...rule, unblockCommands: unblockCommands(rule.target) };
  },
);

// —— 流量阈值

app.get('/api/traffic/rules', { preHandler: requireCap('alert:view') }, async () =>
  listTrafficRules(),
);

app.get<{ Querystring: { days?: string } }>(
  '/api/traffic/ledger',
  { preHandler: requireCap('alert:view') },
  async (req) => trafficLedger(clampInt(req.query.days, 30, 1, 90)),
);

app.post<{
  Body: { nodeId?: string; scope?: RuleScope; threshold?: number; compare?: RuleCompare; note?: string };
}>('/api/traffic/rules', { preHandler: requireCap('alert:manage') }, async (req, reply) => {
  const threshold = Number(req.body?.threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return reply.code(400).send({ error: '阈值必须是正数' });
  }
  const compare: RuleCompare = req.body?.compare === 'quota' ? 'quota' : 'absolute';
  if (compare === 'quota' && threshold > 100) {
    return reply.code(400).send({ error: '按配额百分比时阈值不能超过 100' });
  }

  const rule = createTrafficRule({
    nodeId: req.body?.nodeId ?? '',
    scope: req.body?.scope === 'day' ? 'day' : 'month',
    threshold,
    compare,
    note: req.body?.note ?? '',
    createdBy: req.auth!.user.login || req.auth!.user.name,
  });
  audit({
    userId: req.auth!.user.id,
    sessionId: req.auth!.sessionId,
    action: 'alert.create',
    target: rule.nodeId || 'all',
    detail: `${compare} ${threshold}`,
    ip: ip(req),
    userAgent: ua(req),
  });
  return reply.code(201).send(rule);
});

app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>(
  '/api/traffic/rules/:id',
  { preHandler: requireCap('alert:manage') },
  async (req, reply) => {
    const rule = setTrafficRuleEnabled(req.params.id, req.body?.enabled !== false);
    if (!rule) return reply.code(404).send({ error: '规则不存在' });
    return rule;
  },
);

app.delete<{ Params: { id: string } }>(
  '/api/traffic/rules/:id',
  { preHandler: requireCap('alert:manage') },
  async (req, reply) => {
    if (!deleteTrafficRule(req.params.id)) {
      return reply.code(404).send({ error: '规则不存在' });
    }
    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'alert.delete',
      target: req.params.id,
      ip: ip(req),
      userAgent: ua(req),
    });
    return { ok: true };
  },
);

// ————————————————————————————————————————————————————————
// SSH 管理
//
// 面板做的是**凭据分发**和**连接目录**，不做会话代理 —— 不存私钥、不建隧道、
// 不提供 Web 终端。你的 ssh 连接直连目标机器，一个字节都不经过面板，
// 所以面板挂了不影响任何人登录。
// ————————————————————————————————————————————————————————

/** 当前用户能不能动这把钥匙。别人的钥匙只有 ssh:audit 才能碰。 */
function ownsKeyOr(req: FastifyRequest, key: { ownerUserId: string }): boolean {
  return key.ownerUserId === req.auth!.user.id || req.auth!.caps.has('ssh:audit');
}

/** 审批流开着时，非管理员发起的授权是申请；关掉或自己有审批权时直接生效。 */
function initialRequestState(req: FastifyRequest): 'pending_approval' | 'approved' {
  if (!getSettings().sshRequireApproval) return 'approved';
  return req.auth!.caps.has('ssh:approve') ? 'approved' : 'pending_approval';
}

// —— 我的钥匙

app.get('/api/ssh/keys', { preHandler: requireCap('ssh:keys') }, async (req) => {
  // 有 ssh:audit 的人看全部，其他人只看自己的
  const all = req.auth!.caps.has('ssh:audit');
  return listKeys(all ? undefined : req.auth!.user.id);
});

app.post<{ Body: { publicKey?: string; label?: string } }>(
  '/api/ssh/keys',
  { preHandler: requireCap('ssh:keys') },
  async (req, reply) => {
    try {
      const key = addKey({
        ownerUserId: req.auth!.user.id,
        publicKey: String(req.body?.publicKey ?? ''),
        label: req.body?.label,
      });
      audit({
        userId: req.auth!.user.id,
        sessionId: req.auth!.sessionId,
        action: 'ssh.key.add',
        target: key.fingerprint,
        detail: `${key.keyType} ${key.label}`,
        ip: ip(req),
        userAgent: ua(req),
      });
      return reply.code(201).send(key);
    } catch (err) {
      return sshError(reply, err);
    }
  },
);

/**
 * 从 GitHub 导入公钥。
 *
 * `https://github.com/<login>.keys` 是公开端点，不需要 token —— 你已经用
 * GitHub 登录了，这是那次登录的免费红利，没道理还让人手工去复制粘贴。
 */
app.post('/api/ssh/keys/import/github', { preHandler: requireCap('ssh:keys') }, async (req, reply) => {
  const login = githubLoginOf(req.auth!.user.id);
  if (!login) {
    return reply.code(400).send({ error: '这个账号还没有绑定 GitHub，先去个人设置里绑定' });
  }

  let text: string;
  try {
    const res = await fetch(`https://github.com/${encodeURIComponent(login)}.keys`, {
      headers: { 'User-Agent': 'sonar-panel' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
    text = await res.text();
  } catch (err) {
    // 内网部署拿不到就明说，不要装作是用户的问题
    return reply.code(502).send({
      error: `拉取 github.com/${login}.keys 失败：${err instanceof Error ? err.message : '网络不可达'}。可以改用手工粘贴`,
    });
  }

  const added: string[] = [];
  const skipped: string[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    try {
      const key = addKey({
        ownerUserId: req.auth!.user.id,
        publicKey: line,
        label: `GitHub · ${login}`,
        source: 'github',
      });
      added.push(key.fingerprint);
    } catch (err) {
      skipped.push(err instanceof Error ? err.message : '未知原因');
    }
  }

  if (added.length > 0) {
    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'ssh.key.import',
      target: login,
      detail: `导入 ${added.length} 把`,
      ip: ip(req),
      userAgent: ua(req),
    });
  }
  return { added: added.length, skipped, keys: listKeys(req.auth!.user.id) };
});

app.patch<{ Params: { id: string }; Body: { label?: string; disabled?: boolean } }>(
  '/api/ssh/keys/:id',
  { preHandler: requireCap('ssh:keys') },
  async (req, reply) => {
    const key = getKey(req.params.id);
    if (!key) return reply.code(404).send({ error: '公钥不存在' });
    if (!ownsKeyOr(req, key)) return reply.code(403).send({ error: '这不是你的公钥' });
    try {
      return updateKey(req.params.id, req.body ?? {});
    } catch (err) {
      return sshError(reply, err);
    }
  },
);

app.delete<{ Params: { id: string } }>(
  '/api/ssh/keys/:id',
  { preHandler: requireCap('ssh:keys') },
  async (req, reply) => {
    const key = getKey(req.params.id);
    if (!key) return reply.code(404).send({ error: '公钥不存在' });
    if (!ownsKeyOr(req, key)) return reply.code(403).send({ error: '这不是你的公钥' });
    try {
      deleteKey(req.params.id);
      audit({
        userId: req.auth!.user.id,
        sessionId: req.auth!.sessionId,
        action: 'ssh.key.delete',
        target: key.fingerprint,
        ip: ip(req),
        userAgent: ua(req),
      });
      return { ok: true };
    } catch (err) {
      return sshError(reply, err);
    }
  },
);

// —— 接入方式与别名

app.get('/api/ssh/endpoints', { preHandler: requireCap('ssh:view') }, async () => listEndpoints());

app.patch<{
  Params: { id: string };
  Body: { alias?: string; hostname?: string; port?: number; defaultUser?: string; proxyJump?: string; identityFile?: string };
}>('/api/ssh/endpoints/:id', { preHandler: requireCap('ssh:endpoint') }, async (req, reply) => {
  try {
    const ep = updateEndpoint(req.params.id, req.body ?? {});
    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'ssh.endpoint.update',
      target: req.params.id,
      detail: JSON.stringify(req.body),
      ip: ip(req),
      userAgent: ua(req),
    });
    return ep;
  } catch (err) {
    return sshError(reply, err);
  }
});

/**
 * 生成 ssh_config 片段和 known_hosts。
 *
 * known_hosts 那一半是 Sonar 相对 Termius/Tabby 真正的优势：它们装在你本机，
 * 没法知道目标机器的 host key，只能让你首次连接时盲按一次 yes —— 而那一下
 * 正是中间人攻击唯一的窗口。Sonar 的 agent 就在目标机器上，指纹是它本地的文件。
 */
app.get<{ Querystring: { nodes?: string } }>(
  '/api/ssh/config',
  { preHandler: requireCap('ssh:view') },
  async (req) => {
    const filter = (req.query.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const all = listEndpoints();
    const picked = filter.length > 0 ? all.filter((e) => filter.includes(e.nodeId)) : all;

    const views = picked
      // 连不上的机器不该出现在配置里 —— 一个指向空地址的 Host 只会浪费一次超时
      .filter((e) => e.effectiveHostname)
      .map((e) => ({
        nodeId: e.nodeId,
        alias: e.alias,
        hostname: e.effectiveHostname,
        port: e.port,
        defaultUser: e.defaultUser,
        proxyJump: e.proxyJump,
        identityFile: e.identityFile,
        hostKeys: e.hostKeys.map((k) => ({ type: k.type, blob: k.blob })),
      }));

    return {
      config: configSnippet(views, getSettings().panelName),
      knownHosts: knownHostsEntries(views),
      count: views.length,
      /** 有多少台机器还没采到 host key —— 那些仍需首次盲信任 */
      missingHostKeys: views.filter((v) => v.hostKeys.length === 0).length,
    };
  },
);

// —— 对账

app.get<{ Querystring: { node?: string } }>(
  '/api/ssh/drift',
  { preHandler: requireCap('ssh:audit') },
  async (req) => listDrift(req.query.node),
);

// —— 授权

app.get<{ Querystring: { node?: string; key?: string; mine?: string } }>(
  '/api/ssh/grants',
  { preHandler: requireCap('ssh:view') },
  async (req) => {
    // 没有 ssh:audit 的人只看得到自己的授权
    const scoped = !req.auth!.caps.has('ssh:audit') || req.query.mine === '1';
    return listGrants({
      nodeId: req.query.node,
      keyId: req.query.key,
      ownerUserId: scoped ? req.auth!.user.id : undefined,
    });
  },
);

/** 预检：不落库，只回答"这一步能不能做、会执行什么"。 */
app.post<{ Body: { nodeId?: string; keyId?: string; remoteUser?: string; expiresAt?: number } }>(
  '/api/ssh/grants/preflight',
  { preHandler: requireCap('ssh:grant') },
  async (req, reply) => {
    try {
      const p = await buildGrantPlan(req, req.body ?? {});
      return p.preflight;
    } catch (err) {
      return sshError(reply, err);
    }
  },
);

app.post<{
  Body: { nodeId?: string; keyId?: string; remoteUser?: string; expiresAt?: number; note?: string; useAgent?: boolean };
}>('/api/ssh/grants', { preHandler: requireCap('ssh:grant') }, async (req, reply) => {
  try {
    const plan = await buildGrantPlan(req, req.body ?? {});
    if (!plan.preflight.allowed) {
      return reply.code(409).send({ error: plan.preflight.blockers.join('；'), preflight: plan.preflight });
    }

    /*
     * 只能用自己名下的钥匙发起授权。
     *
     * 不堵的话，一个 operator 可以登记一把自己的 key 但把它算在别人头上，
     * 再给"那个人"授权 —— 他拿到了访问权，而审计日志显示是别人的钥匙装上去的。
     */
    if (!ownsKeyOr(req, plan.key)) {
      return reply.code(403).send({ error: '只能用自己名下的公钥发起授权。代他人授权需要「查看密钥实况」的能力' });
    }

    const requestState = initialRequestState(req);
    const useAgent = Boolean(req.body?.useAgent) && req.auth!.caps.has('ssh:remote_apply');

    const grant = createGrant({
      nodeId: plan.nodeId,
      keyId: plan.key.id,
      remoteUser: plan.remoteUser,
      expiresAt: plan.expiresAt,
      method: useAgent ? 'agent' : 'command',
      requestState,
      requestedBy: req.auth!.user.id,
      grantedBy: req.auth!.user.id,
      approvedBy: requestState === 'approved' ? req.auth!.user.id : '',
      note: req.body?.note,
    });

    // 待审批的申请不下发，也不给命令 —— 否则审批就只是个摆设
    if (requestState === 'approved' && useAgent) {
      dispatchGrant(grant.id, req.auth!.user.name);
    }

    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'ssh.grant',
      target: `${plan.nodeId}:${plan.remoteUser}`,
      detail: `${plan.key.fingerprint} ${requestState === 'approved' ? '已生效' : '待审批'}${useAgent ? ' 经 agent 下发' : ''}`,
      ip: ip(req),
      userAgent: ua(req),
    });
    logEvent(plan.nodeId, 'warn', 'ssh', `${req.auth!.user.name} 授权了 ${plan.key.label} 访问 ${plan.remoteUser}`);

    return reply.code(201).send({
      grant,
      preflight: plan.preflight,
      commands: requestState === 'approved' ? plan.preflight.commands : [],
    });
  } catch (err) {
    return sshError(reply, err);
  }
});

app.post<{ Params: { id: string } }>(
  '/api/ssh/grants/:id/approve',
  { preHandler: requireCap('ssh:approve') },
  async (req, reply) => {
    try {
      const grant = approveGrant(req.params.id, req.auth!.user.id);
      if (grant.method === 'agent') dispatchGrant(grant.id, req.auth!.user.name);
      audit({
        userId: req.auth!.user.id,
        sessionId: req.auth!.sessionId,
        action: 'ssh.grant.approve',
        target: grant.id,
        detail: `${grant.nodeName} / ${grant.ownerName}`,
        ip: ip(req),
        userAgent: ua(req),
      });
      return { grant, commands: grantCommandsFor(grant) };
    } catch (err) {
      return sshError(reply, err);
    }
  },
);

app.post<{ Params: { id: string }; Body: { reason?: string } }>(
  '/api/ssh/grants/:id/reject',
  { preHandler: requireCap('ssh:approve') },
  async (req, reply) => {
    try {
      const grant = rejectGrant(req.params.id, req.auth!.user.id, req.body?.reason ?? '');
      audit({
        userId: req.auth!.user.id,
        sessionId: req.auth!.sessionId,
        action: 'ssh.grant.reject',
        target: grant.id,
        detail: req.body?.reason ?? '',
        ip: ip(req),
        userAgent: ua(req),
      });
      return grant;
    } catch (err) {
      return sshError(reply, err);
    }
  },
);

/** 重新取一次某条授权的命令文本 —— 人可能关掉了对话框还没来得及执行。 */
app.get<{ Params: { id: string } }>(
  '/api/ssh/grants/:id/commands',
  { preHandler: requireCap('ssh:view') },
  async (req, reply) => {
    const grant = getGrant(req.params.id);
    if (!grant) return reply.code(404).send({ error: '授权不存在' });
    if (!req.auth!.caps.has('ssh:audit') && grant.ownerUserId !== req.auth!.user.id) {
      return reply.code(403).send({ error: '这不是你的授权' });
    }
    return { commands: grantCommandsFor(grant) };
  },
);

app.post<{ Params: { id: string }; Body: { useAgent?: boolean } }>(
  '/api/ssh/grants/:id/revoke',
  { preHandler: requireCap('ssh:revoke') },
  async (req, reply) => {
    const grant = getGrant(req.params.id);
    if (!grant) return reply.code(404).send({ error: '授权不存在' });

    const key = getKey(grant.keyId);
    if (!key) return reply.code(404).send({ error: '公钥已不存在' });

    const facts = hostFacts(grant.nodeId, grant.remoteUser, nodeOnline(grant.nodeId));
    const pre = preflightRevoke({
      fingerprint: key.fingerprint,
      facts,
      operatorOwnsKey: key.ownerUserId === req.auth!.user.id,
    });
    if (!pre.allowed) {
      return reply.code(409).send({ error: pre.blockers.join('；'), preflight: pre });
    }

    const commands = revokeCommands(parsePublicKey(key.publicKey), {
      remoteUser: grant.remoteUser,
      day: todayStamp(),
    });

    const useAgent = Boolean(req.body?.useAgent) && req.auth!.caps.has('ssh:remote_apply');
    if (useAgent) {
      enqueue({
        nodeId: grant.nodeId,
        kind: 'ssh_revoke',
        payload: { remoteUser: grant.remoteUser, fingerprint: key.fingerprint },
        preview: commands,
        operator: req.auth!.user.name,
        refId: grant.id,
      });
    }

    /*
     * 立刻标记为已撤销。
     *
     * 这是面板记录，不是机器状态 —— 机器上那把钥匙要等命令被执行才真的消失。
     * 界面上会用 drift 视图把两者的差异显示出来，所以这里提前置位不会造成误解：
     * 没执行的话，下一拍实况上报就会把它显示成"面板已撤销，机器上还在"。
     */
    markGrantRevoked(grant.id, req.auth!.user.id);

    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'ssh.revoke',
      target: `${grant.nodeId}:${grant.remoteUser}`,
      detail: `${key.fingerprint}${useAgent ? ' 经 agent 下发' : ' 需手工执行'}`,
      ip: ip(req),
      userAgent: ua(req),
    });
    logEvent(grant.nodeId, 'warn', 'ssh', `${req.auth!.user.name} 撤销了 ${key.label} 对 ${grant.remoteUser} 的访问`);

    return { ok: true, commands, preflight: pre, dispatched: useAgent };
  },
);

/**
 * 某个人的全部授权 —— 人员离场时一键列出。
 *
 * 这是团队场景里最高频、最容易漏的动作，也是唯一能证明这套系统有价值的时刻。
 */
app.get<{ Params: { id: string } }>(
  '/api/ssh/users/:id/grants',
  { preHandler: requireCap('ssh:audit') },
  async (req) => {
    const grants = grantsOfUser(req.params.id);
    return {
      grants,
      // 按机器分组的撤销命令，agent 离线时人可以照着一台台执行
      commands: grants.map((g) => {
        const key = getKey(g.keyId);
        return {
          grantId: g.id,
          nodeId: g.nodeId,
          nodeName: g.nodeName,
          remoteUser: g.remoteUser,
          commands: key
            ? revokeCommands(parsePublicKey(key.publicKey), { remoteUser: g.remoteUser, day: todayStamp() })
            : [],
        };
      }),
    };
  },
);

/**
 * 导出：我曾经把哪些钥匙装到了哪些机器上。
 *
 * 这个接口存在的理由是**可退出性**：即使哪天不用 Sonar 了，你也能拿着这份清单
 * 手工收尾，而不是留一堆来历不明的钥匙在机器上。它和远程下发能力是配套的。
 */
app.get('/api/ssh/export', { preHandler: requireCap('ssh:audit') }, async () => {
  const grants = listGrants().filter((g) => g.state !== 'revoked');
  return {
    generatedAt: Date.now(),
    grants: grants.map((g) => {
      const key = getKey(g.keyId);
      return {
        node: g.nodeId,
        nodeName: g.nodeName,
        remoteUser: g.remoteUser,
        owner: g.ownerName,
        fingerprint: g.keyFingerprint,
        state: g.state,
        grantedAt: g.grantedAt,
        expiresAt: g.expiresAt,
        revokeCommands: key
          ? revokeCommands(parsePublicKey(key.publicKey), { remoteUser: g.remoteUser, day: todayStamp() })
          : [],
      };
    }),
  };
});

// —— 下发队列

app.get<{ Querystring: { node?: string } }>(
  '/api/ssh/commands',
  { preHandler: requireCap('ssh:audit') },
  async (req) => listCommands(req.query.node),
);

// ————————————————————————————————————————————————————————
// SSH 辅助
// ————————————————————————————————————————————————————————

function sshError(reply: FastifyReply, err: unknown) {
  const status = err instanceof SshStoreError ? err.status : err instanceof SshKeyError ? 400 : 500;
  return reply.code(status).send({ error: err instanceof Error ? err.message : '操作失败' });
}

/** 这个用户绑的 GitHub login，导入公钥要用。 */
function githubLoginOf(userId: string): string {
  const id = listIdentities(userId).find((i) => i.provider === 'github');
  return id ? String(id.meta.login ?? '') : '';
}

/** agent 最近有没有上报。撤销预检要用它判断实况是否可信。 */
function nodeOnline(nodeId: string): boolean {
  const row = db.prepare('SELECT agent_last_report FROM nodes WHERE id=?').get(nodeId) as
    | { agent_last_report: number }
    | undefined;
  if (!row) return false;
  return Date.now() - Number(row.agent_last_report ?? 0) < getSettings().offlineAfterSeconds * 1000;
}

interface GrantPlan {
  nodeId: string;
  remoteUser: string;
  expiresAt: number;
  key: ReturnType<typeof getKey> & object;
  preflight: { allowed: boolean; blockers: string[]; warnings: string[]; commands: string[] };
}

/** 授权的三件事：查参数、跑预检、生成命令。预检接口和创建接口共用它。 */
async function buildGrantPlan(
  req: FastifyRequest,
  body: { nodeId?: string; keyId?: string; remoteUser?: string; expiresAt?: number },
): Promise<GrantPlan> {
  const nodeId = String(body.nodeId ?? '');
  const node = db.prepare('SELECT id FROM nodes WHERE id=?').get(nodeId) as { id: string } | undefined;
  if (!node) throw new SshStoreError('机器不存在', 404);

  const key = getKey(String(body.keyId ?? ''));
  if (!key) throw new SshStoreError('公钥不存在', 404);

  const ep = ensureEndpoint(nodeId);
  const remoteUser = String(body.remoteUser ?? ep.defaultUser ?? 'root');
  const expiresAt = Math.max(0, Math.trunc(Number(body.expiresAt ?? 0)));

  const parsed = parsePublicKey(key.publicKey);
  const facts = hostFacts(nodeId, remoteUser, nodeOnline(nodeId));
  const pre = preflightGrant({ key: parsed, facts, expiresAt });

  const commands = pre.allowed
    ? grantCommands(
        parsed,
        { remoteUser, nodeId, owner: keyOwnerSlug(key.id), day: todayStamp() },
        expiresAt,
      )
    : [];

  return {
    nodeId,
    remoteUser,
    expiresAt,
    key,
    preflight: { ...pre, commands },
  };
}

/**
 * 进 comment 的所有者标识。
 *
 * 显示名可能是中文（"超级管理员"），而 comment 要写进目标机器的文件、
 * 还要能被 shell 安全地引用，所以按 username → login → id 依次取，
 * 取到第一个 slug 化之后非空的。
 *
 * 这段标识是机器上唯一能追溯"这把钥匙是谁装的"的线索，退化成 'user' 等于
 * 丢掉了溯源能力 —— 所以 id 那一档也参与，它至少是唯一的。
 */
function userSlug(user: { username?: string; login?: string; id?: string }): string {
  for (const raw of [user.username, user.login, user.id]) {
    const safe = String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '');
    if (safe) return safe.slice(0, 32);
  }
  return 'user';
}

/** 一把钥匙的主人，用于生成 comment。 */
function keyOwnerSlug(keyId: string): string {
  const row = db
    .prepare(
      'SELECT u.username, u.login, u.id FROM ssh_keys k LEFT JOIN users u ON u.id = k.owner_user_id WHERE k.id = ?',
    )
    .get(keyId) as { username: string; login: string; id: string } | undefined;
  return row ? userSlug(row) : 'user';
}

function grantCommandsFor(grant: { keyId: string; nodeId: string; remoteUser: string; expiresAt: number }): string[] {
  const key = getKey(grant.keyId);
  if (!key) return [];
  return grantCommands(
    parsePublicKey(key.publicKey),
    {
      remoteUser: grant.remoteUser,
      nodeId: grant.nodeId,
      owner: keyOwnerSlug(grant.keyId),
      day: todayStamp(),
    },
    grant.expiresAt,
  );
}

/** 把一条授权推进下发队列。agent 拿到的是结构化参数，不是这些命令文本。 */
function dispatchGrant(grantId: string, operator: string): void {
  const grant = getGrant(grantId);
  if (!grant) return;
  const key = getKey(grant.keyId);
  if (!key) return;

  enqueue({
    nodeId: grant.nodeId,
    kind: 'ssh_grant',
    payload: {
      remoteUser: grant.remoteUser,
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      comment: grantComment({
        remoteUser: grant.remoteUser,
        nodeId: grant.nodeId,
        // 按钥匙的主人取，不是按发起人 —— comment 要回答的是"这把钥匙是谁的"
        owner: keyOwnerSlug(grant.keyId),
        day: todayStamp(),
      }),
      expiresAt: grant.expiresAt,
    },
    preview: grantCommandsFor(grant),
    operator,
    refId: grant.id,
  });
}

// —— 管理

app.get('/api/admin/capabilities', { preHandler: requireCap('user:view') }, async () => {
  const usage = roleUsage();
  return {
    groups: groupedCapabilities(),
    roles: listRoles().map((r) => ({
      value: r.id,
      label: r.name,
      description: r.description,
      capabilities: r.capabilities,
      system: r.system,
      locked: r.locked,
      sortOrder: r.sortOrder,
      userCount: usage.get(r.id) ?? 0,
      // anonymous 不挂在任何账号上，指派给某个人是没有意义的
      assignable: r.id !== 'anonymous',
    })),
    all: ALL_CAPABILITIES,
  };
});

// —— 角色

app.post<{ Body: { id?: string; name?: string; description?: string; capabilities?: unknown; sortOrder?: number } }>(
  '/api/admin/roles',
  { preHandler: requireCap('role:manage') },
  async (req, reply) => {
    try {
      const role = createRole(req.body ?? {});
      audit({
        userId: req.auth!.user.id,
        sessionId: req.auth!.sessionId,
        action: 'role.create',
        target: role.id,
        detail: `${role.name}（${role.capabilities.length} 项能力）`,
        ip: ip(req),
        userAgent: ua(req),
      });
      logEvent(null, 'warn', 'auth', `${req.auth!.user.name} 新建了角色「${role.name}」`);
      return role;
    } catch (err) {
      const status = err instanceof RoleError ? err.status : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : '创建失败' });
    }
  },
);

app.patch<{
  Params: { id: string };
  Body: { name?: string; description?: string; capabilities?: unknown; sortOrder?: number };
}>('/api/admin/roles/:id', { preHandler: requireCap('role:manage') }, async (req, reply) => {
  try {
    const before = getRole(req.params.id);
    const role = updateRole(req.params.id, req.body ?? {});

    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'role.update',
      target: role.id,
      detail: JSON.stringify({ name: role.name, capabilities: role.capabilities }),
      ip: ip(req),
      userAgent: ua(req),
    });

    /*
     * 改角色能力集要广播，不只是记一笔。
     *
     * 挂着这个角色的人此刻正开着页面，他们手里的 capabilities 是登录那一刻
     * 算出来的。不推的话，一个刚被收走 block:enforce 的人，按钮还在、点了
     * 才发现 403 —— 而更糟的方向是刚被授予的能力要重新登录才出现，
     * 于是所有人都学会了"权限改了就刷新一下"，那本该是系统的事。
     */
    const capsChanged =
      JSON.stringify(before?.capabilities ?? []) !== JSON.stringify(role.capabilities);
    if (capsChanged) {
      const affected = roleUsage().get(role.id) ?? 0;
      logEvent(
        null,
        'warn',
        'auth',
        `${req.auth!.user.name} 修改了角色「${role.name}」的能力集，影响 ${affected} 个用户`,
      );
      pushAuthRefresh(role.id);
    }

    return role;
  } catch (err) {
    const status = err instanceof RoleError ? err.status : 400;
    return reply.code(status).send({ error: err instanceof Error ? err.message : '保存失败' });
  }
});

app.delete<{ Params: { id: string } }>(
  '/api/admin/roles/:id',
  { preHandler: requireCap('role:manage') },
  async (req, reply) => {
    try {
      const role = getRole(req.params.id);
      deleteRole(req.params.id);
      audit({
        userId: req.auth!.user.id,
        sessionId: req.auth!.sessionId,
        action: 'role.delete',
        target: req.params.id,
        detail: role?.name ?? '',
        ip: ip(req),
        userAgent: ua(req),
      });
      return { ok: true };
    } catch (err) {
      const status = err instanceof RoleError ? err.status : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : '删除失败' });
    }
  },
);

// —— 用户

app.get('/api/admin/users', { preHandler: requireCap('user:view') }, async () =>
  listUsers().map((u) => ({
    ...publicUser(u),
    granted: u.granted,
    revoked: u.revoked,
    capabilities: [...capabilitiesFor(u.role, u.granted, u.revoked)],
    identities: userIdentities(u.id),
  })),
);

app.post<{
  Body: { username?: string; password?: string; name?: string; email?: string; role?: string; note?: string };
}>('/api/admin/users', { preHandler: requireCap('user:create') }, async (req, reply) => {
  /*
   * 不能建一个权限比自己大的账号。
   *
   * 没这一条的话，一个只有 user:create 的人可以直接建一个 admin 账号然后登进去 ——
   * 一步就把"能建号"升级成了"能干任何事"。这是权限系统里最常见的提权路径。
   *
   * user:escalate 是显式的例外，见 permissions.ts 里那段说明。
   */
  const target = String(req.body?.role ?? 'viewer');
  const blocked = checkEscalation({
    mine: req.auth!.caps,
    currentCaps: new Set(),
    nextCaps: capabilitiesFor(target),
  });
  if (blocked) {
    return reply.code(403).send({
      error: `不能创建权限比自己大的账号：「${getRole(target)?.name ?? target}」含有你没有的能力（${listCaps(blocked.caps)}）。${ESCALATE_HINT}`,
    });
  }

  try {
    const user = await createUser({
      username: String(req.body?.username ?? ''),
      password: String(req.body?.password ?? ''),
      name: req.body?.name,
      email: req.body?.email,
      role: target,
      note: req.body?.note,
      // 管理员设的密码，本人第一次登录必须换掉 —— 密码经过了第二个人的手
      mustChangePassword: true,
    });

    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'user.create',
      target: user.id,
      detail: `${user.username}（${getRole(user.role)?.name ?? user.role}）`,
      ip: ip(req),
      userAgent: ua(req),
    });
    logEvent(null, 'warn', 'auth', `${req.auth!.user.name} 创建了账号 ${user.username}`);

    return reply.code(201).send({
      ...publicUser(user),
      granted: user.granted,
      revoked: user.revoked,
      capabilities: [...capabilitiesFor(user.role, user.granted, user.revoked)],
      identities: userIdentities(user.id),
    });
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 400;
    return reply.code(status).send({ error: err instanceof Error ? err.message : '创建失败' });
  }
});

app.patch<{
  Params: { id: string };
  Body: { role?: Role; granted?: string[]; revoked?: string[]; disabled?: boolean; note?: string; name?: string };
}>('/api/admin/users/:id', { preHandler: requireCap('user:manage') }, async (req, reply) => {
  const target = req.params.id;
  const current = listUsers().find((u) => u.id === target);
  if (!current) return reply.code(404).send({ error: '用户不存在' });

  // 不能把自己降权 —— 手滑一次就再也进不了管理页了
  if (target === req.auth!.user.id && req.body.role && req.body.role !== current.role) {
    return reply.code(409).send({ error: '不能修改自己的角色，请让另一位管理员操作' });
  }
  if (target === req.auth!.user.id && req.body.disabled) {
    return reply.code(409).send({ error: '不能停用自己的账号' });
  }

  /*
   * 不能把别人提到自己没有的能力上，也不能碰本来就比自己大的账号。
   *
   * 和建号那条是同一个漏洞的另一半：不堵的话，一个 operator 只要有 user:manage，
   * 就能把某个受控账号提成 admin，再用那个账号回来提自己。
   *
   * 两种拒绝要分开说。都并成"不能授予你自己没有的能力"的话，一个只想给
   * 运维加一项权限的人，会收到一串他根本没提交过的能力点 —— 那些是对方
   * 早就有的。信息对不上时，人只会以为系统坏了，而不是去想自己权限不够。
   */
  const changesPermissions =
    req.body.role !== undefined || req.body.granted !== undefined || req.body.revoked !== undefined;

  if (changesPermissions) {
    const blocked = checkEscalation({
      mine: req.auth!.caps,
      currentCaps: capabilitiesFor(current.role, current.granted, current.revoked),
      nextCaps: capabilitiesFor(
        req.body.role ?? current.role,
        req.body.granted ?? current.granted,
        req.body.revoked ?? current.revoked,
      ),
    });
    if (blocked) {
      return reply.code(403).send({
        error:
          blocked.kind === 'outranks'
            ? `${current.name} 拥有你没有的能力（${listCaps(blocked.caps)}），不能修改他的权限。${ESCALATE_HINT}`
            : `不能授予你自己没有的能力：${listCaps(blocked.caps)}。${ESCALATE_HINT}`,
      });
    }
  }

  // 也不能把最后一个管理员降权或停用，否则面板就没人能管了
  const losingAdmin =
    current.role === 'admin' &&
    ((req.body.role && req.body.role !== 'admin') || req.body.disabled === true);
  if (losingAdmin && activeAdminCount() <= 1) {
    return reply.code(409).send({ error: '这是最后一个管理员，先提升另一位再操作' });
  }

  let updated;
  try {
    updated = updateUser(target, req.body);
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 400;
    return reply.code(status).send({ error: err instanceof Error ? err.message : '保存失败' });
  }
  if (!updated) return reply.code(404).send({ error: '用户不存在' });

  audit({
    userId: req.auth!.user.id,
    sessionId: req.auth!.sessionId,
    action: 'user.update',
    target,
    detail: JSON.stringify(req.body),
    ip: ip(req),
    userAgent: ua(req),
  });
  logEvent(null, 'warn', 'auth', `${req.auth!.user.name} 修改了 ${updated.name} 的权限`);
  pushAuthRefreshTo(target);

  return {
    ...publicUser(updated),
    granted: updated.granted,
    revoked: updated.revoked,
    capabilities: [...capabilitiesFor(updated.role, updated.granted, updated.revoked)],
    identities: userIdentities(updated.id),
  };
});

app.delete<{ Params: { id: string } }>(
  '/api/admin/users/:id',
  { preHandler: requireCap('user:create') },
  async (req, reply) => {
    const target = req.params.id;
    if (target === req.auth!.user.id) {
      return reply.code(409).send({ error: '不能删除自己的账号' });
    }
    const current = listUsers().find((u) => u.id === target);
    if (!current) return reply.code(404).send({ error: '用户不存在' });

    try {
      deleteUser(target);
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : '删除失败' });
    }

    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'user.delete',
      target,
      detail: `${current.username || current.login}（${current.name}）`,
      ip: ip(req),
      userAgent: ua(req),
    });
    logEvent(null, 'warn', 'auth', `${req.auth!.user.name} 删除了账号 ${current.username || current.login}`);
    return { ok: true };
  },
);

app.post<{ Params: { id: string }; Body: { password?: string } }>(
  '/api/admin/users/:id/password',
  { preHandler: requireCap('user:manage') },
  async (req, reply) => {
    const current = listUsers().find((u) => u.id === req.params.id);
    if (!current) return reply.code(404).send({ error: '用户不存在' });

    /*
     * 重置别人的密码等于取得他的账号。
     *
     * 所以目标不能拥有你没有的能力 —— 否则"我能重置 admin 的密码"就是
     * "我能成为 admin"的同义词，只是多绕了一次登录。
     */
    const theirs = capabilitiesFor(current.role, current.granted, current.revoked);
    const blocked = checkEscalation({ mine: req.auth!.caps, currentCaps: theirs, nextCaps: theirs });
    if (blocked) {
      return reply.code(403).send({
        error: `${current.name} 拥有你没有的能力（${listCaps(blocked.caps)}），重置他的密码等于取得他的账号。${ESCALATE_HINT}`,
      });
    }

    try {
      const password = await resetPassword(req.params.id, req.body?.password);
      audit({
        userId: req.auth!.user.id,
        sessionId: req.auth!.sessionId,
        action: 'password.reset',
        target: req.params.id,
        detail: req.body?.password ? '管理员指定了新密码' : '系统生成了新密码',
        ip: ip(req),
        userAgent: ua(req),
      });
      logEvent(null, 'warn', 'auth', `${req.auth!.user.name} 重置了 ${current.name} 的密码`);
      // 只在这一次响应里回显，不落库、不进日志
      return { ok: true, password, mustChange: true };
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : '重置失败' });
    }
  },
);

app.post<{ Params: { id: string } }>(
  '/api/admin/users/:id/sessions/revoke',
  { preHandler: requireCap('user:manage') },
  async (req) => {
    revokeUserSessions(req.params.id);
    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'user.kick',
      target: req.params.id,
      ip: ip(req),
      userAgent: ua(req),
    });
    return { ok: true };
  },
);

/**
 * 接入新机器需要的信息。
 *
 * 里面有 agent token，所以挂在 node:manage 之后 —— 拿到它就等于能往面板里塞数据。
 * 面板地址从请求头推导而不是写死：同一个面板可能同时有内网地址和公网域名，
 * 用哪个访问就用哪个装，省得人自己去想该填什么。
 */
app.get('/api/admin/enroll', { preHandler: requireCap('node:manage') }, async (req) => {
  const token = process.env.SONAR_AGENT_TOKEN ?? '';
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '';
  return {
    // 没配 token 时上报通道整个是关的，得先去配
    ready: token.length > 0,
    panelUrl: host ? `${proto}://${host}` : '',
    token,
    /** 已经接入的 id，前端用来提示"这个名字已经被占了" */
    existingIds: listNodeStates().map((n) => n.id),
  };
});

app.get('/api/admin/online', { preHandler: requireCap('audit:view') }, async () =>
  listOnline().map((o) => ({
    ...o,
    user: publicUser(o.user),
  })),
);

app.get<{ Querystring: { days?: string } }>(
  '/api/admin/visitors',
  { preHandler: requireCap('audit:view') },
  async (req) => visitorSummary(clampInt(req.query.days, 7, 1, 90) * 86_400_000),
);

app.get<{ Querystring: { limit?: string; user?: string; action?: string } }>(
  '/api/admin/audit',
  { preHandler: requireCap('audit:view') },
  async (req) =>
    listAudit({
      limit: clampInt(req.query.limit, 120, 1, 500),
      userId: req.query.user,
      action: req.query.action,
    }).map((e) => ({ ...e, user: e.user ? publicUser(e.user) : null })),
);

app.get<{ Querystring: { user?: string } }>(
  '/api/admin/sessions',
  { preHandler: requireCap('audit:view') },
  async (req) => listSessions(req.query.user),
);

// ————————————————————————————————————————————————————————
// 通用设置
// ————————————————————————————————————————————————————————

/**
 * 展示口径，对所有人开放。
 *
 * 这一份必须匿名可读：概览页是公开状态页，未登录的人也要看到流量数字。
 * 而"1.83 TB"到底按 1024 还是 1000 算出来的，属于渲染这个数字的必要前提 ——
 * 拿不到就只能猜，猜错了整页数字都偏 10%。
 *
 * 里面没有任何敏感项：保留策略、汇率覆盖明细这些只在下面那条带权限的接口里给。
 */
app.get('/api/settings/public', async () => publicSettings());

/** 完整设置 + 设置页要用的选项清单。 */
app.get('/api/settings', { preHandler: requireCap('settings:view') }, async () => ({
  settings: getSettings(),
  defaults: DEFAULT_SETTINGS,
  rates: ratesPayload(),
  options: {
    currencies: CURRENCIES.map((c) => ({ value: c, ...CURRENCY_META[c] })),
    timezones: COMMON_TIMEZONES,
  },
}));

app.patch<{ Body: Partial<Settings> }>(
  '/api/settings',
  { preHandler: requireCap('settings:manage') },
  async (req) => {
    const before = getSettings();
    const next = updateSettings(req.body ?? {});

    // 只记真正变了的字段。把整个设置对象塞进审计详情，下次改一项也要在
    // 二十行 JSON 里找出是哪一项动了
    const changed = (Object.keys(next) as Array<keyof Settings>).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]),
    );

    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'settings.update',
      target: changed.join(', ') || '无变化',
      detail: changed.map((k) => `${String(k)}=${JSON.stringify(next[k])}`).join(' '),
      ip: ip(req),
      userAgent: ua(req),
    });

    if (changed.length > 0) {
      logEvent(
        null,
        'info',
        'settings',
        `${req.auth!.user.login || req.auth!.user.name} 修改了通用设置：${changed.join('、')}`,
      );
      /*
       * 口径变了要立刻推两样东西。
       *
       * 一是新口径本身 —— 页面上每个数字的渲染都依赖它，而且它必须发给
       * 所有人（包括匿名访客），不然两个人对着同一台机器会读出差 10% 的数字；
       * 二是重算过的节点数据 —— 流量方向、时区、告警阈值都会改变
       * listNodeStates 的输出，不推的话要等到下一个 tick 才生效，
       * 而管理员正是在这一刻盯着页面看改动有没有效果。
       */
      broadcast(() => ({ type: 'settings', settings: publicSettings() }));
      const nodes = listNodeStates();
      broadcast((caps) => ({ type: 'tick', nodes: sanitizeNodes(nodes, caps), ts: Date.now() }));
    }

    return { settings: next, rates: ratesPayload() };
  },
);

/** 手动拉一次汇率。改完覆盖值想立刻看效果时用得上。 */
app.post(
  '/api/settings/rates/refresh',
  { preHandler: requireCap('settings:manage') },
  async (req) => {
    const snap = await refreshRates();
    audit({
      userId: req.auth!.user.id,
      sessionId: req.auth!.sessionId,
      action: 'settings.rates',
      target: snap.source || '拉取失败',
      detail: snap.lastError,
      ip: ip(req),
      userAgent: ua(req),
    });
    return ratesPayload();
  },
);

// ————————————————————————————————————————————————————————
// 采集端上报
//
// 这几个接口不走用户会话，用独立的 agent token 认证。
// 没配 SONAR_AGENT_TOKEN 时整个通道关闭 —— 否则谁都能往面板里灌数据。
// ————————————————————————————————————————————————————————

app.post<{ Body: { token?: string; node?: AgentNodeInfo } }>(
  '/api/agent/register',
  async (req, reply) => {
    if (!agentIngestEnabled()) {
      return reply.code(503).send({ error: '上报通道未启用：服务端没有配置 SONAR_AGENT_TOKEN' });
    }
    if (!agentTokenValid(req.body?.token)) {
      return reply.code(401).send({ error: 'agent token 不正确' });
    }
    const node = req.body?.node;
    if (!node?.id) return reply.code(400).send({ error: '缺少 node.id' });

    try {
      const { created } = registerAgentNode({ ...node, ip: node.ip || ip(req) });
      if (created) {
        broadcast(() => ({
          type: 'event',
          event: logEvent(node.id, 'info', 'agent', `${node.name ?? node.id} 的采集端已接入`),
        }));
      }

      /*
       * 每次注册都换发一把独立密钥。
       *
       * 注册发生在 agent 启动时，换发的代价只是这台机器要重新落盘一次；
       * 而好处是密钥有了自然的轮换周期，且一台机器被摘除重装后，
       * 旧密钥立刻作废。
       */
      const secret = issueNodeSecret(node.id);
      return { ok: true, created, secret };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : '注册失败' });
    }
  },
);

app.post<{ Body: { token?: string } & AgentReport }>('/api/agent/report', async (req, reply) => {
  // token 猜错不该是免费的。正常 agent 3 秒一报，每分钟 60 次留了足够余量
  if (!consume(`agent:${ip(req)}`, 60, 60_000)) {
    return reply.code(429).send({ error: '上报过于频繁' });
  }
  if (!agentIngestEnabled()) {
    return reply.code(503).send({ error: '上报通道未启用：服务端没有配置 SONAR_AGENT_TOKEN' });
  }
  if (!agentTokenValid(req.body?.token)) {
    return reply.code(401).send({ error: 'agent token 不正确' });
  }
  if (!req.body?.nodeId) return reply.code(400).send({ error: '缺少 nodeId' });

  try {
    ingestReport(req.body, ip(req));
    // SSH 实况是可选的：老 agent 不带这一段，带了就顺手对一次账
    if (req.body.ssh) ingestSshFacts(req.body.nodeId, req.body.ssh);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : '写入失败' });
  }

  /*
   * 反向下发。
   *
   * **只发给完成了密钥升级的 agent。** 共享的 SONAR_AGENT_TOKEN 在每台机器上
   * 都能读到，拿它既能拉取别台机器的待办指令（看到面板打算给谁装什么钥匙），
   * 也能替别台机器发回执 —— 后者会让面板显示一个虚假的"已撤销"，
   * 而那把钥匙还在机器上。这比没有这个功能更糟。
   *
   * 没升级的 agent 照常上报，只是拿不到指令。这道闸门让升级是自愿、可观测、
   * 可回滚的：老 agent 一切如常，新能力只给验证过身份的那些。
   */
  if (!nodeSecretValid(req.body.nodeId, req.body.secret)) {
    return { ok: true, commands: [] };
  }

  const claimed = claimFor(req.body.nodeId);
  return {
    ok: true,
    commands: claimed.map((c) => ({
      id: c.id,
      kind: c.kind,
      // payload 是结构化参数。preview 里的命令文本只用于展示和存档，agent 不看
      ...c.payload,
    })),
  };
});

app.post<{ Body: { token?: string; secret?: string; nodeId?: string; result?: AckBody } }>(
  '/api/agent/ack',
  async (req, reply) => {
    if (!agentTokenValid(req.body?.token)) {
      return reply.code(401).send({ error: 'agent token 不正确' });
    }
    const nodeId = String(req.body?.nodeId ?? '');
    if (!nodeSecretValid(nodeId, req.body?.secret)) {
      return reply.code(403).send({ error: '这台机器还没有完成密钥升级，无法回执' });
    }

    const r = req.body?.result;
    if (!r?.id) return reply.code(400).send({ error: '缺少指令 id' });

    const cmd = ackCommand(nodeId, {
      id: r.id,
      ok: Boolean(r.ok),
      skipped: Boolean(r.skipped),
      output: r.output,
    });
    if (!cmd) return reply.code(404).send({ error: '指令不存在或不属于这台机器' });

    /*
     * 回执只更新指令自己的状态，**不把授权置为生效**。
     *
     * agent 说"写进去了"只说明它那边没报错。真正的确认要等下一拍的实况上报 ——
     * 见 ssh-store 的 reconcileGrants。少了这条区分，一次静默失败就会让面板
     * 显示"已生效"，而人据此以为自己能连上去了。
     */
    if (cmd.state === 'failed' && cmd.refId) {
      markGrantFailedSafe(cmd.refId, cmd.result || 'agent 执行失败');
      logEvent(nodeId, 'error', 'ssh', `SSH 指令执行失败：${cmd.result.slice(0, 120)}`);
    }

    return { ok: true };
  },
);

interface AckBody {
  id?: string;
  ok?: boolean;
  skipped?: boolean;
  output?: string;
}

function markGrantFailedSafe(grantId: string, reason: string): void {
  try {
    markGrantFailed(grantId, reason);
  } catch {
    // ref 指向的对象可能已经被删了，回执不该因此失败
  }
}

/**
 * 一次性 OAuth 配置。
 *
 * 让浏览器把刚生成的 client secret 直接送到这里，不经过任何中间环节。
 * 配好之后 githubEnabled() 变 true，这个接口自己就关了。
 */
app.post<{ Body: { setupToken?: string; clientId?: string; clientSecret?: string } }>(
  '/api/setup/oauth',
  async (req, reply) => {
    if (githubEnabled()) {
      return reply.code(409).send({ error: 'OAuth 已配置，此通道已关闭' });
    }
    if (!setupTokenValid(req.body?.setupToken)) {
      return reply.code(401).send({ error: 'setup token 不正确或已失效' });
    }
    if (!req.body?.clientId || !req.body?.clientSecret) {
      return reply.code(400).send({ error: '缺少 clientId 或 clientSecret' });
    }

    try {
      writeOAuthCredentials({
        clientId: req.body.clientId,
        clientSecret: req.body.clientSecret,
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : '写入失败' });
    }

    logEvent(null, 'warn', 'auth', 'GitHub OAuth 凭据已写入，服务即将重启以生效');

    // 凭据是在启动时读进 env 的，改完必须重启才生效。
    // 交给 systemd 的 Restart=always 拉起来，比在进程内热更新可靠。
    setTimeout(() => process.exit(0), 300);

    return { ok: true, restarting: true };
  },
);

app.get('/api/health', async () => {
  const nodes = listNodeStates();
  const agents = agentNodeIds();
  return {
    ok: true,
    mode: agents.size > 0 ? 'mixed' : 'simulator',
    nodes: nodes.length,
    agentNodes: agents.size,
    simNodes: nodes.length - agents.size,
    clients: clients.size,
    github: githubEnabled(),
    agentIngest: agentIngestEnabled(),
    needsBootstrap: !hasAnyAdmin(),
    uptime: Math.floor(process.uptime()),
  };
});

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function formatTtl(seconds: number): string {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} 天`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} 小时`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} 分钟`;
  return `${seconds} 秒`;
}

// ————————————————————————————————————————————————————————
// 启动
// ————————————————————————————————————————————————————————

/**
 * 模拟器开关。**默认关闭，要显式设 SONAR_SIMULATOR=1 才开。**
 *
 * 演示和本地开发时有一批虚构机器很方便，但真实部署里它们只会让人
 * 分不清哪台是真的。
 *
 * 之前的默认值是"开"（只有显式设 0 才关），那是个陷阱：装完面板忘了配一行
 * 环境变量，12 台虚构机器就混进了真实列表，而且看起来和真机一模一样。
 * 忘记开演示数据顶多是页面空着，忘记关则会让人对着假数据做判断 ——
 * 两种疏忽的代价差得远，默认值该站在代价小的那一边。
 */
const SIMULATOR = process.env.SONAR_SIMULATOR === '1';

/*
 * 账号体系的初始化。
 *
 * 顺序有依赖：角色得先在，createUser 才校验得过 roleExists；身份迁移要在
 * 建 root 之前跑完，否则一个本该由老 github_id 认领的账号会被当成"还没有管理员"
 * 而多造一个 root 出来。
 */
ensureSystemRoles();

const migratedIdentities = migrateLegacyGithubIdentities();
if (migratedIdentities > 0) {
  console.log(`  已把 ${migratedIdentities} 个 GitHub 账号迁入身份表`);
}

const DATA_DIR = process.env.SONAR_DATA_DIR ?? resolve(process.cwd(), 'data');
const initialAdmin = await ensureRootAdmin(DATA_DIR);
if (initialAdmin) {
  /*
   * 初始密码只在这里出现一次。
   *
   * 打印到 stdout 而不是走 app.log：日志级别默认是 warn，用 logger 打会被吞掉，
   * 而这行字是全新部署唯一能进门的凭据。同时它也写在 data/initial-admin.txt 里 ——
   * 用 systemd 跑的时候 stdout 进了 journal，翻起来不如直接 cat 一个文件。
   */
  console.log('');
  console.log('  ┌─ 已创建初始管理员账号 ─────────────────────');
  console.log(`  │  用户名：${initialAdmin.username}`);
  console.log(`  │  密码：  ${initialAdmin.password}`);
  console.log('  │');
  console.log('  │  首次登录后会要求修改密码。');
  console.log('  │  同一份也写在 data/initial-admin.txt（0600）。');
  console.log('  └────────────────────────────────────────────');
  console.log('');
  logEvent(null, 'warn', 'auth', '面板初始化：已创建超级管理员账号');
}

if (SIMULATOR) {
  seedDatabase();
  ensureRuntimeLoaded();
} else {
  // 关掉模拟器就把它之前留下的数据一并清干净，否则会以"离线机器"的样子赖在面板上
  const purged = purgeSimulatedData();
  if (purged.nodes > 0) {
    console.log(`  已清除 ${purged.nodes} 台模拟机器及其 ${purged.rows} 条历史数据`);
  }
}

setInterval(() => {
  try {
    if (SIMULATOR) tick(TICK_SECONDS);
    const nodes = listNodeStates();
    broadcast((caps) => ({ type: 'tick', nodes: sanitizeNodes(nodes, caps), ts: Date.now() }));
  } catch (err) {
    app.log.error({ err }, 'tick failed');
  }
}, TICK_SECONDS * 1000);

setInterval(() => {
  const expired = expireRules();
  if (expired > 0) {
    const ev = logEvent(null, 'info', 'unblock', `${expired} 条封禁规则到期自动解除`);
    broadcast(() => ({ type: 'event', event: ev }));
  }
  // 保留策略由设置决定，每次都重新读 —— 管理员改完不用等重启
  const { metricRetentionHours, auditRetentionDays, trafficRetentionDays } = getSettings();
  pruneMetrics(metricRetentionHours);
  pruneAuditLog(auditRetentionDays);
  pruneTrafficDetail(trafficRetentionDays);
  pruneSessions();
}, 60_000);

/*
 * 汇率。
 *
 * 一天一次足够 —— 月度成本是个用来判断"这堆机器大概花多少钱"的数字，
 * 追实时汇率没有意义。真正重要的是别让它停在几个月前还装作是新的，
 * 所以拉取时间会一路带到界面上。
 *
 * 每小时问一次 shouldRefresh，它内部按"超过 24 小时才拉、失败后至少隔 30 分钟"
 * 决定要不要真的发请求；关掉自动更新时它直接回 false，一个包也不会发出去。
 */
void refreshRatesIfStale();
setInterval(() => {
  void refreshRatesIfStale();
}, 3600_000);

// 流量阈值检查。频率不用高 —— 日/月用量不会在几秒内跨过阈值
setInterval(() => {
  try {
    for (const breach of evaluateTrafficRules()) {
      markFired(breach.rule.id);
      const pct = breach.percent.toFixed(0);
      const ev = logEvent(
        breach.nodeId,
        'warn',
        'traffic',
        breach.rule.compare === 'quota'
          ? `${breach.nodeName} 本${breach.rule.scope === 'day' ? '日' : '月'}流量已达配额的 ${pct}%`
          : `${breach.nodeName} 本${breach.rule.scope === 'day' ? '日' : '月'}流量超过设定阈值（${pct}%）`,
      );
      broadcast(() => ({ type: 'event', event: ev }));
    }
  } catch (err) {
    app.log.error({ err }, 'traffic rule check failed');
  }
}, 30_000);

const ALERT_TEMPLATES = [
  { level: 'warn' as const, kind: 'load', msg: (n: string) => `${n} 1 分钟负载持续高于核心数` },
  { level: 'warn' as const, kind: 'disk', msg: (n: string) => `${n} 磁盘使用率超过 85%` },
  { level: 'info' as const, kind: 'agent', msg: (n: string) => `${n} 采集端心跳恢复正常` },
  { level: 'error' as const, kind: 'net', msg: (n: string) => `${n} 出站带宽触顶，可能存在异常拉取` },
  { level: 'info' as const, kind: 'cert', msg: (n: string) => `${n} TLS 证书已自动续签` },
];

// 随机事件只在模拟器模式下产生。
// 真实部署里绝不能编造事件 —— 给一台活得好好的机器报"磁盘超过 85%"，
// 比没有事件流糟糕得多。
if (SIMULATOR) {
  setInterval(() => {
    if (Math.random() > 0.35) return;
    const nodes = listNodeStates();
    const node = nodes[Math.floor(Math.random() * nodes.length)];
    if (!node) return;
    const tpl = ALERT_TEMPLATES[Math.floor(Math.random() * ALERT_TEMPLATES.length)]!;
    const ev = logEvent(node.id, tpl.level, tpl.kind, tpl.msg(node.name));
    broadcast(() => ({ type: 'event', event: ev }));
  }, 18_000);
}

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`\n  Sonar 面板服务已启动  http://${HOST}:${PORT}`);
  console.log(
    `  模拟器：${SIMULATOR ? '开启（面板含虚构机器，仅供演示）' : '关闭 —— 只显示 agent 上报的真实机器'}`,
  );
  console.log(`  节点数 ${listNodeStates().length}  ·  推送间隔 ${TICK_SECONDS}s`);
  console.log(
    `  GitHub 登录：${githubEnabled() ? '已配置' : '未配置（设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET 后启用）'}`,
  );

  // 未配置时打出一次性 setup token，供初始配置通道使用
  const setupToken = ensureSetupToken(githubEnabled());
  if (setupToken) {
    console.log(`  初始配置令牌：${setupToken}`);
  }
  console.log(`  管理员：${hasAnyAdmin() ? '已存在' : '尚无 —— 第一个 GitHub 登录者将成为管理员'}\n`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
