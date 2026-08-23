import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconCalendar, IconChevronLeft, IconChevronRight, IconX } from './icons';
import { PopoverPanel, useAnchoredPosition, useDismiss } from './Popover';

/**
 * 日期选择。**完全自绘，不用 input[type=date]。**
 *
 * 原生日期控件的日历面板由浏览器提供：Chrome 一套、Safari 一套、Firefox 又一套，
 * 移动端还会拉起系统滚轮。CSS 只能改到输入框本身，面板一点都碰不到。
 *
 * 值的格式统一用 YYYY-MM-DD，和原生 input[type=date] 一致，调用方不用改。
 *
 * 时区上只用「本地日期」，不碰 UTC：日历上点的是哪天就是哪天，
 * 用 Date 的 UTC 方法会让 UTC+8 的用户在晚上 8 点后点出前一天。
 */

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
/** 首帧定位的估算高度。真实值渲染后由 ResizeObserver 量出来覆盖 */
const CAL_HEIGHT = 302;

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

interface Props {
  /** YYYY-MM-DD，空串表示未选 */
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** 允许清空 */
  clearable?: boolean;
}

export function DatePicker({
  value,
  onChange,
  ariaLabel = '选择日期',
  placeholder = '年 / 月 / 日',
  disabled,
  clearable = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => parse(value), [value]);
  // 面板当前翻到哪个月。没选值就落在今天所在的月
  const [view, setView] = useState(() => startOfMonth(selected ?? new Date()));
  // 键盘导航的游标
  const [cursor, setCursor] = useState(() => selected ?? today());

  // 日历尺寸是固定的：头 30 + 星期行 26 + 6×30 网格（含 gap）190 + 底栏 39 + 内外边距 16。
  // 用 fit 模式，放不下就整体挪位置，绝不压缩出滚动条。
  // 首帧用估算值定位，面板挂上去后量到真实高度再修正 —— 手算总会差几个像素
  const [panelH, setPanelH] = useState<number>();
  const pos = useAnchoredPosition(triggerRef, open, CAL_HEIGHT, 'fit', panelH);

  useLayoutEffect(() => {
    if (!open) {
      setPanelH(undefined);
      return;
    }
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPanelH(el.offsetHeight));
    ro.observe(el);
    setPanelH(el.offsetHeight);
    return () => ro.disconnect();
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useDismiss(open, () => setOpen(false), triggerRef, panelRef);

  // 每次打开都对齐到当前值，避免上次翻到别的月份留在那儿
  useEffect(() => {
    if (!open) return;
    const base = selected ?? today();
    setView(startOfMonth(base));
    setCursor(base);
  }, [open, selected]);

  const days = useMemo(() => buildGrid(view), [view]);
  const todayKey = fmt(today());

  function pick(d: Date) {
    onChange(fmt(d));
    close();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    const move = (days: number) => {
      e.preventDefault();
      const next = addDays(cursor, days);
      setCursor(next);
      // 游标走出当前月就跟着翻页
      if (next.getMonth() !== view.getMonth() || next.getFullYear() !== view.getFullYear()) {
        setView(startOfMonth(next));
      }
    };

    switch (e.key) {
      case 'ArrowLeft':
        return move(-1);
      case 'ArrowRight':
        return move(1);
      case 'ArrowUp':
        return move(-7);
      case 'ArrowDown':
        return move(7);
      case 'PageUp':
        e.preventDefault();
        return setView((v) => addMonths(v, -1));
      case 'PageDown':
        e.preventDefault();
        return setView((v) => addMonths(v, 1));
      case 'Enter':
      case ' ':
        e.preventDefault();
        return pick(cursor);
      case 'Tab':
        setOpen(false);
        return;
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        className="ds-input ds-date-trigger"
        data-open={open || undefined}
        onClick={() => {
          if (disabled) return;
          // 同 Select：macOS 点击 button 不自动聚焦，键盘导航会整个失灵
          triggerRef.current?.focus();
          setOpen((v) => !v);
        }}
        onKeyDown={onKeyDown}
      >
        <IconCalendar size={13} className="ds-date-icon" />
        <span className="ds-date-value tnum" data-placeholder={!value || undefined}>
          {value ? display(value) : placeholder}
        </span>
        {clearable && value && (
          // 触发器是 button，里面不能再嵌 button（HTML 不允许），用 span 承担点击
          <span
            role="button"
            tabIndex={-1}
            aria-label="清除日期"
            className="ds-date-clear"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onChange('');
            }}
          >
            <IconX size={11} />
          </span>
        )}
      </button>

      {open && pos && (
        <PopoverPanel pos={pos} width={272} panelRef={panelRef} ariaLabel={ariaLabel}>
          <div className="ds-cal" onKeyDown={onKeyDown}>
            <div className="ds-cal-head">
              <button
                type="button"
                className="ds-btn-icon ds-btn-icon-s"
                aria-label="上一月"
                onClick={() => setView((v) => addMonths(v, -1))}
              >
                <IconChevronLeft size={14} />
              </button>
              <span className="ds-cal-title ds-text-body-sm">
                {view.getFullYear()} 年 {MONTHS[view.getMonth()]}
              </span>
              <button
                type="button"
                className="ds-btn-icon ds-btn-icon-s"
                aria-label="下一月"
                onClick={() => setView((v) => addMonths(v, 1))}
              >
                <IconChevronRight size={14} />
              </button>
            </div>

            <div className="ds-cal-grid ds-cal-week">
              {WEEKDAYS.map((w) => (
                <span key={w} className="ds-cal-wd ds-text-xs">
                  {w}
                </span>
              ))}
            </div>

            <div className="ds-cal-grid" role="grid">
              {days.map((d) => {
                const key = fmt(d);
                const outside = d.getMonth() !== view.getMonth();
                return (
                  <button
                    key={key}
                    type="button"
                    role="gridcell"
                    className="ds-cal-day tnum"
                    aria-selected={key === value}
                    aria-current={key === todayKey ? 'date' : undefined}
                    data-outside={outside || undefined}
                    data-today={key === todayKey || undefined}
                    data-selected={key === value || undefined}
                    data-cursor={key === fmt(cursor) || undefined}
                    onClick={() => pick(d)}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>

            <div className="ds-cal-foot">
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-s"
                onClick={() => pick(today())}
              >
                今天
              </button>
              {clearable && (
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-s"
                  onClick={() => {
                    onChange('');
                    close();
                  }}
                >
                  清除
                </button>
              )}
            </div>
          </div>
        </PopoverPanel>
      )}
    </>
  );
}

// ——— 日期工具。一律走本地时间，不要引入 UTC ———

function today(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function parse(v: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  // 2026-02-31 这种非法日期会被 Date 顺延到 3 月，得查出来
  return date.getMonth() === m - 1 ? date : null;
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function display(v: string): string {
  const d = parse(v);
  return d ? `${d.getFullYear()} / ${d.getMonth() + 1} / ${d.getDate()}` : v;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * 加减月份。
 *
 * 直接 setMonth 会让 1 月 31 日加一个月变成 3 月 3 日（2 月没有 31 号，
 * Date 自动顺延）。日历翻页只关心月份，所以从每月 1 号出发。
 */
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/** 生成 6×7 的格子，周一起始，前后补齐邻月的日期 */
function buildGrid(view: Date): Date[] {
  const first = startOfMonth(view);
  // getDay() 是周日=0，这里要周一=0
  const offset = (first.getDay() + 6) % 7;
  const start = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
