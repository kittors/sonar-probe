/**
 * 流量周期。
 *
 * 单独成文件是为了能脱离数据库测试 —— 这里的月末夹取和跨年回退全是边界，
 * 靠肉眼看代码是看不出对错的。
 */

/**
 * 流量周期的起止日（YYYY-MM-DD，左闭右开）。
 *
 * billingDay 是每月的第几号，0 表示按自然月。很多 VPS 的额度从开通日算，
 * 不是每月 1 号 —— 按自然月统计的话，账单日附近的用量会算进错误的周期。
 *
 * 日期一律按 UTC 取。daily_traffic 的 day 字段就是 UTC 生成的，两边必须用
 * 同一个基准，否则边界那天会重复计入或整天漏掉。
 */
export function cycleRange(billingDay: number, now = new Date()): { start: string; end: string } {
  const day = billingDay >= 1 && billingDay <= 31 ? Math.floor(billingDay) : 1;

  /*
   * 某年某月的账单日。
   *
   * 月末必须夹取：账单日设成 31 号时 2 月只有 28 天，直接 Date.UTC(y, 1, 31)
   * 会溢出到 3 月 3 号，周期边界就整个错位了。
   * Date.UTC(y, m + 1, 0) 取的是"下个月的第 0 天"，也就是当月最后一天。
   */
  const anchor = (y: number, m: number): Date => {
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(day, lastDay)));
  };

  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();

  // 还没走到本月的账单日，说明当前还在上一个周期里。
  // 传 m-1 给 Date.UTC 会自动回退到上一年的 12 月，跨年不用特殊处理。
  let start = anchor(y, m);
  if (now.getUTCDate() < start.getUTCDate()) start = anchor(y, m - 1);

  const end = anchor(start.getUTCFullYear(), start.getUTCMonth() + 1);
  return { start: iso(start), end: iso(end) };
}

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 周期进度，用于"还剩几天重置"。返回 0-1。 */
export function cycleProgress(billingDay: number, now = new Date()): number {
  const { start, end } = cycleRange(billingDay, now);
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (e <= s) return 0;
  return Math.min(1, Math.max(0, (now.getTime() - s) / (e - s)));
}
