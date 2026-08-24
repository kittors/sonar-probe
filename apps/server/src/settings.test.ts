import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * 通用设置 + 多币种成本汇总。
 *
 * 重点是成本那一段。原来的实现是 `sum + n.price / divisor` —— 不看币种，
 * 把各国货币的面值直接相加，再统一标一个美元符号。三台机器分别 12.9 美元、
 * 52 欧元、180 人民币时它给出 244.9，而真实支出约合 94 美元。
 * 这里用的正是那组数字，下面那条断言就是这个 bug 的回归防线。
 *
 * db.ts 在模块加载时就读 SONAR_DB 建库，所以环境变量必须在 import 之前设好，
 * 只能用动态 import。
 */

const GB = 1024 ** 3;

let dir: string;
let db: import('node:sqlite').DatabaseSync;
let store: typeof import('./store.js');
let settings: typeof import('./settings.js');
let rates: typeof import('./rates.js');
let billing: typeof import('./billing.js');

/** 固定一组汇率，测试不该依赖外网。 */
function seedRates(table: Record<string, number>): void {
  db.prepare('INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)').run(
    'rates',
    JSON.stringify({
      rates: table,
      fetchedAt: Date.now(),
      source: 'test',
      lastError: '',
      lastAttempt: Date.now(),
    }),
    Date.now(),
  );
}

function addNode(
  id: string,
  price: number,
  currency: string,
  cycle: 'monthly' | 'quarterly' | 'yearly',
  expireAt = 0,
): void {
  db.prepare(
    `INSERT INTO nodes (id, name, hostname, ip, price, currency, billing_cycle, expire_at, created_at, last_seen, source)
     VALUES (?,?,?,?,?,?,?,?,0,0,'agent')`,
  ).run(id, id, `${id}.host`, '1.2.3.4', price, currency, cycle, expireAt);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sonar-settings-test-'));
  process.env.SONAR_DB = join(dir, 'test.db');
  db = (await import('./db.js')).db;
  settings = await import('./settings.js');
  rates = await import('./rates.js');
  store = await import('./store.js');
  billing = await import('./billing.js');

  seedRates({ USD: 1, CNY: 7.2, EUR: 0.92, JPY: 150, HKD: 7.8 });
});

after(() => rmSync(dir, { recursive: true, force: true }));

// ————————————————————————————————————————————————————————
// 存取与校验
// ————————————————————————————————————————————————————————

test('没存过设置时返回默认值', () => {
  assert.equal(settings.getSettings().byteBase, 1024);
  assert.equal(settings.getSettings().displayCurrency, 'USD');
  assert.equal(settings.getSettings().timezone, 'UTC');
});

test('越界的数值被夹回合法区间，而不是原样存进去', () => {
  const s = settings.updateSettings({
    cpuWarnPercent: 500,
    offlineAfterSeconds: 1,
    loadWarnRatio: -3,
    quotaWarnPercent: 0,
  });
  assert.equal(s.cpuWarnPercent, 99, '告警线上限 99 —— 设成 100 等于永不告警');
  assert.equal(s.offlineAfterSeconds, 5, 'agent 3 秒一报，再低会把正常机器判成离线');
  assert.equal(s.loadWarnRatio, 0.5);
  assert.equal(s.quotaWarnPercent, 10);
});

test('非法币种和时区退回原值，不会把设置写坏', () => {
  const before = settings.getSettings();
  const s = settings.updateSettings({
    displayCurrency: '比特币' as never,
    timezone: 'Mars/Olympus',
  });
  assert.equal(s.displayCurrency, before.displayCurrency);
  assert.equal(s.timezone, before.timezone);
});

test('合法时区能存进去', () => {
  assert.equal(settings.updateSettings({ timezone: 'Asia/Shanghai' }).timezone, 'Asia/Shanghai');
  settings.updateSettings({ timezone: 'UTC' });
});

test('汇率覆盖里 0 和负数被丢弃 —— 它们会让换算除出 Infinity', () => {
  const s = settings.updateSettings({
    rateOverrides: { CNY: 7.35, EUR: 0, JPY: -1, USD: 1 } as never,
  });
  assert.equal(s.rateOverrides.CNY, 7.35);
  assert.equal(s.rateOverrides.EUR, undefined);
  assert.equal(s.rateOverrides.JPY, undefined);
  settings.updateSettings({ rateOverrides: {} });
});

test('部分更新不会清掉没提到的字段', () => {
  settings.updateSettings({ cpuWarnPercent: 80, memWarnPercent: 70 });
  settings.updateSettings({ cpuWarnPercent: 85 });
  assert.equal(settings.getSettings().memWarnPercent, 70, '没传的字段应保持原值');
  settings.updateSettings({ cpuWarnPercent: 92, memWarnPercent: 92 });
});

