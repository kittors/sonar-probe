import { useEffect, useRef, useState } from 'react';

/** 测容器宽度。图表要按真实像素画才能让 hover 命中和刻度对齐。 */
export function useMeasure<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

/**
 * Catmull-Rom 转三次贝塞尔的平滑折线。
 *
 * 直接用折线画监控曲线会显得毛躁，用样条平滑后才有那种"顺"的观感。
 * tension 别调太大，否则曲线会在数据点之间过冲，看起来像出现了实际不存在的峰值。
 */
export function smoothPath(pts: Array<[number, number]>, tension = 0.22): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0]![0]} ${pts[0]![1]}`;
  if (pts.length === 2) return `M ${pts[0]![0]} ${pts[0]![1]} L ${pts[1]![0]} ${pts[1]![1]}`;

  let d = `M ${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1]!;

    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension * 3;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension * 3;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension * 3;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension * 3;

    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

/** 把平滑曲线闭合成面积。 */
export function areaPath(pts: Array<[number, number]>, baseY: number, tension = 0.22): string {
  if (pts.length === 0) return '';
  const line = smoothPath(pts, tension);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  return `${line} L ${last[0]} ${baseY} L ${first[0]} ${baseY} Z`;
}

/**
 * 取"好看"的刻度上界。
 *
 * 直接用 max 会让曲线顶到边框，且刻度是 87.3 这种读不出来的数。
 * 这里向上取整到 1/2/2.5/5 的整数倍。
 */
export function niceMax(max: number, ticks = 4): number {
  if (max <= 0) return 1;
  const rough = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag * ticks;
}

/**
 * 字节专用的刻度上界。
 *
 * niceMax 按十进制取整，配上 1024 进制的 bytes() 会得出"977 KB""23 GB"这种刻度 ——
 * 数字本身是整的，换算成 KB/GB 之后就不整了。这里先归一到当前量级单位内再取整，
 * 刻度才会落在 25 GB、100 KB 这类读得出来的位置上。
 */
export function niceMaxBytes(max: number, ticks = 4): number {
  if (max <= 0) return 1024;
  let unit = 1;
  while (max / unit >= 1024 && unit < 1024 ** 5) unit *= 1024;
  const inUnit = max / unit;
  const rough = inUnit / ticks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag * ticks * unit;
}

export function ticksOf(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i);
}

/** 在数组里找最接近目标 x 的下标，用于 hover 吸附。 */
export function nearestIndex(len: number, ratio: number): number {
  if (len <= 0) return -1;
  return Math.max(0, Math.min(len - 1, Math.round(ratio * (len - 1))));
}

/**
 * 图表配色。
 *
 * 全部走 CSS 变量而不是写死色值 —— 同一个 #4d6bfe 在白底上沉稳，
 * 扔进深色背景就发闷。变量在 theme.css 里按主题各给一套，
 * SVG 的 stroke/fill 认 var()，所以图表能跟着主题一起变。
 */
export const SERIES = {
  cpu: 'var(--chart-cpu)',
  mem: 'var(--chart-mem)',
  disk: 'var(--chart-disk)',
  load: 'var(--chart-load)',
  rx: 'var(--chart-rx)',
  tx: 'var(--chart-tx)',
  read: 'var(--chart-disk)',
  write: 'var(--chart-load)',
  danger: 'var(--color-danger)',
} as const;

/** 服务分类 → 颜色。榜单和图例共用。 */
export const CATEGORY_COLOR: Record<string, string> = {
  web: 'var(--chart-cpu)',
  database: 'var(--chart-mem)',
  container: 'var(--chart-disk)',
  transfer: 'var(--chart-rx)',
  system: 'var(--chart-neutral)',
  app: 'var(--chart-load)',
  other: 'var(--chart-muted)',
  closed: 'var(--chart-muted)',
};

export const CATEGORY_LABEL: Record<string, string> = {
  web: '网站/反代',
  database: '数据库',
  container: '容器',
  transfer: '传输/备份',
  system: '系统',
  app: '应用',
  other: '其他',
  closed: '已关闭',
};

/** 威胁分 → 颜色档位。同样走变量，暗色下会自动提亮。 */
export function threatColor(score: number): string {
  if (score >= 75) return 'var(--color-danger)';
  if (score >= 50) return 'var(--color-warn)';
  if (score >= 25) return 'var(--chart-caution)';
  return 'var(--color-ok)';
}

export function threatLabel(score: number): string {
  if (score >= 75) return '高危';
  if (score >= 50) return '可疑';
  if (score >= 25) return '关注';
  return '正常';
}
