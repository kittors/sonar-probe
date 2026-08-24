/**
 * 币种。
 *
 * 服务端有一份对应的定义（apps/server/src/settings.ts），改动时两边都要动 ——
 * 和 types.ts、permissions.ts 是同一个约定。
 *
 * 前端为什么要自己有一份：格式化发生在每一次渲染上，价格、成本、账本都要用。
 * 为了取一个货币符号去等一次网络请求，会让整页数字先闪一遍没有单位的裸数。
 */

export const CURRENCIES = [
  'USD', 'CNY', 'EUR', 'JPY', 'GBP', 'HKD', 'SGD', 'TWD', 'KRW', 'RUB', 'CAD', 'AUD',
] as const;

export type Currency = (typeof CURRENCIES)[number];

/**
 * decimals 不能一律给 2：日元、韩元、新台币在当地都不带小数，
 * 写成 "JP¥1200.00" 就像把"12 元"写成"12.00 元"。
 */
export const CURRENCY_META: Record<Currency, { symbol: string; label: string; decimals: number }> = {
  USD: { symbol: '$', label: '美元', decimals: 2 },
  CNY: { symbol: '¥', label: '人民币', decimals: 2 },
  EUR: { symbol: '€', label: '欧元', decimals: 2 },
  JPY: { symbol: 'JP¥', label: '日元', decimals: 0 },
  GBP: { symbol: '£', label: '英镑', decimals: 2 },
  HKD: { symbol: 'HK$', label: '港币', decimals: 2 },
  SGD: { symbol: 'S$', label: '新加坡元', decimals: 2 },
  TWD: { symbol: 'NT$', label: '新台币', decimals: 0 },
  KRW: { symbol: '₩', label: '韩元', decimals: 0 },
  RUB: { symbol: '₽', label: '卢布', decimals: 2 },
  CAD: { symbol: 'CA$', label: '加元', decimals: 2 },
  AUD: { symbol: 'A$', label: '澳元', decimals: 2 },
};

const CURRENCY_SET = new Set<string>(CURRENCIES);

export function normalizeCurrency(v: unknown, fallback: Currency = 'USD'): Currency {
  const s = String(v ?? '').toUpperCase();
  return CURRENCY_SET.has(s) ? (s as Currency) : fallback;
}

/**
 * 币种换算，以 USD 为基准。rates[c] 的含义是"1 USD 值多少个 c"。
 *
 * 和服务端 rates.ts 的 convert 是同一套算法。两边各算一次不是重复劳动 ——
 * 概览页的机器列表走 WebSocket 实时推送，成本要跟着一起动；
 * 再去拉一次 REST 汇总接口会让"在线 3/3"和"月度成本"来自两个不同时刻的快照。
 */
export function convertCurrency(
  amount: number,
  from: Currency,
  to: Currency,
  rates: Partial<Record<Currency, number>>,
): number {
  if (!Number.isFinite(amount)) return 0;
  if (from === to) return amount;
  const f = rates[from];
  const t = rates[to];
  // 0 或缺失的汇率会让除法算出 Infinity，一路传到界面上变成"月度成本 ∞"
  if (!f || !t || f <= 0 || t <= 0) return 0;
  return (amount / f) * t;
}

/** 一台机器摊到每个月的开销，折算成目标币种。 */
export function monthlyCostOf(
  node: { price: number; currency: string; billingCycle: 'monthly' | 'quarterly' | 'yearly' },
  to: Currency,
  rates: Partial<Record<Currency, number>>,
): number {
  if (!(node.price > 0)) return 0;
  const divisor = node.billingCycle === 'yearly' ? 12 : node.billingCycle === 'quarterly' ? 3 : 1;
  return convertCurrency(node.price / divisor, normalizeCurrency(node.currency), to, rates);
}
