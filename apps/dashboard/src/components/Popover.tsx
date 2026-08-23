import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * 浮层定位原语。下拉、日历、以后的自绘 tooltip 都建在这上面。
 *
 * 四件事必须在这里一次解决，否则每个浮层都会各踩一遍：
 *
 * 1. **Portal 到 body。** 浮层的祖先里只要有一个 overflow:hidden（卡片、弹窗主体
 *    全都有）或者 backdrop-filter（顶栏），浮层就会被裁掉或者定位错乱。
 *
 * 2. **跟着锚点走。** 脱离了文档流就享受不到布局了，得自己在滚动和窗口尺寸变化时
 *    重算位置 —— 而且要监听**所有**祖先的滚动，不只是 window：弹窗主体自己就是
 *    一个滚动容器，只听 window 的话在弹窗里滚动浮层会飘在原地。
 *
 * 3. **边界翻转。** 下方空间不够就往上弹，右边溢出就贴右边。长列表尤其明显 ——
 *    31 个选项的下拉在屏幕下半部分打开时必然超出视口。
 *
 * 4. **点外关闭 / Esc 关闭。** 用 pointerdown 而不是 click：click 要等到抬起才触发，
 *    按住拖拽的场景下浮层会滞留。
 */

export interface PopoverPos {
  left: number;
  top: number;
  /** 可用高度，长列表用它决定自己最多能撑多高 */
  maxHeight: number;
  /** 是否朝上弹，做入场动画方向用 */
  flipped: boolean;
  /** 面板自身是否需要滚动条。固定尺寸内容（日历）为 false */
  scroll: boolean;
}

const GAP = 6;
const EDGE = 8;

/**
 * 高度策略。
 *
 * - `scroll`：内容可以任意长（下拉列表），把面板压到可用空间内，超出部分滚动。
 * - `fit`：内容是固定尺寸的（日历那种月历网格），**绝不压缩也绝不滚动** ——
 *   一个 6×7 的月历被压出滚动条既难看又难用。放不下就整体挪，实在不行贴视口边。
 */
export type PopoverFit = 'scroll' | 'fit';

export function useAnchoredPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  desiredHeight = 320,
  mode: PopoverFit = 'scroll',
  /**
   * fit 模式下面板的真实高度。
   *
   * 传 desiredHeight 只是首帧的估算值 —— 手算内容高度必然会差几个像素
   * （行高、边框、字体渲染都会influence），差一点就会被 overflow:hidden 裁掉一截。
   * 面板渲染出来后把量到的高度回传，位置按真实值重算。
   */
  actualHeight?: number,
): PopoverPos | null {
  const [pos, setPos] = useState<PopoverPos | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }

    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;

      const width = r.width;
      const left = Math.min(Math.max(EDGE, r.left), vw - width - EDGE);

      if (mode === 'fit') {
        const h = actualHeight ?? desiredHeight;
        // 先试下方；放不下改上方；上下都放不下就夹进视口，宁可挡住锚点
        // 也不要把内容截断 —— 至少还完整可读可点
        let top = r.bottom + GAP;
        if (top + h > vh - EDGE) {
          const aboveTop = r.top - GAP - h;
          top = aboveTop >= EDGE ? aboveTop : Math.max(EDGE, vh - h - EDGE);
        }
        // maxHeight 给 none：让内容自己撑开，绝不裁剪
        setPos({ left, top, maxHeight: 0, flipped: false, scroll: false });
        return;
      }

      const below = vh - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      // 下方放得下就放下方；放不下且上方更宽敞才翻转
      const flipped = below < Math.min(desiredHeight, 200) && above > below;
      const maxHeight = Math.max(120, Math.min(desiredHeight, flipped ? above : below));
      const top = flipped ? r.top - GAP : r.bottom + GAP;

      setPos({ left, top, maxHeight, flipped, scroll: true });
    };

    compute();

    // capture 阶段才能收到内层滚动容器（弹窗主体）冒泡不上来的滚动事件
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [anchorRef, open, desiredHeight, mode, actualHeight]);

  return pos;
}

/** 点浮层和锚点之外时关闭，以及 Esc 关闭。 */
export function useDismiss(
  open: boolean,
  onClose: () => void,
  ...refs: Array<RefObject<HTMLElement | null>>
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
    // refs 是展开参数，每次渲染都是新数组，放进依赖会导致监听反复重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);
}

/** 浮层容器：定位 + Portal + 尺寸约束都由它负责，内容只管自己长什么样。 */
export function PopoverPanel({
  pos,
  width,
  children,
  panelRef,
  role = 'dialog',
  ariaLabel,
}: {
  pos: PopoverPos;
  /** 不给就跟锚点同宽 */
  width?: number;
  children: ReactNode;
  panelRef: RefObject<HTMLDivElement | null>;
  role?: string;
  ariaLabel?: string;
}) {
  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      className="ds-popover"
      data-scroll={pos.scroll || undefined}
      style={{
        left: pos.left,
        top: pos.top,
        width,
        maxHeight: pos.maxHeight || undefined,
        // 朝上弹时用 translateY(-100%) 让底边贴住锚点，比反过来算 top 要稳
        transform: pos.flipped ? 'translateY(-100%)' : undefined,
        transformOrigin: pos.flipped ? 'bottom' : 'top',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** 浮层跟锚点同宽时要量一下锚点宽度。 */
export function useAnchorWidth(ref: RefObject<HTMLElement | null>, open: boolean): number | undefined {
  const [w, setW] = useState<number>();
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    setW(ref.current.getBoundingClientRect().width);
  }, [ref, open]);
  return w;
}

/** 把元素滚进可视区，但不惊动整页 —— block:'nearest' 只在必要时才滚。 */
export function scrollIntoViewIfNeeded(el: HTMLElement | null) {
  el?.scrollIntoView({ block: 'nearest' });
}

export type { RefObject };
