import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import type { NodeStatus } from '../lib/types';
import { IconAlert, IconCheck, IconInfo } from './icons';
import { Tooltip } from './Tooltip';

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

const STATUS_TONE: Record<NodeStatus, BadgeTone> = {
  online: 'ok',
  warning: 'warn',
  offline: 'idle',
};

/** 状态圆点。在线和告警的会有一圈呼吸扩散，离线的是实心哑光。 */
export function StatusDot({ status, size = 8 }: { status: NodeStatus; size?: number }) {
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
      role="img"
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
// 徽标
// ————————————————————————————————————————————————————————

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'brand' | 'idle' | 'neutral';

/**
 * 胶囊徽标，用来说"状态"。
 *
 * 和 Chip 分开：Chip 是标签（生产、主库），中性灰、方角；Badge 是状态（在线、告警、
 * 生效中），带色、胶囊形。两者长得一样的话，"告警"会淹没在一排标签里。
 */
export function Badge({
  tone = 'neutral',
  dot,
  children,
  title,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  title?: string;
}) {
  const badge = (
    <span className="ds-badge" data-tone={tone === 'neutral' ? undefined : tone}>
      {dot && <span className="ds-badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
  // 说明文字走自绘提示，不用 title 属性 —— 后者是系统画的灰底小气泡，要等一秒多才出来
  return title ? <Tooltip content={title}>{badge}</Tooltip> : badge;
}

export function StatusBadge({ status }: { status: NodeStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot>
      {STATUS_TEXT[status]}
    </Badge>
  );
}

// ————————————————————————————————————————————————————————
// 指标条
// ————————————————————————————————————————————————————————

/**
 * 占用量该用什么颜色。
 *
 * 颜色只在越界时才变 —— 平时全都是品牌蓝，一眼扫过去哪个变黄变红就知道该看哪台。
 * 如果每个指标一个颜色，告警反而淹没在彩色里了。
 */
export function meterTone(v: number, normal = 'var(--ds-data)', warnAt = 80, dangerAt = 92): string {
  return v >= dangerAt ? 'var(--color-danger)' : v >= warnAt ? 'var(--color-warn)' : normal;
}

/** 光秃秃的一根占用条，网格里要自己排标签和数值时用。 */
export function MeterBar({
  value,
  color,
  height,
  empty,
}: {
  value: number;
  /** 不给就按阈值自动取色 */
  color?: string;
  height?: number;
  empty?: boolean;
}) {
  const v = empty ? 0 : Math.max(0, Math.min(100, value));
  return (
    <span className="ds-meter-track" style={height ? { height } : undefined}>
      <span
        className="ds-meter-fill"
        style={{
          width: `${v}%`,
          // 有读数但接近 0 时留一丝颜色，不然 0.3% 和"没数据"长得一模一样
          minWidth: !empty && value > 0 ? 3 : 0,
          background: color ?? meterTone(v),
        }}
      />
    </span>
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
        <header className="ds-card-head">
          <div style={{ minWidth: 0 }}>
            {title && <h3 className="ds-card-title">{title}</h3>}
            {subtitle && <p className="ds-card-desc">{subtitle}</p>}
          </div>
          {actions && (
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>{actions}</div>
          )}
        </header>
      )}
      <div className={padded ? 'ds-card-body' : undefined}>{children}</div>
    </section>
  );
}

/**
 * 页头：标题 + 一句说明 + 右侧动作。每一页都从这里开始，
 * 标题字号、间距、动作按钮的位置全站一致。
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className="ds-page-head">
      <div style={{ minWidth: 0, flex: '1 1 320px' }}>
        {breadcrumb}
        <h1 className="ds-page-title">{title}</h1>
        {description && <div className="ds-page-desc">{description}</div>}
      </div>
      {actions && <div className="ds-page-actions">{actions}</div>}
    </header>
  );
}

/**
 * 标签。
 *
 * 不给颜色时是中性灰的方角小块（机器的 tag）；给了颜色就变成带色的状态标记，
 * 文字色由状态色和正文色混出来，两个主题下都读得清。
 */
export function Chip({
  children,
  color,
  title,
}: {
  children: ReactNode;
  color?: string;
  title?: string;
}) {
  const chip = (
    <span
      className="ds-chip"
      style={
        color
          ? {
              color: `color-mix(in srgb, ${color} 72%, var(--ds-text-primary))`,
              background: `color-mix(in srgb, ${color} 10%, transparent)`,
              borderColor: `color-mix(in srgb, ${color} 22%, transparent)`,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
  return title ? <Tooltip content={title}>{chip}</Tooltip> : chip;
}

// ————————————————————————————————————————————————————————
// 分段控件与标签页
// ————————————————————————————————————————————————————————

/**
 * 量出选中项的位置，写进容器的 CSS 变量，让滑块/下划线滑过去。
 *
 * 第一次量完之前不开过渡（data-ready 由它控制），否则页面一打开就能看到
 * 滑块从最左边滑到选中项 —— 那不是动效，是闪烁。
 *
 * 字体晚到、容器变宽都会改变按钮尺寸，所以用 ResizeObserver 盯着每个按钮。
 */
function useIndicator(
  ref: React.RefObject<HTMLElement | null>,
  key: unknown,
  xVar: string,
  wVar: string,
): boolean {
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const place = () => {
      const active = root.querySelector<HTMLElement>('[data-indicator-active]');
      if (!active) {
        root.style.setProperty(wVar, '0px');
        return;
      }
      root.style.setProperty(xVar, `${active.offsetLeft}px`);
      root.style.setProperty(wVar, `${active.offsetWidth}px`);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(root);
    for (const child of Array.from(root.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [ref, key, xVar, wVar]);

  useEffect(() => {
    if (ready) return;
    // 等首帧位置落定再放开过渡
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    return () => cancelAnimationFrame(id);
  }, [ready]);

  return ready;
}

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  /** 选项后面的计数，颜色比标签浅一档 */
  count?: number;
  /** 只有图标时必须给，屏幕阅读器读它 */
  ariaLabel?: string;
}

/** 分段控制器：筛选、时间范围、视图切换。选中块会滑到新位置。 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size,
  iconOnly,
  ariaLabel,
}: {
  value: T;
  options: Array<SegOption<T>>;
  onChange: (v: T) => void;
  size?: 's';
  iconOnly?: boolean;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const keys = options.map((o) => o.value).join('|');
  const ready = useIndicator(ref, `${value}#${keys}`, '--seg-x', '--seg-w');

  return (
    <div
      ref={ref}
      className={`ds-seg${size === 's' ? ' ds-seg-s' : ''}${iconOnly ? ' ds-seg-icon' : ''}`}
      data-ready={ready || undefined}
      role="tablist"
      aria-label={ariaLabel}
    >
      <span className="ds-seg-thumb" aria-hidden="true" />
      {options.map((o) => {
        const active = o.value === value;
        const button = (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={o.ariaLabel}
            data-indicator-active={active || undefined}
            onClick={() => onChange(o.value)}
            className="ds-seg-item"
          >
            {o.label}
            {o.count != null && <span className="ds-seg-count">{o.count}</span>}
          </button>
        );
        // 只有图标的选项要靠提示说明自己是什么（网格视图 / 列表视图）
        return iconOnly && o.ariaLabel ? (
          <Tooltip key={o.value} content={o.ariaLabel} placement="bottom">
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}

/**
 * 下划线标签页。
 *
 * 页面内的大分区（负载 / 流量 / 安全）用它，而不是分段控件 —— 分段控件是
 * "同一份数据换个看法"，标签页是"换一块内容"，两种语义长得一样会让人分不清
 * 点下去是筛选还是跳转。
 */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; count?: number }>;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const keys = options.map((o) => o.value).join('|');
  const ready = useIndicator(ref, `${value}#${keys}`, '--ink-x', '--ink-w');

  return (
    <div ref={ref} className="ds-tabs" data-ready={ready || undefined} role="tablist" aria-label={ariaLabel}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-indicator-active={active || undefined}
            onClick={() => onChange(o.value)}
            className="ds-tab"
          >
            {o.label}
            {o.count != null && <span className="ds-chip" style={{ height: 18, padding: '0 5px', fontSize: 11 }}>{o.count}</span>}
          </button>
        );
      })}
      <span className="ds-tabs-ink" aria-hidden="true" />
    </div>
  );
}

