import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleRange, cycleProgress } from './billing.js';

const at = (s: string) => new Date(`${s}T12:00:00Z`);

test('自然月：billingDay 为 0 时从 1 号切', () => {
  assert.deepEqual(cycleRange(0, at('2026-08-22')), { start: '2026-08-01', end: '2026-09-01' });
});

test('账单日之后：周期从本月账单日开始', () => {
  // 8/22 已过 21 号 → 当前周期是 8/21 ~ 9/21
  assert.deepEqual(cycleRange(21, at('2026-08-22')), { start: '2026-08-21', end: '2026-09-21' });
});

test('账单日之前：周期还停在上个月', () => {
  // 8/15 还没到 21 号 → 当前周期是 7/21 ~ 8/21
  assert.deepEqual(cycleRange(21, at('2026-08-15')), { start: '2026-07-21', end: '2026-08-21' });
});

test('账单日当天：算作新周期的第一天', () => {
  assert.deepEqual(cycleRange(21, at('2026-08-21')), { start: '2026-08-21', end: '2026-09-21' });
});

test('跨年：1 月账单日之前要退回上一年 12 月', () => {
  assert.deepEqual(cycleRange(21, at('2027-01-10')), { start: '2026-12-21', end: '2027-01-21' });
});

test('月末夹取：31 号的账单日在 2 月落到 28 号', () => {
  // 2026 不是闰年，2 月 28 天
  assert.deepEqual(cycleRange(31, at('2026-02-15')), { start: '2026-01-31', end: '2026-02-28' });
});

test('月末夹取：闰年 2 月落到 29 号', () => {
  assert.deepEqual(cycleRange(31, at('2028-02-15')), { start: '2028-01-31', end: '2028-02-29' });
});

test('月末夹取：31 号在只有 30 天的月份落到 30 号', () => {
  assert.deepEqual(cycleRange(31, at('2026-04-20')), { start: '2026-03-31', end: '2026-04-30' });
});

test('从 2 月末进入 3 月：右边界回到 31 号', () => {
  assert.deepEqual(cycleRange(31, at('2026-03-05')), { start: '2026-02-28', end: '2026-03-31' });
});

test('非法 billingDay 退回自然月', () => {
  for (const bad of [-3, 32, 99, NaN]) {
    assert.deepEqual(
      cycleRange(bad, at('2026-08-22')),
      { start: '2026-08-01', end: '2026-09-01' },
      `billingDay=${bad}`,
    );
  }
});

test('周期首尾相接，不留缝也不重叠', () => {
  // 连续 14 个月滚一遍：每个周期的 end 必须正好是下一个周期的 start
  for (const day of [1, 15, 21, 28, 29, 30, 31]) {
    let cur = cycleRange(day, at('2026-01-10'));
    for (let i = 0; i < 14; i++) {
      // 站到 end 当天，算出的周期起点必须等于上一个周期的终点
      const next = cycleRange(day, at(cur.end));
      assert.equal(next.start, cur.end, `day=${day} 第 ${i} 次滚动出现断层`);
      assert.ok(next.end > next.start, `day=${day} 周期长度非正`);
      cur = next;
    }
  }
});

test('周期进度在两端取到 0 和接近 1', () => {
  assert.equal(cycleProgress(21, new Date('2026-08-21T00:00:00Z')), 0);
  const almost = cycleProgress(21, new Date('2026-09-20T23:00:00Z'));
  assert.ok(almost > 0.95 && almost < 1, `期望接近 1，实际 ${almost}`);
});
