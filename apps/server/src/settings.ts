/**
 * 面板设置。
 *
 * 这里收的是"同一份数据，换个人看就该换个口径"的那些东西：流量按 1024 还是
 * 1000 进制、成本折成哪种货币、多少秒没上报算离线、流量周期从哪个时区切日。
 *
 * 它们原先是散在各文件里的字面量。散着写有两个真实代价：
 *   1. 同一件事在两处各写各的 —— 到期提醒前端写 7 天、汇总接口写 30 天，
 *      于是"3 台即将到期"和"1 台 7 天内到期"能同时出现在一个页面上；
 *   2. 口径本来就因人而异 —— 服务商标的"2TB 流量"几乎都是 1000 进制，
 *      面板按 1024 算就会让人以为快用超了。这种事没有"正确的默认值"，
 *      只有"让用户自己说了算"。
 *
 * 存成单行 JSON 而不是一列一个字段：加设置项的频率远高于查询设置项的频率，
 * 每加一项都改表结构不划算。读改写全在 Node 单线程里同步跑完，没有竞态。
 */

import { db } from './db.js';
import { isValidTimezone } from './tz.js';

export { civilDateIn, dayKeyIn, isValidTimezone, monthKeyIn, COMMON_TIMEZONES } from './tz.js';

// ————————————————————————————————————————————————————————
// 币种
// ————————————————————————————————————————————————————————

/**
 * 支持的币种。
 *
 * 挑的是 VPS 圈实际会用到的：美元是绝对主流，欧元/英镑对应欧洲机房，
 * 港币新台币新元对应亚太，卢布是因为便宜 VPS 有相当一批在俄罗斯。
 */
export const CURRENCIES = [
  'USD', 'CNY', 'EUR', 'JPY', 'GBP', 'HKD', 'SGD', 'TWD', 'KRW', 'RUB', 'CAD', 'AUD',
] as const;

export type Currency = (typeof CURRENCIES)[number];

/**
 * 币种展示信息。
 *
 * decimals 不能一律给 2：日元和韩元本身没有辅币单位，写成 "¥1200.00"
 * 在当地人看来就像把"12 元"写成"12.00 元"一样别扭。
 *
 * 符号也不能只认前三种 —— 之前 format.ts 里只有 USD/EUR/CNY 有符号，
 * 港币机器的价格会渲染成一个光秃秃的 "48.00"，看不出是什么钱。
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

// ————————————————————————————————————————————————————————
// 设置项
// ————————————————————————————————————————————————————————

/** 流量按哪个方向计费。很多机房只计出站，双向计费反而是少数。 */
export type TrafficDirection = 'both' | 'tx' | 'rx';

export interface Settings {
  // —— 面板身份
  /** 顶栏显示的名字。自部署的人常要改成自己的叫法 */
  panelName: string;
  panelTagline: string;

  // —— 成本与货币
  /** 汇总成本折算到哪种货币 */
  displayCurrency: Currency;
  /** 是否自动从公开汇率接口拉取。关掉后只用手填值和内置兜底值 */
  autoRefreshRates: boolean;
  /**
   * 手填汇率，含义是"1 USD = N 该币种"。
   *
   * 只存用户显式填过的项，填了就优先于自动拉取的值 —— 信用卡入账汇率
   * 和实时中间价本来就有差，认真记账的人会想用自己账单上的那个数。
   */
  rateOverrides: Partial<Record<Currency, number>>;
  /** 已过期的机器是否还算进月度成本。默认不算 —— 到期就不再扣费了 */
  costIncludeExpired: boolean;

  // —— 流量口径
  /**
   * 字节进制。
   *
   * 1024 是 Linux 工具链的口径（df、free、ip -s link 都这么算）；
   * 1000 是服务商账单的口径 —— 标称"2TB 流量"几乎都指 2×10¹² 字节。
   * 两者差 10%，落到 2TB 上就是 180 GB 的误判空间。
   */
  byteBase: 1024 | 1000;
  /** 单位是否写成 GiB/TiB。只在 1024 进制下有意义 */
  binaryUnitLabels: boolean;
  /** 配额和阈值按哪个方向的流量算 */
  trafficDirection: TrafficDirection;