/**
 * 链接版的下划线标签页：每个标签是一条路由。
 *
 * 管理后台、SSH 的分区落在路径上（/admin/audit），这样刷新、分享链接、
 * 浏览器后退都能回到同一个分区；用按钮切本地状态的话，这三件事全都会丢。
 */
export function LinkTabs({
  value,
  options,
  ariaLabel,
}: {
  value: string;
  options: Array<{ value: string; label: ReactNode; to: string }>;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const keys = options.map((o) => o.value).join('|');
  const ready = useIndicator(ref, `${value}#${keys}`, '--ink-x', '--ink-w');

  return (
    <nav ref={ref} className="ds-tabs" data-ready={ready || undefined} aria-label={ariaLabel}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Link
            key={o.value}
            to={o.to}
            className="ds-tab"
            aria-current={active ? 'page' : undefined}
            data-indicator-active={active || undefined}
          >
            {o.label}
          </Link>
        );
      })}
      <span className="ds-tabs-ink" aria-hidden="true" />
    </nav>
  );
}

// ————————————————————————————————————————————————————————
// 数字过渡
// ————————————————————————————————————————————————————————

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 让数字从旧值平滑过渡到新值。
 *
 * 实时面板每两秒刷一次，读数直接跳变的话，人的眼睛会被"闪了一下"吸过去，
 * 却看不出是涨了还是跌了；滚过去则自带方向感。
 *
 * from 给了就是首次挂载时的起点（汇总数字从 0 数上来）；不给就是当前值，不播入场。
 */
