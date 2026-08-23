import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 一次性初始配置通道
 *
 * 存在的理由很具体：GitHub 的 client secret 只在生成那一刻显示一次，
 * 而它是敏感凭据 —— 不该经过任何中间人（包括帮忙配置的自动化工具）的日志和上下文。
 *
 * 所以这里开一条直达通道：浏览器读到 secret 后直接 POST 给服务端写进 .env，
 * 中间不落地、不打印。
 *
 * 三重限制，避免它变成一个后门：
 *   1. 只在 OAuth 尚未配置时可用，配好之后接口自动失效
 *   2. 需要 setup token，而 token 只存在于服务器本地文件和 journal 里
 *   3. token 一旦用掉立即作废
 */

/**
 * 凭据和令牌都写在 data 目录里，不碰 .env。
 *
 * systemd 那边是 ProtectSystem=strict + ReadWritePaths=<data>，只有这一个目录可写。
 * 与其为了配置去放宽服务的写权限，不如让它只在自己的数据目录里落地 ——
 * 服务进程本来就不该有改自身配置文件的能力。
 */
const DATA_DIR = process.env.SONAR_DATA_DIR ?? resolve(process.cwd(), 'data');
const CREDS_PATH = resolve(DATA_DIR, 'oauth.json');
const TOKEN_PATH = resolve(DATA_DIR, '.setup-token');

let cachedToken: string | null = null;

/** 未配置 OAuth 时生成 setup token；已配置则清掉，不留悬空凭据。 */
export function ensureSetupToken(oauthConfigured: boolean): string | null {
  if (oauthConfigured) {
    cachedToken = null;
    try {
      if (existsSync(TOKEN_PATH)) writeFileSync(TOKEN_PATH, '', { mode: 0o600 });
    } catch {
      // 清不掉也不影响主流程
    }
    return null;
  }

  if (cachedToken) return cachedToken;

  // 复用磁盘上已有的，避免每次重启都换一个、让人拿着旧的对不上
  try {
    if (existsSync(TOKEN_PATH)) {
      const existing = readFileSync(TOKEN_PATH, 'utf8').trim();
      if (existing.length >= 20) {
        cachedToken = existing;
        return cachedToken;
      }
    }
  } catch {
    // 读不到就重新生成
  }

  cachedToken = randomBytes(18).toString('base64url');
  try {
    writeFileSync(TOKEN_PATH, cachedToken, { mode: 0o600 });
    chmodSync(TOKEN_PATH, 0o600);
  } catch {
    // 写不进去也无妨，token 在内存里同样有效（只是重启后会变）
  }
  return cachedToken;
}

export function setupTokenValid(token: unknown): boolean {
  if (!cachedToken || typeof token !== 'string') return false;
  if (token.length !== cachedToken.length) return false;
  // 长度已相等，逐字符比较即可
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ cachedToken.charCodeAt(i);
  return diff === 0;
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/** 把凭据落到 data/oauth.json，启动时会作为 env 的回退被读取。 */
export function writeOAuthCredentials(creds: OAuthCredentials): void {
  const id = creds.clientId.trim();
  const secret = creds.clientSecret.trim();

  if (!/^[A-Za-z0-9._-]{10,120}$/.test(id)) throw new Error('client id 格式不对');
  if (!/^[A-Za-z0-9._-]{20,255}$/.test(secret)) throw new Error('client secret 格式不对');

  writeFileSync(CREDS_PATH, JSON.stringify({ clientId: id, clientSecret: secret }), {
    mode: 0o600,
  });
  chmodSync(CREDS_PATH, 0o600);

  // token 用掉即作废
  cachedToken = null;
  try {
    writeFileSync(TOKEN_PATH, '', { mode: 0o600 });
  } catch {
    // 忽略
  }
}

/** 读取 setup 通道写入的凭据。没有就返回 null，由 env 那份兜底。 */
export function readStoredOAuth(): OAuthCredentials | null {
  try {
    const raw = readFileSync(CREDS_PATH, 'utf8');
    const j = JSON.parse(raw) as Partial<OAuthCredentials>;
    if (j.clientId && j.clientSecret) {
      return { clientId: j.clientId, clientSecret: j.clientSecret };
    }
  } catch {
    // 没配过就是这个分支，属正常
  }
  return null;
}
