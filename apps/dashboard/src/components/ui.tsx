import type { ReactNode } from 'react';
import type { NodeStatus } from '../lib/types';
import { IconAlert, IconCheck, IconInfo } from './icons';

// ————————————————————————————————————————————————————————
// 状态
// ————————————————————————————————————————————————————————

export const STATUS_COLOR: Record<NodeStatus, string> = {
  online: 'var(--color-ok)',
  warning: 'var(--color-warn)',
  offline: 'var(--color-idle)',
};

export const STATUS_TEXT: Record<NodeStatus, string> = {
  online: '在线',
  warning: '告警',
  offline: '离线',
};

/** 状态圆点。在线的会有一圈呼吸扩散，离线的是实心哑光。 */
export function StatusDot({ status, size = 7 }: { status: NodeStatus; size?: number }) {
  const color = STATUS_COLOR[status];
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        width: size,
        height: size,
        flexShrink: 0,
      }}
      aria-label={STATUS_TEXT[status]}
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          background: color,
        }}
      />
      {status !== 'offline' && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            color,
            animation: 'ds-pulse-ring 2.4s cubic-bezier(0.4,0,0.6,1) infinite',
          }}
        />
      )}
    </span>
  );
}

// ————————————————————————————————————————————————————————
// 指标条
// ————————————————————————————————————————————————————————

interface MeterProps {
  label: ReactNode;
  /** 0-100 */
  value: number;
  color?: string;
  warnAt?: number;
  dangerAt?: number;
  compact?: boolean;
  /**
   * 没有数据时用它，而不是传 value=0。
   * 离线机器画一条空槽再写个 0%，看起来像"内存全空"，正好和真相相反。
   */
  empty?: boolean;
}

/**
 * 横向占用条。
 *
 * 颜色只在越界时才变 —— 平时全都是品牌蓝，一眼扫过去哪个变黄变红就知道该看哪台。
 * 如果每个指标一个颜色，告警反而淹没在彩色里了。
 */
export function Meter({
  label,
  value,
  color = 'var(--color-brand)',
  warnAt = 80,
  dangerAt = 92,
  compact = false,
  empty = false,
}: MeterProps) {
  const v = empty ? 0 : Math.max(0, Math.min(100, value));
  const bar = v >= dangerAt ? 'var(--color-danger)' : v >= warnAt ? 'var(--color-warn)' : color;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        className="ds-text-caption text-ds-description"
        style={{ width: compact ? 26 : 30, flexShrink: 0 }}
      >
        {label}
      </span>
      <span
        style={{
          position: 'relative',
          flex: 1,
          height: 5,
          borderRadius: 999,
          background: 'var(--ds-bg-sunken)',
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            inset: 0,
            width: `${v}%`,
            background: bar,
            borderRadius: 999,
            transition: 'width 0.6s cubic-bezier(0.4,0,0.2,1), background-color 0.3s',
          }}
        />
      </span>
      <span
        className="ds-text-caption tnum"
        style={{
          width: empty ? undefined : 34,
          textAlign: 'right',
          flexShrink: 0,
          fontWeight: 500,
          color: empty
            ? 'var(--ds-text-disabled)'
            : v >= warnAt
              ? bar
              : 'var(--ds-text-secondary)',
        }}
      >
        {empty ? '—' : `${v.toFixed(0)}%`}
      </span>
    </div>
  );
}

// ————————————————————————————————————————————————————————
// 容器
// ————————————————————————————————————————————————————————

export function SectionCard({
  title,
  subtitle,
  actions,
  children,
  padded = true,
  className = '',
  style,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section className={`ds-surface ${className}`} style={style}>
      {(title || actions) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            padding: '16px 18px',
            borderBottom: '1px solid var(--ds-border)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            {title && <h3 className="ds-text-subtitle text-ds-primary" style={{ margin: 0 }}>{title}</h3>}
            {subtitle && (
              <p className="ds-text-caption text-ds-description" style={{ margin: '3px 0 0' }}>
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div style={{ flexShrink: 0, display: 'flex', gap: 6 }}>{actions}</div>}
        </header>
      )}
      <div style={padded ? { padding: 18 } : undefined}>{children}</div>
    </section>
  );
}