  // —— 时间
  /**
   * IANA 时区，决定"今天"和"本周期"从几点切。
   *
   * 面板原先一律按 UTC 切日：UTC+8 的人在晚上 8 点看到"今日流量"归零，
   * 而服务商后台早在 8 小时前就翻页了，两边对不上账。
   */
  timezone: string;

  // —— 状态判定
  /** 超过这个时长没上报就算离线 */
  offlineAfterSeconds: number;
  /** 下面四项任一越线就把机器标成告警 */
  cpuWarnPercent: number;
  memWarnPercent: number;
  diskWarnPercent: number;
  /** 1 分钟负载超过"核心数 × 这个倍数"算告警 */
  loadWarnRatio: number;

  // —— 提醒
  /** 距到期还剩几天开始提醒 */
  expiryWarnDays: number;
  /** 周期流量用到配额的百分之多少开始提醒 */
  quotaWarnPercent: number;

  // —— 数据保留
  /** 高频采样保留多久。这张表最大，超过一天的明细基本没人回看 */
  metricRetentionHours: number;
  /** 审计日志保留多少天。0 表示永久保留 */
  auditRetentionDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  panelName: 'Sonar',
  panelTagline: '服务器探针',

  displayCurrency: 'USD',
  autoRefreshRates: true,
  rateOverrides: {},
  costIncludeExpired: false,

  // 进制、时区这几项的默认值刻意保持面板原有行为。
  // 升级一次面板就让所有历史数字变个样，比默认值不够贴心糟糕得多。
  byteBase: 1024,
  binaryUnitLabels: false,
  trafficDirection: 'both',

  timezone: 'UTC',

  offlineAfterSeconds: 30,
  cpuWarnPercent: 92,
  memWarnPercent: 92,
  diskWarnPercent: 90,
  loadWarnRatio: 2.5,

  expiryWarnDays: 7,
  quotaWarnPercent: 80,

  metricRetentionHours: 26,
  auditRetentionDays: 90,
};

// ————————————————————————————————————————————————————————
// 校验
// ————————————————————————————————————————————————————————

function clampNum(v: unknown, fallback: number, min: number, max: number, decimals = 0): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  const f = 10 ** decimals;
  return Math.round(clamped * f) / f;
}

function str(v: unknown, fallback: string, maxLen: number): string {
  if (typeof v !== 'string') return fallback;
  const s = v.trim().slice(0, maxLen);
  return s || fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function sanitizeRateOverrides(raw: unknown): Partial<Record<Currency, number>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<Currency, number>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const code = String(k).toUpperCase();
    if (!CURRENCY_SET.has(code)) continue;
    const n = Number(v);
    // 0 和负数不是"汇率没填"，是一个会让除法炸掉的值。一律丢弃
    if (!Number.isFinite(n) || n <= 0) continue;
    out[code as Currency] = Math.round(n * 1e6) / 1e6;
  }
  return out;
}

