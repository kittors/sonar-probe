import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconCalendar, IconChevronLeft, IconChevronRight } from './icons';
import { PopoverPanel, useAnchoredPosition, useDismiss } from './Popover';

/**
 * 日期范围选择。双月并排，完全自绘。
 *
 * 和单日的 DatePicker 分开，不是复用不动，是交互本来就不一样：范围选择要处理
 * 「点了第一下还没点第二下」这个中间态 —— 悬停要预览、跨月要能选、点反了要自动
 * 换过来。把这套状态机塞进 DatePicker 只会让两个用法互相拖累。
 *
 * 左边一列是快捷项。这不是锦上添花：绝大多数时候人想问的就是「这个计费周期用了
 * 多少」，那个区间的起点取决于账单日，让人自己去日历里数出来是没道理的。
 *
 * 值的格式统一 YYYY-MM-DD，本地日期，不碰 UTC —— 日历上点的是哪天就是哪天。
 */

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
/** 首帧定位的估算高度，挂载后由 ResizeObserver 量真实值覆盖 */
const PANEL_HEIGHT = 316;
const PANEL_WIDTH = 528;

export interface Range {
  from: string;
  to: string;
}

export interface RangePreset {
  key: string;
  label: string;
  /** 返回 null 表示这个快捷项当前不可用（比如还没拿到机器的账单日） */
  range: () => Range | null;
}

interface Props {
  value: Range;
  onChange: (v: Range) => void;
  presets?: RangePreset[];
  /** 命中的快捷项 key，由调用方判定 —— 它才知道「本周期」此刻是哪一段 */
  activePreset?: string;
  /** 不允许选到这天之后。默认今天：未来还没有数据，选了只会稀释日均 */
  max?: string;
  disabled?: boolean;
}