export function Chip({
  children,
  color,
  title,
}: {
  children: ReactNode;
  color?: string;
  title?: string;
}) {
  return (
    <span
      className="ds-chip"
      title={title}
      style={
        color
          ? {
              color,
              background: `color-mix(in srgb, ${color} 10%, transparent)`,
              borderColor: `color-mix(in srgb, ${color} 24%, transparent)`,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}

/** 分段控制器，用于时间范围切换。 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        padding: 2,
        gap: 2,
        background: 'var(--ds-bg-sunken)',
        borderRadius: 8,
        border: '1px solid var(--ds-border)',
      }}
      role="tablist"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className="ds-text-caption"
            style={{
              height: 26,
              padding: '0 10px',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 500,
              fontFamily: 'inherit',
              background: active ? 'var(--ds-bg-surface)' : 'transparent',
              color: active ? 'var(--ds-text-primary)' : 'var(--ds-text-description)',
              boxShadow: active ? 'var(--ds-shadow-card)' : 'none',
              transition: 'all 0.18s cubic-bezier(0.4,0,0.2,1)',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 表单控件
 *
 * **一律自绘，不用原生控件的可视部分。**
 *
 * 之前这里是"基于原生元素做外观统一"，理由是原生的键盘和移动端体验白送。
 * 那个判断是错的：原生 select 和 date 展开后的面板由操作系统绘制，CSS 根本
 * 够不到 —— macOS 弹出深色圆角菜单，Windows 弹方框列表，移动端拉起系统滚轮，
 * 跟设计系统毫无关系。appearance:none 只能管住收起时的样子。
 *
 * 所以 Select / DatePicker 都换成了自绘实现（见 Select.tsx、DatePicker.tsx），
 * 键盘、焦点、无障碍全部自己补齐。Checkbox 把原生 input 留在原位但设为透明，
 * 视觉层自绘 —— 表单语义和键盘操作照旧，勾号形状归我们管。
 */

export { Select } from './Select';
export { DatePicker } from './DatePicker';

/** @deprecated 用 DatePicker，保留这个名字只是为了不改一堆调用点 */
export { DatePicker as DateInput } from './DatePicker';

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  tone,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  tone?: 'danger';
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 9,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <RawCheckbox checked={checked} onChange={onChange} tone={tone} disabled={disabled} style={{ marginTop: 2 }} />
      <span style={{ minWidth: 0 }}>
        <span
          className="ds-text-body-sm"
          style={{ display: 'block', fontWeight: 500, color: 'var(--ds-text-primary)' }}
        >
          {label}
        </span>
        {hint && (
          <span className="ds-text-caption text-ds-description" style={{ display: 'block' }}>
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * 光秃秃的复选框，不带文字。权限矩阵那种整片格子的场景直接用它。
 *
 * 真正的 input 还在原位，只是设成透明铺满 —— 焦点、键盘（空格切换）、
 * 表单语义、屏幕阅读器全部照旧，只有勾号的长相换成了自绘的。
 */
export function RawCheckbox({
  checked,
  onChange,
  tone,
  disabled,
  ariaLabel,
  style,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  tone?: 'danger';
  disabled?: boolean;
  ariaLabel?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className="ds-check"
      style={{
        ...style,
        ...(tone === 'danger' ? ({ '--check-tone': 'var(--color-danger)' } as React.CSSProperties) : null),
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ds-check-box" aria-hidden="true">
        <IconCheck size={11} strokeWidth={2.6} />
      </span>
    </span>
  );
}

/** 表单字段：标签 + 控件，统一间距和标签排版。 */
/**
 * 表单字段：标签 + 控件 + 提示/错误。
 *
 * 出错时错误文案**顶掉**提示文案，而不是两行并排 —— 提示说的是"该怎么填"，
 * 错误说的是"这次填错在哪"，后者出现时前者已经没用了，同时显示只会让人多读一行。
 * 高度不变，所以报错不会把下面的字段整体推下去。
 */
export function Field({
  label,
  children,
  grow,
  width,
  hint,
  error,
  required,
}: {
  label: string;
  children: ReactNode;
  grow?: boolean;
  width?: number;
  hint?: ReactNode;
  /** 有值即为错误态 */
  error?: string;
  required?: boolean;
}) {
  const foot = error ?? hint;
  return (
    <label
      className="ds-field"
      data-invalid={error ? true : undefined}
      /*
        基准宽度 168 而不是 140：在 320px 手机上弹窗内容区只有约 280px，
        两个 140 的字段刚好挤得下，于是并排显示成两个 120px 的窄框；
        提到 168 之后放不下两个，flex 自动换行成单列全宽，反而好填。
        宽屏不受影响，仍然并排。
      */
      style={{ display: 'block', flex: grow ? '1 1 168px' : undefined, width, minWidth: 0 }}
    >
      <span
        className="ds-text-caption text-ds-description"
        style={{ display: 'block', marginBottom: 5 }}
      >
        {label}
        {required && <span className="ds-field-req">*</span>}
      </span>
      {children}
      {foot && (
        <span
          className={`ds-text-caption ${error ? 'ds-field-error' : 'text-ds-description'}`}
          style={{ display: 'block', marginTop: 5 }}
          role={error ? 'alert' : undefined}
        >
          {foot}
        </span>
      )}
    </label>
  );
}

/**
 * 提示条：错误、警告、说明。
 *
 * 之前每个弹窗都自己拼一个带背景色的方块（BlockDialog 一个、NodeEditDialog 一个），
 * 颜色和内边距各写各的。统一到这里。
 */
export function Alert({
  tone = 'danger',
  title,
  children,
  icon,
}: {
  tone?: 'danger' | 'warn' | 'info' | 'success';
  title?: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  // success 用对勾，info 用信息图标，其余（危险、警告）用感叹号。
  // 拿感叹号去说"密码已更新"会让人以为出了事
  const fallback =
    tone === 'success' ? (
      <IconCheck size={14} />
    ) : tone === 'info' ? (
      <IconInfo size={14} />
    ) : (
      <IconAlert size={14} />
    );
  return (
    <div className="ds-alert" data-tone={tone} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="ds-alert-icon">{icon ?? fallback}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        {title && <div className="ds-alert-title ds-text-body-sm">{title}</div>}
        {children && <div className="ds-text-body-sm ds-alert-body">{children}</div>}
      </div>
    </div>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{children}</div>;
}

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '48px 20px',
        textAlign: 'center',
      }}
    >
      {icon && <div style={{ color: 'var(--ds-text-disabled)' }}>{icon}</div>}
      <p className="ds-text-subtitle text-ds-secondary" style={{ margin: 0 }}>
        {title}
      </p>
      {hint && (
        <p className="ds-text-body-sm text-ds-description" style={{ margin: 0, maxWidth: 380 }}>
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * 分页控制器。
 *
 * 只在确实需要翻页时出现 —— 一页装得下的时候摆一排"上一页/下一页"，
 * 是在提示一个不存在的操作。
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;

  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px',
        borderTop: '1px solid var(--ds-border)',
        flexWrap: 'wrap',
      }}
    >
      <span className="ds-text-caption text-ds-description tnum">
        第 {from}–{to} 条，共 {total} 条
      </span>
      <span style={{ flex: 1 }} />
      <button
        className="ds-btn ds-btn-ghost ds-btn-s"
        disabled={page <= 0}
        onClick={() => onPage(page - 1)}
      >
        上一页
      </button>
      <span className="ds-text-caption text-ds-secondary tnum">
        {page + 1} / {pages}
      </span>
      <button
        className="ds-btn ds-btn-ghost ds-btn-s"
        disabled={page >= pages - 1}
        onClick={() => onPage(page + 1)}
      >
        下一页
      </button>
    </div>
  );
}

/**
 * 占位块。
 *
 * radius 可调是为了让骨架贴合它要替代的东西：圆环状的指标用 999，
 * 卡片用 16，文字行用默认的 6。形状对不上的话，数据一到就会看到明显的变形。
 */
export function Skeleton({
  height = 16,
  width = '100%',
  radius,
  style,
}: {
  height?: number;
  width?: number | string;
  radius?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div className="ds-skeleton" style={{ height, width, borderRadius: radius, ...style }} />
  );
}

/** 一组"标题 + 数值"的紧凑展示，详情页里到处在用。 */
export function Stat({
  label,
  value,
  unit,
  hint,
  color,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  color?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="ds-text-caption text-ds-description" style={{ marginBottom: 3 }}>
        {label}
      </div>
      <div className="ds-num-md" style={{ color, whiteSpace: 'nowrap' }}>
        {value}
        {unit && <span className="ds-num-unit">{unit}</span>}
      </div>
      {hint && (
        <div className="ds-text-caption text-ds-description" style={{ marginTop: 2 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
