import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconCheck, IconChevronDown } from './icons';
import {
  PopoverPanel,
  scrollIntoViewIfNeeded,
  useAnchoredPosition,
  useAnchorWidth,
  useDismiss,
} from './Popover';

/**
 * 下拉选择。**完全自绘，不用原生 select。**
 *
 * 原生 select 只有收起状态的样子归 CSS 管，展开后那个列表是操作系统画的 ——
 * 深色的 macOS 菜单、Windows 的方框、各家浏览器各一套，跟设计系统毫无关系，
 * 而且 31 项这种长列表在系统菜单里格外难看。appearance:none 治不了这个。
 *
 * 自绘就得把原生白送的东西自己补上，这里补了：
 *
 * - **键盘**：↑↓ 移动、Home/End 跳两端、Enter/Space 选中、Esc 关闭、
 *   直接敲字母做前缀跳转（连敲算一个词，1 秒内不断）
 * - **焦点**：关闭后焦点回到触发器，不会掉到 body 上
 * - **无障碍**：combobox / listbox / option 这套 role 和 aria-activedescendant
 * - **滚动**：打开时把选中项滚进视野，键盘移动时跟随
 *
 * 面板走 Popover，所以不会被卡片的 overflow:hidden 裁掉，也不会被顶栏的
 * backdrop-filter 影响。
 */

export interface Option<T extends string = string> {
  value: T;
  label: string;
  /** 选项右侧的补充说明，比如"推荐"、单位 */
  hint?: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: Array<Option<T>>;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** 面板最大高度，长列表用 */
  maxHeight?: number;
  /** 触发器宽度，不给就撑满容器 */
  width?: number | string;
  id?: string;
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder = '请选择',
  disabled,
  maxHeight = 300,
  width,
  id,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ buf: '', at: 0 });

  const pos = useAnchoredPosition(triggerRef, open, maxHeight);
  // 面板跟触发器等宽，跟 width prop 是两回事：后者是调用方指定的触发器宽度
  const panelWidth = useAnchorWidth(triggerRef, open);

  const selectedIndex = useMemo(() => options.findIndex((o) => o.value === value), [options, value]);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback(() => {
    setOpen(false);
    // 焦点必须还给触发器，否则 Tab 会从头开始
    triggerRef.current?.focus();
  }, []);

  useDismiss(open, () => setOpen(false), triggerRef, panelRef);

  // 打开时高亮当前值并滚到它，而不是停在列表顶部
  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open || active < 0) return;
    scrollIntoViewIfNeeded(listRef.current?.children[active] as HTMLElement);
  }, [open, active]);

  /** 跳到下一个可选项，跳过 disabled，到头就停住不回绕 */
  function step(from: number, dir: 1 | -1): number {
    let i = from;
    for (let n = 0; n < options.length; n++) {
      i += dir;
      if (i < 0 || i >= options.length) return from;
      if (!options[i]?.disabled) return i;
    }
    return from;
  }

  function edge(dir: 1 | -1): number {
    const i = dir === 1 ? options.findIndex((o) => !o.disabled) : findLastIndex(options);
    return i >= 0 ? i : 0;
  }

  function commit(i: number) {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;

    if (!open) {
      // 收起状态下这几个键直接打开，跟原生 select 的手感一致
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => step(i, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => step(i, -1));
        return;
      case 'Home':
        e.preventDefault();
        setActive(edge(1));
        return;
      case 'End':
        e.preventDefault();
        setActive(edge(-1));
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(active);
        return;
      case 'Tab':
        // Tab 应该关掉浮层并正常移交焦点，不拦截
        setOpen(false);
        return;
    }

    // 前缀跳转：连续敲的字母算一个词，停顿超过 1 秒重新开始
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      const t = typeahead.current;
      t.buf = now - t.at > 1000 ? e.key : t.buf + e.key;
      t.at = now;
      const q = t.buf.toLowerCase();
      const hit = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(q));
      if (hit >= 0) setActive(hit);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-activedescendant={open && active >= 0 ? `${id ?? 'sel'}-opt-${active}` : undefined}
        disabled={disabled}
        className="ds-input ds-select-trigger"
        style={width ? { width } : undefined}
        data-open={open || undefined}
        onClick={() => {
          if (disabled) return;
          // macOS 上点击 button 默认不会聚焦它（平台惯例，Chrome/Safari 都遵守），
          // 不显式抢一下焦点的话，点开之后方向键、Esc、字母跳转全都不响应
          triggerRef.current?.focus();
          setOpen((v) => !v);
        }}
        onKeyDown={onKeyDown}
      >
        <span className="ds-select-value" data-placeholder={!selected || undefined}>
          {selected?.label ?? placeholder}
        </span>
        <IconChevronDown size={13} className="ds-select-arrow" />
      </button>

      {open && pos && (
        <PopoverPanel pos={pos} width={panelWidth} panelRef={panelRef} role="presentation">
          <div
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel}
            className="ds-select-list"
            tabIndex={-1}
          >
            {options.length === 0 && <div className="ds-select-empty ds-text-caption">无可选项</div>}
            {options.map((o, i) => (
              <div
                key={o.value}
                id={`${id ?? 'sel'}-opt-${i}`}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                className="ds-select-option"
                data-active={i === active || undefined}
                data-selected={o.value === value || undefined}
                data-disabled={o.disabled || undefined}
                // 用 pointerdown 而不是 click：click 会先让触发器失焦，
                // 焦点一动 useDismiss 那边就已经把面板关了
                onPointerDown={(e) => {
                  e.preventDefault();
                  commit(i);
                }}
                onPointerEnter={() => !o.disabled && setActive(i)}
              >
                <span className="ds-select-check">
                  {o.value === value && <IconCheck size={13} />}
                </span>
                <span className="ds-select-label">{o.label}</span>
                {o.hint && <span className="ds-select-hint ds-text-caption">{o.hint}</span>}
              </div>
            ))}
          </div>
        </PopoverPanel>
      )}
    </>
  );
}

/** Array.prototype.findLastIndex 在目标环境里不一定有，自己找最后一个可选项 */
function findLastIndex<T extends string>(options: Array<Option<T>>): number {
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i]?.disabled) return i;
  }
  return -1;
}
