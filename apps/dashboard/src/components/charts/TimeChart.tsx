import { useId, useMemo, useState } from 'react';
import { areaPath, niceMax, niceMaxBytes, smoothPath, ticksOf, useMeasure } from './chart-utils';
import { clockTime } from '../../lib/format';

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
  /** tooltip 里怎么显示这个序列的值 */
  format: (v: number) => string;
}

interface Props {
  series: Series[];
  timestamps: number[];
  height?: number;
  /** 固定纵轴上界（比如 CPU 恒为 100）；不给就按数据自适应 */
  yMax?: number;
  yFormat?: (v: number) => string;
  /** 只有一条线时填充面积，多条线填充会互相盖住 */
  fill?: boolean;
  emptyHint?: string;
  /** 纵轴是字节量时按 1024 进制取整，刻度才对得上 bytes() 的显示 */
  byteScale?: boolean;
}

const PAD = { top: 14, right: 10, bottom: 24, left: 48 };

/**
 * 时间轴折线图。
 *
 * hover 时用一根垂直游标吸附到最近的采样点，而不是各条线各自找最近点 ——
 * 后者会出现"三条线的读数不在同一时刻"的错觉。
 */
export function TimeChart({
  series,
  timestamps,
  height = 220,
  yMax,
  yFormat = (v) => v.toFixed(0),
  fill = false,
  emptyHint = '暂无数据',
  byteScale = false,
}: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, '');

  const n = timestamps.length;
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;

  const top = useMemo(() => {
    if (yMax != null) return yMax;
    const m = Math.max(...series.flatMap((s) => s.values), 0);
    return byteScale ? niceMaxBytes(m || 1) : niceMax(m || 1);
  }, [series, yMax, byteScale]);

  const xOf = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yOf = (v: number) => PAD.top + innerH - (Math.max(0, v) / top) * innerH;

  const paths = useMemo(() => {
    if (width === 0 || n < 2) return [];
    return series.map((s) => {
      const pts: Array<[number, number]> = s.values.map((v, i) => [xOf(i), yOf(v)]);
      return { s, line: smoothPath(pts), area: areaPath(pts, PAD.top + innerH) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, width, n, top, innerW, innerH]);

  const yTicks = ticksOf(top, 4);

  // X 轴最多放 6 个时间标签，多了会挤在一起
  const xTickIdx = useMemo(() => {
    if (n < 2) return [];
    const want = Math.min(6, n);
    return Array.from({ length: want }, (_, i) => Math.round((i / (want - 1)) * (n - 1)));
  }, [n]);

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (n < 2 || innerW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - PAD.left;
    const ratio = x / innerW;
    if (ratio < -0.02 || ratio > 1.02) {
      setHover(null);
      return;
    }
    setHover(Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1)))));
  }

  const hoverX = hover != null ? xOf(hover) : 0;
  // tooltip 靠近右边缘时翻到左侧，避免被容器裁掉
  const flip = hoverX > width * 0.62;

  return (
    <div
      ref={ref}
      style={{ position: 'relative', width: '100%', height }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {n < 2 ? (
        <div
          className="ds-text-body-sm text-ds-description"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          {emptyHint}
        </div>
      ) : (
        <svg width={width} height={height} style={{ display: 'block' }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`tc-${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.2" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {/* 网格与纵轴刻度 */}
          {yTicks.map((t, i) => {
            const y = yOf(t);
            return (
              <g key={i}>
                <line
                  x1={PAD.left}
                  y1={y}
                  x2={width - PAD.right}
                  y2={y}
                  stroke="var(--ds-grid-line)"
                  strokeWidth="1"
                  strokeDasharray={i === 0 ? undefined : '3 4'}
                />
                <text
                  x={PAD.left - 8}
                  y={y + 3.5}
                  textAnchor="end"
                  className="tnum"
                  style={{ fontSize: 10.5, fill: 'var(--ds-text-description)' }}
                >
                  {yFormat(t)}
                </text>
              </g>
            );
          })}

          {/* 横轴时间 */}
          {xTickIdx.map((i) => (
            <text
              key={i}
              x={xOf(i)}
              y={height - 7}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              className="tnum"
              style={{ fontSize: 10.5, fill: 'var(--ds-text-description)' }}
            >
              {clockTime(timestamps[i]!)}
            </text>
          ))}

          {fill &&
            paths.map(({ s, area }) => (
              <path key={`a-${s.key}`} d={area} fill={`url(#tc-${gid}-${s.key})`} />
            ))}

          {paths.map(({ s, line }) => (
            <path
              key={s.key}
              d={line}
              fill="none"
              stroke={s.color}
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* 游标 */}
          {hover != null && (
            <g>
              <line
                x1={hoverX}
                y1={PAD.top}
                x2={hoverX}
                y2={PAD.top + innerH}
                stroke="var(--ds-border-strong)"
                strokeWidth="1"
              />
              {series.map((s) => (
                <circle
                  key={s.key}
                  cx={hoverX}
                  cy={yOf(s.values[hover] ?? 0)}
                  r="3.4"
                  fill="var(--ds-bg-surface)"
                  stroke={s.color}
                  strokeWidth="2"
                />
              ))}
            </g>
          )}
        </svg>
      )}

      {hover != null && n >= 2 && (
        <div
          className="ds-dropdown"
          style={{
            position: 'absolute',
            left: flip ? undefined : Math.min(hoverX + 12, width - 8),
            right: flip ? Math.max(width - hoverX + 12, 8) : undefined,
            top: PAD.top,
            padding: '8px 10px',
            pointerEvents: 'none',
            minWidth: 132,
            zIndex: 5,
          }}
        >
          <div
            className="ds-text-caption tnum text-ds-description"
            style={{ marginBottom: 5 }}
          >
            {new Date(timestamps[hover]!).toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </div>
          {series.map((s) => (
            <div
              key={s.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                justifyContent: 'space-between',
                marginTop: 2,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 2,
                    background: s.color,
                    flexShrink: 0,
                  }}
                />
                <span className="ds-text-caption text-ds-secondary">{s.label}</span>
              </span>
              <span
                className="ds-text-caption tnum"
                style={{ fontWeight: 600, color: 'var(--ds-text-primary)' }}
              >
                {s.format(s.values[hover] ?? 0)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
