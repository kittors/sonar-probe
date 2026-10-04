import { useId } from 'react';
import { areaPath, smoothPath } from './chart-utils';

interface Props {
  values: number[];
  color?: string;
  height?: number;
  /** 纵轴上界。不给就按数据自适应。 */
  max?: number;
  className?: string;
  /** 叠一条不填色的副线，比如出站之外再画一条入站 */
  secondary?: { values: number[]; color: string };
  /** 首次出现时从左往右展开。实时刷新不会重播 —— 组件不卸载动画就只跑一次 */
  reveal?: boolean;
  /** 线下面铺一层渐隐的面积。卡片里的小趋势线不要，单独成块的才要 */
  fill?: boolean;
}

/**
 * 迷你趋势线。
 *
 * 没有坐标轴、没有 tooltip —— 它只回答"最近是在涨还是在跌"。
 * 想看具体数值应该点进详情页。
 */
export function Sparkline({
  values,
  color = 'var(--ds-data)',
  height = 34,
  max,
  className,
  secondary,
  reveal = true,
  fill = true,
}: Props) {
  const gid = useId().replace(/:/g, '');
  const W = 100;
  const H = height;
  const pad = 2;

  if (values.length < 2) {
    return (
      <div
        className={className}
        style={{ height, display: 'flex', alignItems: 'center' }}
        aria-hidden="true"
      >
        <div style={{ height: 1, width: '100%', background: 'var(--ds-divider)' }} />
      </div>
    );
  }

  const all = secondary ? [...values, ...secondary.values] : values;
  const top = max ?? Math.max(...all, 1);
  const span = Math.max(top, 0.0001);

  const toPts = (vs: number[]): Array<[number, number]> =>
    vs.map((v, i) => [(i / Math.max(1, vs.length - 1)) * W, H - pad - (Math.max(0, v) / span) * (H - pad * 2)]);

  const pts = toPts(values);
  const pts2 = secondary && secondary.values.length >= 2 ? toPts(secondary.values) : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      style={{
        width: '100%',
        height,
        display: 'block',
        overflow: 'visible',
        animation: reveal ? 'ds-spark-reveal 0.9s cubic-bezier(0.22, 1, 0.36, 1) backwards' : undefined,
      }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.12" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={areaPath(pts, H)} fill={`url(#spark-${gid})`} />}
      {pts2 && (
        <path
          d={smoothPath(pts2)}
          fill="none"
          stroke={secondary!.color}
          strokeWidth="1.25"
          strokeOpacity="0.85"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path
        d={smoothPath(pts)}
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
