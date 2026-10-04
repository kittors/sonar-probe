/** 展示层的格式化。所有数字进 UI 之前都过这里，保证全站单位口径一致。 */

import { CURRENCY_META, normalizeCurrency } from './currency';

const DECIMAL_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/**
 * 展示口径。
 *
 * 做成模块级可变状态，而不是把每个格式化函数都改成 hook：bytes() 在
 * 几十个地方被调用，其中不少在纯函数和 map 回调里，全改成 hook 会把
 * "格式化一个数字"这件事变成组件树的关注点。
 *
 * 由 SettingsProvider 在拿到设置后调一次 applyDisplaySettings 注入，
 * 之后同一次渲染里的所有调用都用同一套口径。
 */
let display = {
  byteBase: 1000 as 1024 | 1000,
  binaryUnitLabels: false,
  timezone: 'UTC',
  expiryWarnDays: 7,
  quotaWarnPercent: 80,
  trafficDirection: 'both' as 'both' | 'tx' | 'rx',
};

export function applyDisplaySettings(patch: Partial<typeof display>): void {
  display = { ...display, ...patch };
}

export function displaySettings(): Readonly<typeof display> {
  return display;
}

/**
 * 字节格式化。
 *
 * 进制来自面板设置，因为这件事没有唯一正确答案：
 *   1024 是 Linux 工具链的口径（df、free、ip -s link 都这么算）；
 *   1000 是服务商账单的口径 —— 标称"2TB 流量"几乎都指 2×10¹² 字节。
 * 两者差 10%，落到 2TB 上就是 180 GB 的误判空间，足以让人以为自己
 * 快超额了而去关掉一个正常的服务。
 *
 * 有效数字随量级递减：1.2 GB 比 1.23 GB 好读，984 MB 不需要小数。
 */
export function bytes(n: number | null | undefined, digits?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '0 B';
  const units = display.byteBase === 1024 && display.binaryUnitLabels ? BINARY_UNITS : DECIMAL_UNITS;
  const neg = n < 0;
  let v = Math.abs(n);
  let i = 0;
  while (v >= display.byteBase && i < units.length - 1) {
    v /= display.byteBase;
    i++;
  }
  const d = digits ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2);
  return `${neg ? '-' : ''}${v.toFixed(d)} ${units[i]}`;
}

/**
 * 按计费方向合并收发。
 *
 * 服务端算"本周期已用"时就是按这个口径（settings.trafficTotal），前端凡是
 * 要和配额放在一起比的数字都得走同一个函数 —— 否则同一张卡片里
 * "合计 846 GB"和进度条上的"399 GB / 1 TB"会是两个口径，
 * 看的人没法判断哪个才是账单上会扣的那个数。
 *
 * 归因明细（哪个进程、哪个对端用了多少）不走这里：那是"谁在用"，
 * 双向都算才完整。
 */
export function trafficTotal(rx: number, tx: number): number {
  if (display.trafficDirection === 'tx') return tx;
  if (display.trafficDirection === 'rx') return rx;
  return rx + tx;
}

/** 把人填的"数值 + 单位"折回字节。设置页和编辑弹窗输入配额时用。 */
export function toBytes(value: number, unit: 'GB' | 'TB'): number {
  const base = display.byteBase;
  return value * (unit === 'TB' ? base ** 4 : base ** 3);
}

/**
 * 流量周期的最后一天。
 *
 * 服务端给的 cycleEnd 是左闭右开的右端，也就是**下个周期的第一天**。
 * 原样显示成"09-01 – 10-01"会让人以为 10 月 1 日也算在这个周期里，
 * 而那天的流量其实已经进了下一个账单。
 */
