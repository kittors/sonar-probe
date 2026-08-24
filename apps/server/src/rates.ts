/**
 * 汇率。
 *
 * 面板要把一堆不同币种的账单折成一个数字给人看，这件事绕不开汇率。
 * 之前的做法是压根不换算 —— 把 12.9 美元、52 欧元、180 人民币直接加起来
 * 得到 244.9，再标个美元符号。那个数字没有任何含义。
 *
 * 三层取值，从高到低：
 *   1. 管理员手填的覆盖值 —— 认真记账的人会想用自己信用卡账单上的那个汇率，
 *      它和实时中间价本来就有出入，谁也别替谁做主；
 *   2. 自动拉取的最新值；
 *   3. 内置参考值 —— 拉不到时至少能给出量级正确的估算，
 *      并且会在界面上明说"这是内置参考值"，不装作是实时的。
 *
 * 所有汇率都以 USD 为基准存：ratesUsd[c] 表示 1 USD 值多少个 c。
 * 统一基准才能任意两币互转，否则加一个币种就要补一整行交叉汇率。
 */

import { db } from './db.js';
import {
  CURRENCIES,
  getSettings,
  normalizeCurrency,
  type Currency,
} from './settings.js';

/**
 * 内置参考汇率，1 USD = N。
 *
 * 只用于"一次都没拉到过"的情况。数值必然会过时，所以任何用到它的地方
 * 都要把 stale 标记一并带给前端 —— 拿一个 2026 年的汇率算 2028 年的账单
 * 而不加任何说明，比干脆不显示更容易误导人。
 *
 * HKD 是个例外：港币实行联系汇率制，被锚定在 7.75–7.85 区间，
 * 这一项即使几年不更新也不会离谱。
 */
const FALLBACK_RATES: Record<Currency, number> = {
  USD: 1,
  CNY: 7.1,
  EUR: 0.92,
  JPY: 150,
  GBP: 0.79,
  HKD: 7.8,
  SGD: 1.34,
  TWD: 32,
  KRW: 1350,
  RUB: 90,
  CAD: 1.36,
  AUD: 1.52,
};

/**
 * 汇率源。按顺序试，第一个成功的算数。
 *
 * 两个都是无需 API key 的公开端点，请求里不带任何查询参数，
 * 也就不会把面板的任何信息带出去 —— 对方只知道"有个 IP 问了一次汇率"。
 * 备用源走 jsdelivr CDN，在主源被墙或限流时还有一条路。
 */
const RATE_SOURCES: Array<{
  name: string;
  url: string;
  parse: (json: unknown) => Record<string, unknown> | null;
}> = [
  {
    name: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: (json) => {
      const o = json as { result?: string; rates?: Record<string, unknown> };
      if (o?.result !== 'success' || !o.rates) return null;
      return o.rates;
    },
  },
  {
    name: 'jsdelivr currency-api',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    parse: (json) => {
      // 这个源的键是小写币种码，值嵌在 { usd: { cny: 7.1, ... } } 里
      const o = json as { usd?: Record<string, unknown> };
      if (!o?.usd) return null;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o.usd)) out[k.toUpperCase()] = v;
      return out;
    },
  },
];

export interface RateSnapshot {
  /** 1 USD = N，只含面板支持的币种 */
  rates: Partial<Record<Currency, number>>;
  /** 拉取成功的时刻；0 表示从没成功过 */
  fetchedAt: number;
  source: string;
  /** 最近一次失败的原因，成功后清空 */
  lastError: string;
  /** 最近一次尝试的时刻，成功失败都记 —— 用来做退避，别一直撞墙 */
  lastAttempt: number;
}

const EMPTY_SNAPSHOT: RateSnapshot = {
  rates: {},
  fetchedAt: 0,
  source: '',
  lastError: '',
  lastAttempt: 0,
};

const RATES_KEY = 'rates';

function readSnapshot(): RateSnapshot {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(RATES_KEY) as
    | { value: string }
    | undefined;
  if (!row) return { ...EMPTY_SNAPSHOT };
  try {
    const parsed = JSON.parse(row.value) as Partial<RateSnapshot>;
    return {
      rates: sanitizeRates(parsed.rates),
      fetchedAt: Number(parsed.fetchedAt) || 0,
      source: String(parsed.source ?? ''),
      lastError: String(parsed.lastError ?? ''),
      lastAttempt: Number(parsed.lastAttempt) || 0,
    };
  } catch {
    return { ...EMPTY_SNAPSHOT };
  }
}

function writeSnapshot(snap: RateSnapshot): void {
  db.prepare('INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)').run(
    RATES_KEY,
    JSON.stringify(snap),
    Date.now(),
  );
}

/**
 * 只留下面板认识、且数值站得住的那些。
 *
 * 外部接口的返回值不能直接信：多一个币种是小事，混进一个 0 或者字符串
 * 就会让后面的除法算出 Infinity，一路传到界面上变成"月度成本 ∞"。
 */
function sanitizeRates(raw: unknown): Partial<Record<Currency, number>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<Currency, number>> = {};
  for (const code of CURRENCIES) {
    const v = Number((raw as Record<string, unknown>)[code]);
    if (Number.isFinite(v) && v > 0) out[code] = v;
  }
  return out;
}

// ————————————————————————————————————————————————————————
// 拉取
// ————————————————————————————————————————————————————————

/** 拉取超时。汇率不是关键路径，宁可放弃也不能拖住调用它的定时任务。 */
const FETCH_TIMEOUT_MS = 8_000;

