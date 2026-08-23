/** 可复现的伪随机源 —— 同一个 seed 永远得到同一批机器，方便调试和演示。 */
export class Rng {
  private s: number;

  constructor(seed: number | string) {
    this.s = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
  }

  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)] as T;
  }

  /** 从数组里不重复地取 n 个 */
  sample<T>(arr: readonly T[], n: number): T[] {
    const pool = [...arr];
    const out: T[] = [];
    for (let i = 0; i < n && pool.length > 0; i++) {
      out.push(pool.splice(Math.floor(this.next() * pool.length), 1)[0] as T);
    }
    return out;
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Box-Muller 正态分布 */
  normal(mean = 0, stddev = 1): number {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

/**
 * Ornstein-Uhlenbeck 过程：围绕基线波动但始终被拉回来。
 * 直接用随机游走会漂移到不合理的值，用它才像真实的 CPU 曲线。
 */
export function ouStep(
  current: number,
  baseline: number,
  reversion: number,
  volatility: number,
  rng: Rng,
): number {
  return current + reversion * (baseline - current) + rng.normal(0, volatility);
}