// ————————————————————————————————————————————————————————
// 币种换算
// ————————————————————————————————————————————————————————

test('手填汇率优先于自动拉取的值', () => {
  settings.updateSettings({ rateOverrides: { CNY: 7.35 } });
  const eff = rates.effectiveRates();
  assert.equal(eff.rates.CNY, 7.35);
  assert.equal(eff.rates.EUR, 0.92, '没覆盖的仍走自动拉取的值');
  assert.ok(eff.overridden.includes('CNY'));
  settings.updateSettings({ rateOverrides: {} });
});

test('没拉到过的币种落到内置参考值，且标记为兜底', () => {
  // seedRates 里没给 GBP，它只能走内置值
  assert.ok(rates.effectiveRates().rates.GBP > 0);
});

test('缺失或为 0 的汇率不会换算出 Infinity', () => {
  assert.equal(rates.convert(100, 'EUR', 'USD', { EUR: 0 } as never), 0);
  assert.equal(rates.convert(100, 'EUR', 'USD', {} as never), 0);
});

// ————————————————————————————————————————————————————————
// 月度成本 —— 本次修复的核心
// ————————————————————————————————————————————————————————

test('多币种汇总：折算后相加，而不是把面值直接堆在一起', () => {
  addNode('usd-box', 12.9, 'USD', 'monthly');
  addNode('eur-box', 52, 'EUR', 'monthly');
  addNode('cny-box', 180, 'CNY', 'monthly');

  const s = store.getFleetSummary();

  // 12.9 + 52/0.92 + 180/7.2 = 12.9 + 56.52 + 25 = 94.42
  assert.equal(s.costCurrency, 'USD');
  assert.ok(
    Math.abs(s.monthlyCost - 94.42) < 0.02,
    `折算后应约合 $94.42，实际 ${s.monthlyCost}`,
  );
  assert.notEqual(
    s.monthlyCost,
    244.9,
    '244.9 是把欧元和人民币当美元直接相加的结果，正是这次要修的 bug',
  );
});

test('换算前的各币种明细也要给出来', () => {
  const byCurrency = store.getFleetSummary().costByCurrency;
  const cny = byCurrency.find((c) => c.currency === 'CNY');
  assert.equal(cny?.amount, 180, '人民币那台原值就是 180，不该被换算过');
  assert.equal(cny?.nodes, 1);
  assert.equal(byCurrency.length, 3);
});

test('换展示货币时整个汇总跟着换', () => {
  settings.updateSettings({ displayCurrency: 'CNY' });
  const s = store.getFleetSummary();
  // 94.42 美元 × 7.2 ≈ 679.8 人民币
  assert.equal(s.costCurrency, 'CNY');
  assert.ok(Math.abs(s.monthlyCost - 679.82) < 0.2, `实际 ${s.monthlyCost}`);
  settings.updateSettings({ displayCurrency: 'USD' });
});

test('年付和季付摊到每个月', () => {
  addNode('yearly-box', 120, 'USD', 'yearly');
  addNode('quarterly-box', 30, 'USD', 'quarterly');
  // 年付 120 → 每月 10；季付 30 → 每月 10
  const s = store.getFleetSummary();
  assert.ok(Math.abs(s.monthlyCost - (94.42 + 20)) < 0.02, `实际 ${s.monthlyCost}`);
});

test('已过期的机器默认不计入 —— 到期就不再扣费了', () => {
  addNode('dead-box', 999, 'USD', 'monthly', Date.now() - 86_400_000);
  const excluded = store.getFleetSummary();
  assert.ok(Math.abs(excluded.monthlyCost - 114.42) < 0.02, `实际 ${excluded.monthlyCost}`);

  settings.updateSettings({ costIncludeExpired: true });
  const included = store.getFleetSummary();
  assert.ok(Math.abs(included.monthlyCost - 1113.42) < 0.02, `实际 ${included.monthlyCost}`);
  settings.updateSettings({ costIncludeExpired: false });
});

test('没填价格的机器不算数，也不撑起 pricedNodes', () => {
  addNode('free-box', 0, 'USD', 'monthly');
  const s = store.getFleetSummary();
  assert.equal(s.pricedNodes, 5, '6 台机器里有价格的是 5 台（过期那台被排除）');
  assert.ok(Math.abs(s.monthlyCost - 114.42) < 0.02);
});

// ————————————————————————————————————————————————————————
// 流量口径
// ————————————————————————————————————————————————————————