export function cycleLastDay(cycleEnd: string): string {
  const t = Date.parse(`${cycleEnd}T00:00:00Z`);
  if (!Number.isFinite(t)) return cycleEnd;
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD → M/D。周期那行横向空间紧张，年份对当期流量没有信息量。 */
export function monthDay(day: string): string {
  const [, m, d] = day.split('-');
  return m && d ? `${Number(m)}/${Number(d)}` : day;
}

/** 速率，byte/s → 人类可读。 */
export function rate(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${bytes(n)}/s`;
}

/** 把字节拆成数值和单位两段，便于用不同字号排版。 */
export function bytesParts(n: number | null | undefined): [string, string] {
  const s = bytes(n);
  if (s === '—') return ['—', ''];
  const idx = s.lastIndexOf(' ');
  return [s.slice(0, idx), s.slice(idx + 1)];
}

export function percent(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function ratio(used: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, (used / total) * 100);
}

/** 运行时长：优先显示最大的两级单位。 */
export function uptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

/** 相对时间，用于"最后上报于…"。 */
export function ago(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const s = Math.floor(diff / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/**
 * 距到期还有多久。
 *
 * ts 为 0 表示"没填过期时间"（agent 上报的机器就是这样），不是 1970 年。
 * 不单独处理的话会算出"已过期 20886 天"这种见鬼的结果。
 */
export function untilExpire(ts: number): { text: string; days: number; urgent: boolean; known: boolean } {
  if (!ts || ts <= 0) return { text: '未设置到期', days: 0, urgent: false, known: false };
  const days = Math.ceil((ts - Date.now()) / 86_400_000);
  if (days < 0) return { text: `已过期 ${-days} 天`, days, urgent: true, known: true };
  if (days === 0) return { text: '今天到期', days, urgent: true, known: true };
  if (days > 900) return { text: '长期有效', days, urgent: false, known: true };
  // 标红的门槛跟设置里的到期提醒天数走。写死 7 天的话，一个把提醒设成
  // 30 天的人会看到汇总说"3 台即将到期"，卡片上却一个红标都没有
  return { text: `${days} 天后到期`, days, urgent: days <= display.expiryWarnDays, known: true };
}

/**
 * 配额用量该显示成什么颜色。
 *
 * 黄线就是设置里的"配额提醒"百分比 —— 概览页说某台机器"接近配额"时，
 * 那台机器的卡片上必须同时变黄，否则两处在讲同一件事却对不上。
 * 红线固定在 100%：那不是提醒，是已经超了。
 *
 * normal 是没到警戒线时的颜色。进度条要用品牌色，而表格里那一列是文字，
 * 整列涂成蓝色只会吵 —— 同一套阈值，两种载体本就该有不同的静默态。
 */
export function quotaTone(percent: number, normal = 'var(--ds-data)'): string {
  if (percent >= 100) return 'var(--color-danger)';
  if (percent >= display.quotaWarnPercent) return 'var(--color-warn)';
  return normal;
}

/** 是否该提醒"接近配额"。和 quotaTone 的黄线共用同一个阈值。 */
export function isNearQuota(percent: number): boolean {
  return percent >= display.quotaWarnPercent;
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function dayLabel(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/**
 * 金额格式化。
 *
 * 符号和小数位都查 CURRENCY_META。原先这里只认 USD/EUR/CNY 三种，
 * 而机器可选的币种有十几个 —— 一台港币计价的机器会渲染成光秃秃的
 * "48.00"，看不出是什么钱；日元则会得到 "1200.00" 这种当地人不会写的形式。
 */
export function money(amount: number, currency: string): string {
  // 0 在这里是"没填"而不是"不要钱"。真免费的机器也该显式标注，
  // 而不是靠一个恰好为 0 的字段推断出来。
  if (!amount || amount <= 0) return '未设置';
  const meta = CURRENCY_META[normalizeCurrency(currency)];
  return `${meta.symbol}${amount.toFixed(meta.decimals)}`;
}

/** 同上，但 0 显示成 0 而不是"未设置" —— 汇总数字里 0 是个真实的答案。 */
export function moneyTotal(amount: number, currency: string): string {
  const meta = CURRENCY_META[normalizeCurrency(currency)];
  const safe = Number.isFinite(amount) ? amount : 0;
  return `${meta.symbol}${safe.toFixed(meta.decimals)}`;
}

/** 大数字加千分位。 */
export function count(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

/**
 * IP 打码。
 *
 * 概览页默认遮住后两段：截图分享时不至于把机器地址暴露出去，
 * 详情页里需要完整地址做封禁操作，那里显示原值。
 */
export function maskIp(ip: string): string {
  if (ip.includes(':')) {
    const seg = ip.split(':');
    return seg.slice(0, 2).join(':') + ':****';
  }
  const p = ip.split('.');
  if (p.length !== 4) return ip;
  return `${p[0]}.${p[1]}.*.*`;
}

/**
 * 外链消毒。
 *
 * 这个值会直接进 <a href>，`javascript:` 和 `data:` 协议放进去点一下就执行脚本了。
 * 服务端写入时已经过滤过一次（store.ts 的 sanitizeUrl），这里是第二道 ——
 * 数据库里可能存着更早版本写进去的值，只靠写入校验管不到它们。
 *
 * 返回空串表示这个链接不该渲染。
 */
export function safeUrl(input: string | null | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}
