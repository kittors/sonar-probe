/** 展示层的格式化。所有数字进 UI 之前都过这里，保证全站单位口径一致。 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * 字节格式化。
 *
 * 按 1024 进制（磁盘/内存/流量在运维语境里都这么算）。
 * 有效数字随量级递减：1.2 GB 比 1.23 GB 好读，984 MB 不需要小数。
 */
export function bytes(n: number | null | undefined, digits?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '0 B';
  const neg = n < 0;
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const d = digits ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2);
  return `${neg ? '-' : ''}${v.toFixed(d)} ${UNITS[i]}`;
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
  return { text: `${days} 天后到期`, days, urgent: days <= 7, known: true };
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

export function money(amount: number, currency: string): string {
  // 0 在这里是"没填"而不是"不要钱"。真免费的机器也该显式标注，
  // 而不是靠一个恰好为 0 的字段推断出来。
  if (!amount || amount <= 0) return '未设置';
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'CNY' ? '¥' : '';
  return `${symbol}${amount.toFixed(2)}`;
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