test('计费方向决定收发怎么合并', () => {
  assert.equal(settings.trafficTotal(30, 70, 'both'), 100);
  assert.equal(settings.trafficTotal(30, 70, 'tx'), 70);
  assert.equal(settings.trafficTotal(30, 70, 'rx'), 30);
});

test('只计出站的机房里，配额不该把入站算进去', () => {
  db.prepare('INSERT INTO daily_traffic (node_id, day, rx, tx) VALUES (?,?,?,?)').run(
    'usd-box',
    settings.dayKeyIn('UTC'),
    100 * GB,
    40 * GB,
  );

  settings.updateSettings({ trafficDirection: 'both' });
  assert.equal(store.measuredCycleTraffic('usd-box'), 140 * GB);

  settings.updateSettings({ trafficDirection: 'tx' });
  assert.equal(store.measuredCycleTraffic('usd-box'), 40 * GB);

  settings.updateSettings({ trafficDirection: 'rx' });
  assert.equal(store.measuredCycleTraffic('usd-box'), 100 * GB);

  settings.updateSettings({ trafficDirection: 'both' });
});

// ————————————————————————————————————————————————————————
// 时区
// ————————————————————————————————————————————————————————

test('同一时刻在不同时区可能属于不同的一天', () => {
  // 北京时间 2026-08-24 早上 7:00 = UTC 2026-08-23 23:00
  const ts = Date.parse('2026-08-23T23:00:00Z');
  assert.equal(settings.dayKeyIn('UTC', ts), '2026-08-23');
  assert.equal(settings.dayKeyIn('Asia/Shanghai', ts), '2026-08-24');
});

test('账单日边界按面板时区判定', () => {
  // 账单日 24 号。UTC 还停在 23 号 → 仍属上个周期；北京已是 24 号 → 新周期开始
  const now = new Date(Date.parse('2026-08-23T23:00:00Z'));
  assert.equal(billing.cycleRange(24, now, 'UTC').start, '2026-07-24');
  assert.equal(billing.cycleRange(24, now, 'Asia/Shanghai').start, '2026-08-24');
});

test('时区缺省仍是 UTC，老行为不变', () => {
  const now = new Date(Date.parse('2026-08-23T23:00:00Z'));
  assert.deepEqual(billing.cycleRange(24, now), billing.cycleRange(24, now, 'UTC'));
});

test('跨月那几个小时，月份也要按面板时区取', () => {
  const ts = Date.parse('2026-08-31T23:00:00Z');
  assert.equal(settings.monthKeyIn('UTC', ts), '2026-08');
  assert.equal(settings.monthKeyIn('Asia/Shanghai', ts), '2026-09');
});

// ————————————————————————————————————————————————————————
// 告警阈值
// ————————————————————————————————————————————————————————

test('告警线调低之后，原本正常的机器会被标成告警', () => {
  db.prepare(
    `INSERT INTO metrics (node_id,ts,cpu,mem_used,swap_used,disk_used,load1,load5,load15,
       net_rx,net_tx,net_rx_total,net_tx_total,tcp_conns,udp_conns,processes,uptime,disk_read,disk_write)
     VALUES ('usd-box',?,55,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)`,
  ).run(Date.now());
  db.prepare('UPDATE nodes SET last_seen=? WHERE id=?').run(Date.now(), 'usd-box');

  settings.updateSettings({ cpuWarnPercent: 92 });
  assert.equal(store.getNodeState('usd-box')?.status, 'online', 'CPU 55% 在 92 线以下');

  settings.updateSettings({ cpuWarnPercent: 50 });
  assert.equal(store.getNodeState('usd-box')?.status, 'warning', 'CPU 55% 越过了 50 线');

  settings.updateSettings({ cpuWarnPercent: 92 });
});

test('到期提醒窗口跟着设置走，不再前后端各说各话', () => {
  addNode('expiring-box', 5, 'USD', 'monthly', Date.now() + 10 * 86_400_000);

  settings.updateSettings({ expiryWarnDays: 7 });
  assert.equal(store.getFleetSummary().expiringSoon, 0, '还有 10 天，7 天窗口内不该报');

  settings.updateSettings({ expiryWarnDays: 30 });
  assert.equal(store.getFleetSummary().expiringSoon, 1, '30 天窗口内应该报');

  settings.updateSettings({ expiryWarnDays: 7 });
});

test('已过期的机器算「已过期」，不算「即将到期」', () => {
  // dead-box 在上面已经插入，过期一天。判定若写成 `expireAt - now < 窗口`，
  // 负数天然满足，它就会被数进"7 天内到期"里 —— 那句话对它是错的
  const s = store.getFleetSummary();
  assert.equal(s.expired, 1);
  assert.equal(s.expiringSoon, 0, '过期一天的机器不该出现在「即将到期」里');
});
