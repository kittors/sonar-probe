import { useMemo, useState } from 'react';
import { niceMaxBytes, ticksOf, useMeasure } from './chart-utils';
import { bytes, dayLabel } from '../../lib/format';
import type { DailyTraffic } from '../../lib/types';

interface Props {
  data: DailyTraffic[];
  height?: number;
  rxColor?: string;
  txColor?: string;
}

const PAD = { top: 14, right: 8, bottom: 22, left: 52 };

/**
 * 每日流量柱状图，下行/上行堆叠。
 *
 * 堆叠而不是分组：看流量账单时关心的是"这天一共跑了多少"，
 * 分组柱会让人去心算两根柱的和。
 */
export function TrafficBars({
  data,
  height = 200,
  rxColor = '#00b96b',
  txColor = '#4d6bfe',
}: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;
  const n = data.length;

  const top = useMemo(() => niceMaxBytes(Math.max(...data.map((d) => d.rx + d.tx), 1)), [data]);

  const slot = n > 0 ? innerW / n : 0;
  // 柱子之间留一点缝，但 30 根柱时缝要窄，否则柱子太细
  const gap = Math.min(4, Math.max(1, slot * 0.22));
  const barW = Math.max(1.5, slot - gap);

  const yTicks = ticksOf(top, 4);
  const yOf = (v: number) => PAD.top + innerH - (v / top) * innerH;

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (n === 0 || slot <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - PAD.left;
    const i = Math.floor(x / slot);
    setHover(i >= 0 && i < n ? i : null);
  }

  const hovered = hover != null ? data[hover] : undefined;
  const hoverCx = hover != null ? PAD.left + hover * slot + slot / 2 : 0;
  const flip = hoverCx > width * 0.6;

  return (
    <div
      ref={ref}
      style={{ position: 'relative', width: '100%', height }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {n === 0 ? (
        <div
          className="ds-text-body-sm text-ds-description"
          style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}
        >
          暂无流量记录
        </div>
      ) : (
        <svg width={width} height={height} style={{ display: 'block' }}>
          {yTicks.map((t, i) => (
            <g key={i}>
              <line
                x1={PAD.left}
                y1={yOf(t)}
                x2={width - PAD.right}
                y2={yOf(t)}
                stroke="var(--ds-grid-line)"
                strokeDasharray={i === 0 ? undefined : '3 4'}
              />
              <text
                x={PAD.left - 8}
                y={yOf(t) + 3.5}
                textAnchor="end"
                className="tnum"
                style={{ fontSize: 10.5, fill: 'var(--ds-text-description)' }}
              >
                {bytes(t, 0)}
              </text>
            </g>
          ))}

          {data.map((d, i) => {
            const x = PAD.left + i * slot + gap / 2;
            const hRx = (d.rx / top) * innerH;
            const hTx = (d.tx / top) * innerH;
            const yTx = PAD.top + innerH - hRx - hTx;
            const active = hover === i;
            const r = Math.min(2.5, barW / 2);
            return (
              <g key={d.day} opacity={hover == null || active ? 1 : 0.45} style={{ transition: 'opacity .15s' }}>
                {/* 上行在上，圆角只给顶部 */}
                <path
                  d={roundedTop(x, yTx, barW, hTx, r)}
                  fill={txColor}
                />
                <rect x={x} y={PAD.top + innerH - hRx} width={barW} height={hRx} fill={rxColor} />
              </g>
            );
          })}

          {/* 日期标签：柱子多的时候隔几根标一次 */}
          {data.map((d, i) => {
            const every = n > 20 ? 5 : n > 10 ? 3 : 1;
            if (i % every !== 0 && i !== n - 1) return null;
            return (
              <text
                key={d.day}
                x={PAD.left + i * slot + slot / 2}
                y={height - 6}
                textAnchor="middle"
                className="tnum"
                style={{ fontSize: 10, fill: 'var(--ds-text-description)' }}
              >
                {dayLabel(d.day)}
              </text>
            );
          })}
        </svg>
      )}

      {hovered && (
        <div
          className="ds-dropdown"
          style={{
            position: 'absolute',
            left: flip ? undefined : Math.min(hoverCx + 10, width - 8),
            right: flip ? Math.max(width - hoverCx + 10, 8) : undefined,
            top: PAD.top,
            padding: '8px 10px',
            pointerEvents: 'none',
            minWidth: 128,
            zIndex: 5,
          }}
        >
          <div className="ds-text-caption text-ds-description tnum" style={{ marginBottom: 5 }}>
            {hovered.day}
          </div>
          <Row color={txColor} label="上行" value={bytes(hovered.tx)} />
          <Row color={rxColor} label="下行" value={bytes(hovered.rx)} />
          <div
            style={{ height: 1, background: 'var(--ds-border)', margin: '5px 0 4px' }}
          />
          <Row label="合计" value={bytes(hovered.rx + hovered.tx)} bold />
        </div>
      )}
    </div>
  );
}

function Row({
  color,
  label,
  value,
  bold,
}: {
  color?: string;
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        marginTop: 2,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {color && (
          <span style={{ width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 }} />
        )}
        <span className="ds-text-caption text-ds-secondary">{label}</span>
      </span>
      <span
        className="ds-text-caption tnum"
        style={{ fontWeight: bold ? 700 : 600, color: 'var(--ds-text-primary)' }}
      >
        {value}
      </span>
    </div>
  );
}

/** 顶部两角圆角的柱子路径。高度小于圆角时退化成矩形，否则路径会自己打结。 */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M ${x} ${y + h} L ${x} ${y + rr} Q ${x} ${y} ${x + rr} ${y} L ${x + w - rr} ${y} Q ${x + w} ${y} ${x + w} ${y + rr} L ${x + w} ${y + h} Z`;
}