export function DateRangePicker({
  value,
  onChange,
  presets = [],
  activePreset,
  max,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * 选择中的锚点。
   *
   * 点第一下记在这里，第二下才真正提交。中间态下日历要跟着鼠标预览区间，
   * 否则人得盲选第二个端点 —— 尤其跨月的时候完全看不出自己选中了多长。
   */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const maxDay = max ?? fmt(today());
  /*
   * 左侧月份。**右**边对齐区间终点，左边是它的上一个月。
   *
   * 反过来（左边放 from 所在月）在区间落在同一个月时会把右半个面板
   * 让给一个整月禁用的未来月 —— 一半的界面什么都点不了。
   */
  const [view, setView] = useState(() => leftMonthFor(value));

  const [panelH, setPanelH] = useState<number>();
  const pos = useAnchoredPosition(triggerRef, open, PANEL_HEIGHT, 'fit', panelH, PANEL_WIDTH);

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
    setAnchor(null);
    setHover(null);
  }, []);

  useDismiss(open, close, triggerRef, panelRef);

  // 每次打开都回到当前区间，免得上次翻到的月份留在那儿
  useEffect(() => {
    if (!open) return;
    setView(leftMonthFor(value));
    setAnchor(null);
    setHover(null);
  }, [open, value]);

  /** 预览区间：选到一半时跟着鼠标走，否则就是已确定的值 */
  const preview = useMemo<Range>(() => {
    if (!anchor) return value;
    const other = hover ?? anchor;
    return anchor <= other ? { from: anchor, to: other } : { from: other, to: anchor };
  }, [anchor, hover, value]);

  function pick(day: string) {
    if (day > maxDay) return;
    if (!anchor) {
      setAnchor(day);
      setHover(day);
      return;
    }
    // 点反了就换过来，而不是让人重选一遍
    const next: Range = anchor <= day ? { from: anchor, to: day } : { from: day, to: anchor };
    onChange(next);
    close();
    triggerRef.current?.focus();
  }

  const months = [view, addMonths(view, 1)];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="选择日期范围"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        className="ds-input ds-date-trigger ds-range-trigger"
        data-open={open || undefined}
        onClick={() => {
          if (disabled) return;
          // macOS 点 button 不自动聚焦，不补这一下键盘导航会整个失灵
          triggerRef.current?.focus();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (!open && ['Enter', ' ', 'ArrowDown'].includes(e.key)) {
            e.preventDefault();
            setOpen(true);
          }
          if (open && e.key === 'Escape') close();
        }}
      >
        <IconCalendar size={13} className="ds-date-icon" />
        <span className="ds-date-value tnum">{summarize(value, activePreset, presets)}</span>
      </button>

      {open && pos && (
        <PopoverPanel pos={pos} width={PANEL_WIDTH} panelRef={panelRef} ariaLabel="选择日期范围">
          <div className="ds-range" onKeyDown={(e) => e.key === 'Escape' && close()}>
            {presets.length > 0 && (
              <div className="ds-range-presets">
                {presets.map((p) => {
                  const r = p.range();
                  return (
                    <button
                      key={p.key}
                      type="button"
                      className="ds-range-preset"
                      disabled={!r}
                      data-active={activePreset === p.key || undefined}
                      onClick={() => {
                        if (!r) return;
                        onChange(r);
                        close();
                      }}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="ds-range-cals">
              <div className="ds-range-nav">
                <button
                  type="button"
                  className="ds-btn-icon ds-btn-icon-s"
                  aria-label="上一月"
                  onClick={() => setView((v) => addMonths(v, -1))}
                >
                  <IconChevronLeft size={14} />
                </button>
                <div className="ds-range-titles">
                  {months.map((m) => (
                    <span key={fmt(m)} className="ds-cal-title ds-text-body-sm">
                      {m.getFullYear()} 年 {MONTHS[m.getMonth()]}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  className="ds-btn-icon ds-btn-icon-s"
                  aria-label="下一月"
                  onClick={() => setView((v) => addMonths(v, 1))}
                >
                  <IconChevronRight size={14} />
                </button>
              </div>

              <div className="ds-range-grids" onPointerLeave={() => anchor && setHover(anchor)}>
                {months.map((m) => (
                  <MonthGrid
                    key={fmt(m)}
                    month={m}
                    range={preview}
                    maxDay={maxDay}
                    onPick={pick}
                    onHover={(d) => anchor && setHover(d)}
                  />
                ))}
              </div>

              <div className="ds-range-foot">
                <span className="ds-text-xs text-ds-description">
                  {anchor
                    ? '再点一天定下结束日'
                    : `${display(value.from)} — ${display(value.to)} · 共 ${dayCount(value)} 天`}
                </span>
              </div>
            </div>
          </div>
        </PopoverPanel>
      )}
    </>
  );
}

function MonthGrid({
  month,
  range,
  maxDay,
  onPick,
  onHover,
}: {
  month: Date;
  range: Range;
  maxDay: string;
  onPick: (d: string) => void;
  onHover: (d: string) => void;
}) {
  const days = useMemo(() => buildGrid(month), [month]);
  const todayKey = fmt(today());

  return (
    <div className="ds-range-month">
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
          /*
           * 双月视图里，补格用的邻月日期留空。
           *
           * 单月日历显示它们是对的（那是看到隔壁月的唯一途径），但这里隔壁月
           * 就在旁边：8 月网格末行的 9/1 和 9 月网格里的 9/1 是同一天，
           * 两边都高亮会让一段 7 天的区间看起来选了两截。
           */
          if (d.getMonth() !== month.getMonth()) {
            return <span key={key} className="ds-cal-day" aria-hidden="true" />;
          }
          const inRange = key >= range.from && key <= range.to;
          const isEnd = key === range.from || key === range.to;
          return (
            <button
              key={key}
              type="button"
              role="gridcell"
              className="ds-cal-day ds-range-day tnum"
              aria-selected={isEnd}
              aria-current={key === todayKey ? 'date' : undefined}
              disabled={key > maxDay}
              data-today={key === todayKey || undefined}
              data-selected={isEnd || undefined}
              /* 区间中段用浅底连成一条，两端才是实心 —— 一眼看出选了多长 */
              data-in-range={inRange && !isEnd || undefined}
              data-range-start={key === range.from && range.from !== range.to || undefined}
              data-range-end={key === range.to && range.from !== range.to || undefined}
              onClick={() => onPick(key)}
              onPointerEnter={() => onHover(key)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
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
  return d ? `${d.getMonth() + 1}/${d.getDate()}` : v;
}

/** 闭区间的天数，含首尾。 */
export function dayCount(r: Range): number {
  const a = parse(r.from);
  const b = parse(r.to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
}

/** 触发器上的文字。命中快捷项就显示它的名字，那比两个日期好读得多 */
function summarize(v: Range, active: string | undefined, presets: RangePreset[]): string {
  const hit = active ? presets.find((p) => p.key === active) : undefined;
  if (hit) return hit.label;
  const a = parse(v.from);
  const b = parse(v.to);
  if (!a || !b) return '选择范围';
  const same = a.getFullYear() === b.getFullYear();
  const left = `${a.getFullYear()}/${a.getMonth() + 1}/${a.getDate()}`;
  const right = same
    ? `${b.getMonth() + 1}/${b.getDate()}`
    : `${b.getFullYear()}/${b.getMonth() + 1}/${b.getDate()}`;
  return `${left} — ${right}`;
}

/** 打开时左侧该停在哪个月：右边对齐区间终点，左边就是它的上一个月。 */
function leftMonthFor(v: Range): Date {
  return addMonths(startOfMonth(parse(v.to) ?? today()), -1);
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
 * Date 自动顺延）。翻页只关心月份，所以从每月 1 号出发。
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

// ——— 给调用方拼常用区间用 ———

/** 最近 n 天（含今天）。 */
export function lastNDays(n: number): Range {
  return { from: fmt(addDays(today(), -(Math.max(1, n) - 1))), to: fmt(today()) };
}

/** 从某天到今天。周期起点由服务端给，前端只负责封口。 */
export function sinceDay(from: string): Range {
  return { from, to: fmt(today()) };
}

export function isSameRange(a: Range, b: Range | null): boolean {
  return !!b && a.from === b.from && a.to === b.to;
}
