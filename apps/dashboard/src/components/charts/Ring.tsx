interface Props {
  /** 0-100 */
  value: number;
  size?: number;
  thickness?: number;
  color?: string;
  label?: string;
  sublabel?: string;
  /** 超过这个值就转成警示色 */
  warnAt?: number;
  dangerAt?: number;
  /** 没有读数（离线、还没上报）。画一圈空槽和一个"—"，而不是 0% */
  empty?: boolean;
}

/**
 * 环形占用指示。
 *
 * 用它而不是横条：详情页顶部四个指标并排时，环形更容易一眼比出差异，
 * 也更省横向空间。常态是数据色（炭黑），越线才变橙变红。
 */
export function Ring({
  value,
  size = 64,
  thickness = 6,
  color = 'var(--ds-data)',
  label,
  sublabel,
  warnAt = 80,
  dangerAt = 92,
  empty = false,
}: Props) {
  const v = empty ? 0 : Math.max(0, Math.min(100, value));
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - v / 100);

  const stroke = v >= dangerAt ? 'var(--color-danger)' : v >= warnAt ? 'var(--color-warn)' : color;

  return (
    <div
      style={{ width: size, height: size, position: 'relative', flexShrink: 0 }}
      role="img"
      aria-label={empty ? `${label ?? ''} 无数据` : `${label ?? ''} ${v.toFixed(0)}%`}
    >
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', display: 'block' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--ds-bg-track)"
          strokeWidth={thickness}
        />
        {!empty && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={stroke}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.22,1,0.36,1), stroke 0.3s' }}
          />
        )}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: size * 0.22,
            fontWeight: 500,
            letterSpacing: '-0.03em',
            color: empty ? 'var(--ds-text-disabled)' : 'var(--ds-text-primary)',
            lineHeight: 1,
          }}
        >
          {empty ? '—' : v < 1 && v > 0 ? v.toFixed(1) : v.toFixed(0)}
          {!empty && (
            <span style={{ fontSize: size * 0.14, marginLeft: 1, color: 'var(--ds-text-description)' }}>%</span>
          )}
        </span>
        {sublabel && (
          <span style={{ fontSize: size * 0.115, color: 'var(--ds-text-description)', lineHeight: 1.2 }}>
            {sublabel}
          </span>
        )}
      </div>
    </div>
  );
}
