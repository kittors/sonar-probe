import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 密码哈希
 *
 * 用 Node 内置的 scrypt，不引第三方库。这不是图省事 —— 整个项目刻意避开需要
 * 编译的原生模块（数据库用的是 node:sqlite 而不是 better-sqlite3），argon2 和
 * bcrypt 的主流实现都要编译，装一个进来，面板就从"解压即跑"变成"得先有工具链"。
 *
 * scrypt 是内存硬的 KDF，抗 GPU/ASIC 爆破的能力和 argon2 同代，足够用来存后台密码。
 *
 * ——————————————————————————————————————————————
 *
 * **必须用异步版本。**
 *
 * scryptSync 会把 Fastify 的事件循环整个卡住 —— 一次运算几十到上百毫秒，
 * 期间所有请求（包括 agent 上报和 WebSocket 心跳）全部排队。登录接口天然是
 * 未认证可达的，等于给了任何人一个稳定的拒绝服务手柄。
 */

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/*
 * N=2^14, r=8, p=1 是 OWASP 给 scrypt 的推荐下限。
 *
 * 内存开销约 128 * N * r = 16 MiB。再往上翻一档（N=2^15）要 32 MiB，正好顶到
 * Node 的 maxmem 默认值，在小内存 VPS 上（这个项目的典型部署环境）也更容易出问题。
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;

/** 存储格式：scrypt$N$r$p$salt$hash，两段都是 base64。参数写进去，将来调参不会让旧密码失效。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * 校验密码。
 *
 * 任何解析失败都返回 false 而不是抛错：库里存着一条格式坏掉的记录时，
 * 应该是这个人登不上，而不是登录接口整个 500。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // 别拿库里的参数去开一块任意大的内存 —— 那是一条从数据库到 OOM 的路径
  if (n > 1 << 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * 账号不存在时也要烧掉同样的时间。
 *
 * 否则"用户名不存在"会比"密码错了"快上两个数量级，任何人都能拿这个时间差
 * 把面板当成用户名字典来枚举 —— 而管理员的用户名一旦确认，爆破就有了明确的靶子。
 */
export async function burnPasswordTime(password: string): Promise<void> {
  try {
    await scryptAsync(password, DUMMY_SALT, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  } catch {
    // 只为耗时，结果不重要
  }
}

const DUMMY_SALT = randomBytes(SALT_BYTES);

// ————————————————————————————————————————————————————————
// 强度
// ————————————————————————————————————————————————————————

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/**
 * 密码强度。
 *
 * 门槛定在"10 位 + 两类字符"，比常见的"8 位 + 大小写数字符号全都要"宽松。
 * 这是有意的：过于苛刻的组合规则会把人逼向 `Passw0rd!` 这种满足所有规则、
 * 却在任何字典里排前一百的密码。长度才是真正起作用的那一项。
 *
 * 上限 200 位不是安全考虑，是防止有人拿一兆字节的字符串来喂 scrypt。
 */
export function checkPasswordStrength(password: string, context: { username?: string; name?: string } = {}): string | null {
  if (typeof password !== 'string') return '密码格式不对';
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (password.length > PASSWORD_MAX) return `密码最多 ${PASSWORD_MAX} 位`;
  if (password.trim().length !== password.length) return '密码首尾不能有空格';

  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;
  if (classes < 2) return '密码至少要包含两类字符（大写、小写、数字、符号）';

  const lower = password.toLowerCase();
  const username = context.username?.trim().toLowerCase();
  if (username && username.length >= 3 && lower.includes(username)) {
    return '密码里不能包含用户名';
  }

  // 一位一位递增或全同的串长度再长也没有强度可言
  if (/^(.)\1+$/.test(password)) return '密码不能是同一个字符重复';

  return null;
}

/**
 * 生成初始密码。
 *
 * 用无歧义字符集：去掉了 0/O、1/l/I —— 这串东西是要从服务器日志里抄到
 * 浏览器里的，认错一个字符的代价是一次无谓的排查。
 */
export function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    // 取模会让靠前的字符略微高频。字母表 57 个、字节 256 个，偏差可忽略，
    // 但既然只是多一行，就按拒绝采样来做，省得日后被当成一个真问题来查
    const b = bytes[i]!;
    if (b >= 256 - (256 % alphabet.length)) continue;
    out += alphabet[b % alphabet.length];
  }
  return out;
}
