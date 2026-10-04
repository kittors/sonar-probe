import type { ReactNode } from 'react';
import { Tooltip } from '../Tooltip';

export interface BarItem {
  id: string;
  label: ReactNode;
  sublabel?: ReactNode;
  /** 用于算占比 */
  value: number;
  valueText: string;
  subValueText?: string;
  color: string;
  trailing?: ReactNode;
  onClick?: () => void;
}

interface Props {
  items: BarItem[];
  /** 不给就用列表最大值当基准 */
  max?: number;
  emptyHint?: string;
}

/**
 * 占比排行。
 *
 * 每行是"名称 —— 数值"，下面一根 3px 的细条表示占比。之前是把占比条铺满整行背景，
 * 前几名的灰色色块连成一大片，读名字都费劲；细条只占一线，长短对比一样清楚。
 */
export function BarList({ items, max, emptyHint = '暂无数据' }: Props) {
  if (items.length === 0) {
    return (
      <div className="ds-text-body-sm text-ds-description" style={{ padding: '28px 0', textAlign: 'center' }}>
        {emptyHint}
      </div>
    );
  }

  const top = max ?? Math.max(...items.map((i) => i.value), 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map((item, idx) => {
        const pct = top > 0 ? Math.max(1, (item.value / top) * 100) : 0;
        const Tag = item.onClick ? 'button' : 'div';
        return (
          <Tag
            key={item.id}
            onClick={item.onClick}
            className="ds-barlist-row ds-animate-in"
            style={{ animationDelay: `${Math.min(idx * 30, 300)}ms`, cursor: item.onClick ? 'pointer' : 'default' }}
          >
            <span style={{ display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%' }}>
              <span
                aria-hidden="true"
                style={{ width: 8, height: 8, marginTop: 6, borderRadius: 2, background: item.color, flexShrink: 0 }}
              />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span
                  className="ds-ellipsis"
                  style={{ display: 'block', fontSize: 13.5, fontWeight: 500, color: 'var(--ds-text-primary)' }}
                >
                  {item.label}
                </span>
                {item.sublabel && (
                  <span className="ds-text-caption text-ds-description ds-ellipsis" style={{ display: 'block' }}>
                    {item.sublabel}
                  </span>
                )}
              </span>
              {item.trailing && <span style={{ flexShrink: 0 }}>{item.trailing}</span>}
              <span style={{ textAlign: 'right', flexShrink: 0 }}>
                <span className="ds-mono" style={{ display: 'block', fontSize: 13, color: 'var(--ds-text-primary)' }}>
                  {item.valueText}
                </span>
                {item.subValueText && (
                  <span className="ds-mono" style={{ display: 'block', fontSize: 12, color: 'var(--ds-text-description)' }}>
                    {item.subValueText}
                  </span>
                )}
              </span>
            </span>
            <span className="ds-meter-track" style={{ height: 3, marginTop: 9, width: '100%', flex: 'none' }}>
              <span className="ds-meter-fill" style={{ width: `${pct}%`, background: item.color }} />
            </span>
          </Tag>
        );
      })}
    </div>
  );
}

/** 一根堆叠占比条，用于"各分类各占多少"的总览。 */
export function StackedBar({
  segments,
  height = 6,
}: {
  segments: Array<{ key: string; value: number; color: string; label: string }>;
  height?: number;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return null;

  return (
    <div
      style={{ display: 'flex', width: '100%', height, gap: 2 }}
      role="img"
      aria-label={segments.map((s) => `${s.label} ${((s.value / total) * 100).toFixed(0)}%`).join('，')}
    >
      {segments.map((s) => (
        <Tooltip key={s.key} content={`${s.label} ${((s.value / total) * 100).toFixed(1)}%`}>
          <div
            style={{
              width: `${(s.value / total) * 100}%`,
              minWidth: 2,
              borderRadius: 2,
              background: s.color,
              transition: 'width 0.55s cubic-bezier(0.4,0,0.2,1)',
            }}
          />
        </Tooltip>
      ))}
    </div>
  );
}