export function useTweened(target: number, { duration = 650, from }: { duration?: number; from?: number } = {}): number {
  const [shown, setShown] = useState(() => (from != null && Number.isFinite(target) ? from : target));
  const current = useRef(shown);
  const raf = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(target) || prefersReducedMotion()) {
      current.current = target;
      setShown(target);
      return;
    }
    const a = current.current;
    const b = target;
    if (a === b) return;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / duration);
      // easeOutCubic：起步快、落点稳，数字不会在终点附近磨蹭
      const e = 1 - (1 - k) ** 3;
      const v = a + (b - a) * e;
      current.current = v;
      setShown(v);
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration]);

  return shown;
}

/**
 * 表单控件
 *
 * **一律自绘，不用原生控件的可视部分。** 原生 select 和 date 展开后的面板由操作系统
 * 绘制，CSS 根本够不到 —— 跟设计系统毫无关系。appearance:none 只能管住收起时的样子。
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
      */
      style={{ display: 'block', flex: grow ? '1 1 168px' : undefined, width, minWidth: 0 }}
    >
      <span
        className="ds-text-body-sm"
        style={{ display: 'block', marginBottom: 6, fontWeight: 500, color: 'var(--ds-text-secondary)' }}
      >
        {label}
        {required && <span className="ds-field-req">*</span>}
      </span>
      {children}
      {foot && (
        <span
          className={`ds-text-caption ${error ? 'ds-field-error' : 'text-ds-description'}`}
          style={{ display: 'block', marginTop: 6 }}
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
 * 之前每个弹窗都自己拼一个带背景色的方块，颜色和内边距各写各的。统一到这里。
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
      <IconCheck size={15} />
    ) : tone === 'info' ? (
      <IconInfo size={15} />
    ) : (
      <IconAlert size={15} />
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
  return <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{children}</div>;
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '48px 20px',
        textAlign: 'center',
      }}
    >
      {icon && (
        <div
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 48,
            height: 48,
            marginBottom: 8,
            borderRadius: 12,
            background: 'var(--ds-bg-subtle)',
            border: '1px solid var(--ds-border)',
            color: 'var(--ds-text-description)',
          }}
        >
          {icon}
        </div>
      )}
      <p className="ds-text-subtitle text-ds-primary" style={{ margin: 0 }}>
        {title}
      </p>
      {hint && (
        <p className="ds-text-body-sm text-ds-description" style={{ margin: 0, maxWidth: 400 }}>
          {hint}
        </p>
      )}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
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
        padding: '10px 18px',
        borderTop: '1px solid var(--ds-divider)',
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
 * 卡片用 8，文字行用默认的 6。形状对不上的话，数据一到就会看到明显的变形。
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
      <div className="ds-text-caption text-ds-description" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div className="ds-num-md" style={{ color, whiteSpace: 'nowrap' }}>
        {value}
        {unit && <span className="ds-num-unit">{unit}</span>}
      </div>
      {hint && (
        <div className="ds-text-caption text-ds-description" style={{ marginTop: 3 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
