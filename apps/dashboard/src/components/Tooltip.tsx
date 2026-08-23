import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * 文字提示。
 *
 * 替代原生 title 属性。原生 title 有几个躲不掉的毛病：延迟一秒多才出来、样式由
 * 操作系统画（跟设计系统无关）、不跟主题、换行不可控、触屏上完全不出现，
 * 而且键盘聚焦时也不会显示。
 *
 * 实现上的取舍，逐条都是踩过的：
 *
 * 1. **不额外包一层 DOM。** 用 cloneElement 把事件和 ref 注到 children 上 ——
 *    包一层 span 会破坏 flex/grid 布局（尤其是 gap 和 align-items）。
 *
 * 2. **hover 有延迟，移开立即消失。** 鼠标扫过一排图标按钮时，没有延迟会一路闪。
 *    但**连续悬停时跳过延迟**：刚看完一个提示紧接着看下一个，再等 350ms 很烦躁。
 *
 * 3. **focus 也要触发。** 只做 hover 的话键盘用户永远看不到这些说明。
 *
 * 4. **pointer-events: none。** 提示框绝不能挡住鼠标，否则它盖住按钮时点不动。
 *
 * 5. **Portal 到 body。** 卡片和弹窗都有 overflow:hidden，不脱出去会被裁掉半截。
 */

/**
 * 上一个提示消失的时刻。
 *
 * 模块级共享：在多个目标之间连续移动时，第二个之后的提示应该立刻出现而不是
 * 每次都重新等 350ms —— 这就是所谓的 warm-up 期。
 */
let lastHiddenAt = 0;
const WARM_MS = 400;
const DELAY_MS = 350;
const GAP = 8;
const EDGE = 8;

interface Props {
  /** 提示内容。为空时等于没套 Tooltip，不加任何监听也不渲染 */
  content: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  placement?: 'top' | 'bottom';
  /** 提示框最大宽度，超出自动换行 */
  maxWidth?: number;
}

export function Tooltip({ content, children, placement = 'top', maxWidth = 260 }: Props) {
  const id = useId();
  const anchorRef = useRef<HTMLElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  /*
   * 跟 open 同步的镜像。
   *
   * 隐藏时要记下时刻给 warm-up 用，但那是个副作用 —— 写在 setOpen 的 updater 里
   * 不可靠（React 可能重复调用 updater，也可能推迟执行），必须在事件处理里同步记。
   * 而事件处理拿到的 open 是闭包里的旧值，所以额外拿 ref 存一份当前值。
   */
  const openRef = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const reveal = useCallback(() => {
    openRef.current = true;
    setOpen(true);
  }, []);

  const show = useCallback(
    (immediate = false) => {
      cancel();
      // 刚有别的提示消失不久，就别再让人干等一次
      const warm = Date.now() - lastHiddenAt < WARM_MS;
      if (immediate || warm) reveal();
      else timer.current = setTimeout(reveal, DELAY_MS);
    },
    [cancel, reveal],
  );

  const hide = useCallback(() => {
    cancel();
    if (openRef.current) lastHiddenAt = Date.now();
    openRef.current = false;
    setOpen(false);
  }, [cancel]);

  // 卸载时必须清掉定时器，否则组件没了还会 setState
  useEffect(() => cancel, [cancel]);

  // Esc 关掉提示。提示可能盖住内容，得给人一个立刻收起的办法
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, hide]);

  // 定位：先渲染再量，这样才知道提示框自己有多大
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }

    const place = () => {
      const a = anchorRef.current;
      const t = tipRef.current;
      if (!a || !t) return;
      const ar = a.getBoundingClientRect();
      const tw = t.offsetWidth;
      const th = t.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // 水平居中对齐锚点，再夹进视口
      let left = ar.left + ar.width / 2 - tw / 2;
      left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - tw - EDGE));

      // 首选方向放不下就翻到另一侧
      const wantTop = placement === 'top';
      const topSpace = ar.top - GAP - EDGE;
      const bottomSpace = vh - ar.bottom - GAP - EDGE;
      const useTop = wantTop ? topSpace >= th || topSpace >= bottomSpace : bottomSpace < th && topSpace > bottomSpace;

      const top = useTop ? ar.top - GAP - th : ar.bottom + GAP;
      setPos({ left, top: Math.min(Math.max(EDGE, top), vh - th - EDGE) });
    };

    place();
    // 滚动容器可能是内层元素，得用 capture 才收得到
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, placement, content]);

  // 内容为空就当没套过：不注入任何事件，也不占 aria
  if (content === null || content === undefined || content === '' || content === false) {
    return children;
  }

  const childProps = children.props;

  const merged = cloneElement(children, {
    ref: mergeRefs(anchorRef, (children as unknown as { ref?: Ref<HTMLElement> }).ref),
    'aria-describedby': open ? id : undefined,
    onMouseEnter: (e: MouseEvent) => {
      show();
      (childProps.onMouseEnter as ((e: MouseEvent) => void) | undefined)?.(e);
    },
    onMouseLeave: (e: MouseEvent) => {
      hide();
      (childProps.onMouseLeave as ((e: MouseEvent) => void) | undefined)?.(e);
    },
    // 键盘聚焦也要出提示，否则这些说明对键盘用户等于不存在。
    // 用 focus 而不是 focusVisible：鼠标点击后的聚焦紧接着就是 mouseleave，不会滞留
    onFocus: (e: FocusEvent) => {
      show(true);
      (childProps.onFocus as ((e: FocusEvent) => void) | undefined)?.(e);
    },
    onBlur: (e: FocusEvent) => {
      hide();
      (childProps.onBlur as ((e: FocusEvent) => void) | undefined)?.(e);
    },
    // 触屏没有 hover，按下时直接给出提示，松开就收
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === 'touch') show(true);
      (childProps.onPointerDown as ((e: PointerEvent) => void) | undefined)?.(e);
    },
  } as Record<string, unknown>);

  return (
    <>
      {merged}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className="ds-tooltip"
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              maxWidth,
              // 量出尺寸之前先藏起来，否则会看到它从 (0,0) 跳到正确位置
              visibility: pos ? 'visible' : 'hidden',
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}

/** children 自己可能已经带了 ref，不能直接覆盖掉 */
function mergeRefs(...refs: Array<Ref<HTMLElement> | undefined>) {
  return (node: HTMLElement | null) => {
    for (const r of refs) {
      if (!r) continue;
      if (typeof r === 'function') r(node);
      else (r as { current: HTMLElement | null }).current = node;
    }
  };
}