/** 把任意输入收敛成一份合法设置。未提供的项取 base（通常是当前值）。 */
export function sanitizeSettings(patch: Partial<Settings>, base: Settings = DEFAULT_SETTINGS): Settings {
  const p = patch ?? {};
  return {
    panelName: str(p.panelName, base.panelName, 30),
    panelTagline: p.panelTagline === undefined
      ? base.panelTagline
      // 副标题允许清空 —— 有人就是不想要那行小字
      : String(p.panelTagline).trim().slice(0, 40),

    displayCurrency: p.displayCurrency === undefined
      ? base.displayCurrency
      : normalizeCurrency(p.displayCurrency, base.displayCurrency),
    autoRefreshRates: bool(p.autoRefreshRates, base.autoRefreshRates),
    rateOverrides: p.rateOverrides === undefined
      ? base.rateOverrides
      : sanitizeRateOverrides(p.rateOverrides),
    costIncludeExpired: bool(p.costIncludeExpired, base.costIncludeExpired),

    byteBase: p.byteBase === undefined ? base.byteBase : Number(p.byteBase) === 1000 ? 1000 : 1024,
    binaryUnitLabels: bool(p.binaryUnitLabels, base.binaryUnitLabels),
    trafficDirection:
      p.trafficDirection === 'tx' || p.trafficDirection === 'rx' || p.trafficDirection === 'both'
        ? p.trafficDirection
        : base.trafficDirection,

    timezone: isValidTimezone(p.timezone) ? p.timezone : base.timezone,

    // 下限 5 秒：agent 默认 3 秒一报，再低就会把正常机器判成离线
    offlineAfterSeconds: clampNum(p.offlineAfterSeconds, base.offlineAfterSeconds, 5, 3600),
    // 告警线不允许设到 100 —— 那等于永远不告警，不如把这项关了更诚实
    cpuWarnPercent: clampNum(p.cpuWarnPercent, base.cpuWarnPercent, 10, 99),
    memWarnPercent: clampNum(p.memWarnPercent, base.memWarnPercent, 10, 99),
    diskWarnPercent: clampNum(p.diskWarnPercent, base.diskWarnPercent, 10, 99),
    loadWarnRatio: clampNum(p.loadWarnRatio, base.loadWarnRatio, 0.5, 20, 2),

    expiryWarnDays: clampNum(p.expiryWarnDays, base.expiryWarnDays, 1, 365),
    quotaWarnPercent: clampNum(p.quotaWarnPercent, base.quotaWarnPercent, 10, 100),

    metricRetentionHours: clampNum(p.metricRetentionHours, base.metricRetentionHours, 2, 720),
    auditRetentionDays: clampNum(p.auditRetentionDays, base.auditRetentionDays, 0, 3650),
  };
}

// ————————————————————————————————————————————————————————
// 读写
// ————————————————————————————————————————————————————————

const SETTINGS_KEY = 'panel';

/**
 * 进程内缓存。
 *
 * getSettings() 在热路径上 —— 每个 tick 都要为每台机器判一次在线状态，
 * 每次都去查库解 JSON 太浪费。设置只在管理员点保存时变，那时手动失效即可。
 */
let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row) {
    cache = { ...DEFAULT_SETTINGS };
    return cache;
  }
  try {
    // 存下来的可能是更早版本写的，字段不全 —— 过一遍 sanitize 补齐默认值
    cache = sanitizeSettings(JSON.parse(row.value) as Partial<Settings>, DEFAULT_SETTINGS);
  } catch {
    // JSON 坏了不该让整个面板起不来，退回默认值继续跑
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = sanitizeSettings(patch, getSettings());
  db.prepare('INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)').run(
    SETTINGS_KEY,
    JSON.stringify(next),
    Date.now(),
  );
  cache = next;
  return next;
}

/** 测试和汇率模块改完存储后用它强制重读。 */
export function invalidateSettingsCache(): void {
  cache = null;
}

// ————————————————————————————————————————————————————————
// 口径工具
// ————————————————————————————————————————————————————————

/**
 * 按计费方向合并收发流量。
 *
 * 计费方向不是显示偏好，是"这台机器的配额到底在扣什么"。只计出站的机房里
 * 按 rx+tx 算配额，会让一台正常拉取镜像的机器看起来随时要超额。
 */
export function trafficTotal(rx: number, tx: number, direction: TrafficDirection): number {
  if (direction === 'tx') return tx;
  if (direction === 'rx') return rx;
  return rx + tx;
}

/** 拼一段 SQL 求和表达式，让"按方向计费"在数据库里就完成，不用把两列都取回来。 */
export function trafficSumSql(direction: TrafficDirection, rxCol = 'rx', txCol = 'tx'): string {
  if (direction === 'tx') return `COALESCE(SUM(${txCol}),0)`;
  if (direction === 'rx') return `COALESCE(SUM(${rxCol}),0)`;
  return `COALESCE(SUM(${rxCol}),0) + COALESCE(SUM(${txCol}),0)`;
}