/**
 * 去拉一次汇率。
 *
 * 不抛异常 —— 汇率拉不到只是"这个数字暂时不够新"，不该让调用方（启动流程、
 * 定时任务）跟着倒下。失败原因写进快照，界面上如实显示。
 */
export async function refreshRates(): Promise<RateSnapshot> {
  const prev = readSnapshot();
  const attempt = Date.now();
  const errors: string[] = [];

  for (const source of RATE_SOURCES) {
    try {
      const res = await fetch(source.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        errors.push(`${source.name}: HTTP ${res.status}`);
        continue;
      }
      const parsed = source.parse(await res.json());
      const rates = sanitizeRates(parsed);

      // USD 是基准，它必然是 1；连一个别的币种都没解析出来说明格式变了
      if (Object.keys(rates).length < 2) {
        errors.push(`${source.name}: 返回里没有可用汇率`);
        continue;
      }
      rates.USD = 1;

      const snap: RateSnapshot = {
        rates,
        fetchedAt: attempt,
        source: source.name,
        lastError: '',
        lastAttempt: attempt,
      };
      writeSnapshot(snap);
      return snap;
    } catch (err) {
      errors.push(`${source.name}: ${err instanceof Error ? err.message : '请求失败'}`);
    }
  }

  // 全都失败：保留上一次拉到的汇率继续用，只更新失败信息。
  // 把旧汇率一起丢掉毫无好处 —— 昨天的汇率远比内置的参考值靠谱。
  const snap: RateSnapshot = {
    ...prev,
    lastError: errors.join('；'),
    lastAttempt: attempt,
  };
  writeSnapshot(snap);
  return snap;
}

/** 汇率超过这个岁数就该刷了。一天一次对账单换算完全够用。 */
const MAX_AGE_MS = 24 * 3600_000;
/** 失败后至少隔这么久再试，免得网络不通时每分钟撞一次墙。 */
const RETRY_AFTER_MS = 30 * 60_000;

/** 该不该现在去拉。启动时和定时任务都问它。 */
export function shouldRefresh(now = Date.now()): boolean {
  if (!getSettings().autoRefreshRates) return false;
  const snap = readSnapshot();
  if (now - snap.fetchedAt < MAX_AGE_MS) return false;
  if (now - snap.lastAttempt < RETRY_AFTER_MS) return false;
  return true;
}

export async function refreshRatesIfStale(): Promise<void> {
  if (shouldRefresh()) await refreshRates();
}

// ————————————————————————————————————————————————————————
// 生效汇率与换算
// ————————————————————————————————————————————————————————

export interface EffectiveRates {
  /** 1 USD = N，每个币种都有值 */
  rates: Record<Currency, number>;
  /** 哪些币种用的是管理员手填的值 */
  overridden: Currency[];
  /** 数据有多新；0 表示全靠内置参考值 */
  fetchedAt: number;
  source: string;
  lastError: string;
  /** 除手填项外，是否全部落在内置参考值上 */
  usingFallback: boolean;
  /** 拉到过，但已经超过一天没更新 */
  stale: boolean;
}

/** 算出当前实际生效的一整套汇率，附带它有多可信。 */
export function effectiveRates(now = Date.now()): EffectiveRates {
  const { rateOverrides } = getSettings();
  const snap = readSnapshot();

  const rates = {} as Record<Currency, number>;
  const overridden: Currency[] = [];
  let fetchedCount = 0;

  for (const code of CURRENCIES) {
    const manual = rateOverrides[code];
    if (manual && manual > 0) {
      rates[code] = manual;
      overridden.push(code);
      continue;
    }
    const fetched = snap.rates[code];
    if (fetched && fetched > 0) {
      rates[code] = fetched;
      fetchedCount++;
      continue;
    }
    rates[code] = FALLBACK_RATES[code];
  }

  // USD 是基准，任何来源都不该改它
  rates.USD = 1;

  return {
    rates,
    overridden,
    fetchedAt: snap.fetchedAt,
    source: snap.source,
    lastError: snap.lastError,
    usingFallback: fetchedCount === 0,
    stale: snap.fetchedAt > 0 && now - snap.fetchedAt > MAX_AGE_MS,
  };
}

/**
 * 币种换算。
 *
 * 先折回 USD 再折到目标币种。rates 里的值在写入时已经保证 > 0，
 * 但这里仍然挡一道 —— 这个函数会被求和循环反复调用，一个 0 能把
 * 整个月度成本变成 Infinity，代价太大了。
 */
export function convert(
  amount: number,
  from: Currency,
  to: Currency,
  rates: Record<Currency, number>,
): number {
  if (!Number.isFinite(amount)) return 0;
  if (from === to) return amount;
  const fromRate = rates[from];
  const toRate = rates[to];
  if (!fromRate || !toRate || fromRate <= 0 || toRate <= 0) return 0;
  return (amount / fromRate) * toRate;
}

/** 供接口直接返回的形态。 */
export function ratesPayload() {
  const eff = effectiveRates();
  return {
    base: 'USD' as const,
    displayCurrency: normalizeCurrency(getSettings().displayCurrency),
    rates: eff.rates,
    overridden: eff.overridden,
    fetchedAt: eff.fetchedAt,
    source: eff.source,
    lastError: eff.lastError,
    usingFallback: eff.usingFallback,
    stale: eff.stale,
    autoRefresh: getSettings().autoRefreshRates,
  };
}
