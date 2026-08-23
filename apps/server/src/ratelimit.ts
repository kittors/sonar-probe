/**
 * 速率限制。
 *
 * 面板此前对任何接口都没有限制，其中两处是实打实的问题：
 *
 * - **访客登录**：一个 POST 就建一个用户加一个会话，没人拦的话几分钟就能把
 *   users / sessions 表灌满，磁盘和查询一起变慢。
 * - **agent 上报**：token 猜错不要钱，可以无限次试。
 *
 * 实现刻意做得很小：进程内的滑动窗口计数，不引依赖也不落库。单机部署足够；
 * 真要多副本跑再换共享存储，那时限流规则本身不用动。
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

/** 定期清理空桶，否则每个来过的 IP 都会在内存里留一条 */
let sweeper: ReturnType<typeof setInterval> | null = null;

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      // 十分钟内没有任何请求的桶直接扔掉
      if (b.hits.length === 0 || now - (b.hits[b.hits.length - 1] ?? 0) > 600_000) {
        buckets.delete(key);
      }
    }
  }, 120_000);
  // 别因为这个定时器把进程钉住不退出
  sweeper.unref?.();
}

/**
 * 消费一次配额。返回 false 表示超限。
 *
 * @param key    限流维度，通常是 `动作:IP`
 * @param limit  窗口内允许的次数
 * @param windowMs 窗口长度
 */
export function consume(key: string, limit: number, windowMs: number): boolean {
  ensureSweeper();
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { hits: [] };
    buckets.set(key, b);
  }
  const cutoff = now - windowMs;
  // 滑动窗口：丢掉窗口外的记录再判断
  b.hits = b.hits.filter((t) => t > cutoff);
  if (b.hits.length >= limit) return false;
  b.hits.push(now);
  return true;
}

/** 还要等多久才能再试，秒。用于 Retry-After */
export function retryAfter(key: string, windowMs: number): number {
  const b = buckets.get(key);
  const first = b?.hits[0];
  if (!first) return 1;
  return Math.max(1, Math.ceil((first + windowMs - Date.now()) / 1000));
}

/** 测试用：清空所有计数 */
export function resetRateLimits(): void {
  buckets.clear();
}
