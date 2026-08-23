import { useId } from 'react';
import { areaPath, smoothPath } from './chart-utils';

interface Props {
  values: number[];
  color?: string;
  height?: number;
  /** 纵轴上界。不给就按数据自适应。 */
  max?: number;
  className?: string;
}

/**
 * 卡片上的迷你趋势线。
 *
 * 没有坐标轴、没有 tooltip —— 它只回答"最近是在涨还是在跌"。
 * 想看具体数值应该点进详情页。
 */
export function Sparkline({
  values,
  color = 'var(--color-brand)',
  height = 34,
  max,
  className,
}: Props) {
  const gid = useId().replace(/:/g, '');
  const W = 100;
  const H = height;
  const pad = 3;

  if (values.length < 2) {
    return (
      <div
        className={className}
        style={{ height, display: 'flex', alignItems: 'center' }}
        aria-hidden="true"
      >
        <div style={{ height: 1, width: '100%', background: 'var(--ds-border)' }} />
      </div>
    );
  }

  const top = max ?? Math.max(...values, 1);
  const lo = 0;
  const span = Math.max(top - lo, 0.0001);

  const pts: Array<[number, number]> = values.map((v, i) => [
    (i / (values.length - 1)) * W,
    H - pad - ((v - lo) / span) * (H - pad * 2),
  ]);


  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      style={{ width: '100%', height, display: 'block', overflow: 'visible' }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath(pts, H)} fill={`url(#spark-${gid})`} />
      <path
        d={smoothPath(pts)}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
