import type { ReactNode } from 'react';

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
 * 占比条列表。
 *
 * 条形直接铺在行背景上而不是单独占一列 —— 信息密度更高，
 * 而且一眼就能看出"谁把带宽吃掉了"，不用去对齐两个视觉区域。
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {items.map((item, idx) => {
        const pct = top > 0 ? Math.max(1.5, (item.value / top) * 100) : 0;
        const Tag = item.onClick ? 'button' : 'div';
        return (
          <Tag
            key={item.id}
            onClick={item.onClick}
            className="ds-animate-in"
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '7px 10px',
              borderRadius: 7,
              border: 'none',
              background: 'transparent',
              textAlign: 'left',
              cursor: item.onClick ? 'pointer' : 'default',
              overflow: 'hidden',
              fontFamily: 'inherit',
              animationDelay: `${Math.min(idx * 26, 300)}ms`,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'var(--ds-bg-hover)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}
          >
            {/* 占比条 */}
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${pct}%`,
                background: item.color,
                opacity: 0.11,
                borderRadius: 7,
                transition: 'width 0.55s cubic-bezier(0.4,0,0.2,1)',
              }}
            />
            <span
              aria-hidden="true"
              style={{
                position: 'relative',
                width: 3,
                height: 16,
                borderRadius: 2,
                background: item.color,
                flexShrink: 0,
              }}
            />

            <span style={{ position: 'relative', minWidth: 0, flex: 1 }}>
              <span
                className="ds-text-body-sm"
                style={{
                  display: 'block',
                  fontWeight: 500,
                  color: 'var(--ds-text-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {item.label}
              </span>
              {item.sublabel && (
                <span
                  className="ds-text-caption text-ds-description"
                  style={{
                    display: 'block',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {item.sublabel}
                </span>
              )}
            </span>

            {item.trailing && <span style={{ position: 'relative', flexShrink: 0 }}>{item.trailing}</span>}

            <span style={{ position: 'relative', textAlign: 'right', flexShrink: 0 }}>
              <span
                className="ds-text-body-sm tnum"
                style={{ display: 'block', fontWeight: 600, color: 'var(--ds-text-primary)' }}
              >
                {item.valueText}
              </span>
              {item.subValueText && (
                <span className="ds-text-caption tnum text-ds-description" style={{ display: 'block' }}>
                  {item.subValueText}
                </span>
              )}
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
  height = 8,
}: {
  segments: Array<{ key: string; value: number; color: string; label: string }>;
  height?: number;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height,
        borderRadius: 999,
        overflow: 'hidden',
        gap: 1.5,
        background: 'var(--ds-bg-sunken)',
      }}
      role="img"
      aria-label={segments.map((s) => `${s.label} ${((s.value / total) * 100).toFixed(0)}%`).join('，')}
    >
      {segments.map((s) => (
        <div
          key={s.key}
          title={`${s.label} ${((s.value / total) * 100).toFixed(1)}%`}
          style={{
            width: `${(s.value / total) * 100}%`,
            background: s.color,
            transition: 'width 0.55s cubic-bezier(0.4,0,0.2,1)',
          }}
        />
      ))}
    </div>
  );
}
