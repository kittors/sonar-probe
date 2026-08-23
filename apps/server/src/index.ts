import { consume, retryAfter } from './ratelimit.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { WebSocket } from 'ws';

import { db, pruneMetrics, purgeSimulatedData } from './db.js';
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
  updateNode,
  type NodePatch,
} from './store.js';
import {
  ALL_CAPABILITIES,
  groupedCapabilities,
  ROLE_LABEL,
  resolveCapabilities,
  type Capability,
  type Role,
} from './permissions.js';
import {
  activeAdminCount,
  audit,
  consumeState,
  cookieName,
  cookieOptions,
  createGuest,
  createSession,
  exchangeGithubCode,
  githubAuthorizeUrl,
  githubConfig,
  githubEnabled,
  hasAnyAdmin,
  issueState,
  listAudit,
  listOnline,
  listSessions,
  listUsers,
  loadSession,
  pruneSessions,
  revokeSession,
  revokeUserSessions,
  touchSession,
  updateUser,
  upsertGithubUser,
  visitorSummary,
  type AuthContext,
} from './auth.js';
import {
  agentIngestEnabled,
  agentNodeIds,
  agentTokenValid,
  ingestReport,
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
import type { BlockMode, NodeState, ServerMessage } from './types.js';

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
 * 拦不拦得住由每个路由的 requireCap 决定 —— anonymous 只有 node:list，
 * 所以详情、流量归因、封禁这些自然就进不去。
 */
const ANONYMOUS: AuthContext = {
  user: {
    id: '',
    kind: 'guest',
    login: '',
    name: '未登录访客',
    avatar: '',
    email: '',
    role: 'anonymous',
    granted: [],
    revoked: [],
    disabled: false,
    createdAt: 0,
    lastSeen: 0,
    note: '',
  },
  sessionId: '',
  caps: resolveCapabilities('anonymous'),
};

app.decorateRequest('auth', null);

app.addHook('onRequest', async (req) => {
  const session = loadSession(req.cookies[cookieName]);
  if (session) {
    touchSession(session.sessionId, session.user.id);
    req.auth = session;
  } else {
    req.auth = ANONYMOUS;
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
 * 能力守卫。
 *
 * 前端也会按能力隐藏按钮，但那只是不碍眼 —— 真正拦住越权请求的是这里。
 * 任何有后果的接口都必须挂上它。
 */
function requireCap(cap: Capability) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.auth?.caps.has(cap)) return;

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

app.get('/ws', { websocket: true }, (socket, req) => {
  // 匿名也能连：概览页是公开状态页，实时刷新对未登录的人一样生效。
  // 推什么由 caps 决定，anonymous 拿到的节点数据是脱敏过的。
  const ctx = loadSession(req.cookies[cookieName]) ?? ANONYMOUS;

  clients.set(socket, ctx);
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
  needsBootstrap: !hasAnyAdmin(),
  guestEnabled: process.env.SONAR_DISABLE_GUEST !== '1',
}));

app.get<{ Querystring: { redirect?: string } }>('/api/auth/github', async (req, reply) => {
  if (!githubEnabled()) {
    return reply.code(503).send({ error: 'GitHub 登录未配置，请在服务端设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET' });
  }
  const state = issueState(req.query.redirect ?? '/');
  return reply.redirect(githubAuthorizeUrl(state));
});

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
      const { user, firstAdmin } = upsertGithubUser(profile);

      if (user.disabled) {
        return reply.redirect(`${PUBLIC_URL}/?login_error=disabled`);
      }

      const sid = createSession(user.id, ip(req), ua(req));
      audit({
        userId: user.id,
        sessionId: sid,
        action: 'login',
        target: 'github',
        detail: firstAdmin ? '首次登录，已自动成为管理员' : `以 ${ROLE_LABEL[user.role]} 身份登录`,
        ip: ip(req),
        userAgent: ua(req),
      });
      if (firstAdmin) {
        logEvent(null, 'warn', 'auth', `${user.login} 首次通过 GitHub 登录，已成为管理员`);
      }

      reply.setCookie(cookieName, sid, cookieOptions(SECURE_COOKIE));
      return reply.redirect(`${PUBLIC_URL}${checked.redirect}`);
    } catch (err) {
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
  return { user: publicUser(user), capabilities: [...resolveCapabilities(user.role, user.granted, user.revoked)] };
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
  id: string; kind: string; login: string; name: string; avatar: string;
  role: Role; createdAt: number; lastSeen: number; note: string; email: string; disabled: boolean;
}) {
  return {
    id: u.id,
    kind: u.kind,
    login: u.login,
    name: u.name,
    avatar: u.avatar,
    email: u.email,
    role: u.role,
    roleLabel: ROLE_LABEL[u.role],
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
    note: u.note,
    disabled: u.disabled,
  };
}

app.get('/api/me', async (req, reply) => {
  // 匿名也返回 200，但 user 为 null —— 前端要拿 capabilities 决定概览页能显示到哪一层，
  // 直接回 401 的话前端就得为"未登录"再单开一条取权限的路
  if (!req.auth?.sessionId) {
    return reply.send({
      user: null,
      capabilities: [...ANONYMOUS.caps],
      sessionId: null,
    });
  }
  return reply.send({
    user: publicUser(req.auth.user),
    capabilities: [...req.auth.caps],
    sessionId: req.auth.sessionId,
  });
});

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

app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
  '/api/nodes/:id/traffic/daily',
  { preHandler: requireCap('traffic:daily') },
  async (req) => getDailyTraffic(req.params.id, clampInt(req.query.days, 30, 1, 90)),
);

app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
  '/api/nodes/:id/traffic/services',
  { preHandler: requireCap('traffic:services') },
  async (req) => getServiceTraffic(req.params.id, clampInt(req.query.days, 7, 1, 30)),
);

app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
  '/api/nodes/:id/traffic/peers',
  { preHandler: requireCap('traffic:peers') },
  async (req) => {
    const peers = getPeerTraffic(req.params.id, clampInt(req.query.limit, 50, 1, 200));
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

// —— 管理

app.get('/api/admin/capabilities', { preHandler: requireCap('user:view') }, async () => ({
  groups: groupedCapabilities(),
  roles: (Object.keys(ROLE_LABEL) as Role[]).map((r) => ({
    value: r,
    label: ROLE_LABEL[r],
    capabilities: [...resolveCapabilities(r)],
  })),
  all: ALL_CAPABILITIES,
}));

app.get('/api/admin/users', { preHandler: requireCap('user:view') }, async () =>
  listUsers().map((u) => ({
    ...publicUser(u),
    granted: u.granted,
    revoked: u.revoked,
    capabilities: [...resolveCapabilities(u.role, u.granted, u.revoked)],
  })),
);

app.patch<{
  Params: { id: string };
  Body: { role?: Role; granted?: string[]; revoked?: string[]; disabled?: boolean; note?: string };
}>('/api/admin/users/:id', { preHandler: requireCap('user:manage') }, async (req, reply) => {
  const target = req.params.id;
  const current = listUsers().find((u) => u.id === target);
  if (!current) return reply.code(404).send({ error: '用户不存在' });

  // 不能把自己降权 —— 手滑一次就再也进不了管理页了
  if (target === req.auth!.user.id && (req.body.role && req.body.role !== 'admin')) {
    return reply.code(409).send({ error: '不能修改自己的角色，请让另一位管理员操作' });
  }
  if (target === req.auth!.user.id && req.body.disabled) {
    return reply.code(409).send({ error: '不能停用自己的账号' });
  }

  // 也不能把最后一个管理员降权或停用，否则面板就没人能管了
  const losingAdmin =
    current.role === 'admin' &&
    ((req.body.role && req.body.role !== 'admin') || req.body.disabled === true);
  if (losingAdmin && activeAdminCount() <= 1) {
    return reply.code(409).send({ error: '这是最后一个管理员，先提升另一位再操作' });
  }

  const updated = updateUser(target, req.body);
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
  logEvent(null, 'warn', 'auth', `${req.auth!.user.login} 修改了 ${updated.name} 的权限`);

  return {
    ...publicUser(updated),
    granted: updated.granted,
    revoked: updated.revoked,
    capabilities: [...resolveCapabilities(updated.role, updated.granted, updated.revoked)],
  };
});

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
      return { ok: true, created };
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
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : '写入失败' });
  }

  // 面板还没有反向下发通道，先回空指令，agent 会安静地继续跑
  return { ok: true, commands: [] };
});

app.post<{ Body: { token?: string } }>('/api/agent/ack', async (req, reply) => {
  if (!agentTokenValid(req.body?.token)) {
    return reply.code(401).send({ error: 'agent token 不正确' });
  }
  return { ok: true };
});

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
  pruneMetrics();
  pruneSessions();
}, 60_000);

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
