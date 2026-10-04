import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from './icons';

/**
 * 统一弹窗
 *
 * 之前三个弹窗各写了一遍 portal、遮罩、ESC 关闭、点击外部关闭和滚动处理，
 * 于是同一个 bug 也各犯了一遍。这里收成一个组件，几个容易踩的点一次解决：
 *
 * 1. **必须 Portal 到 body。** 弹窗常常渲染在顶栏里，而顶栏有 backdrop-filter ——
 *    带 backdrop-filter / transform / filter 的元素会成为后代 fixed 定位的包含块，
 *    不脱离出去的话 inset:0 的遮罩只会撑满那条 58px 高的顶栏。
 *
 * 2. **overflow: hidden 不能少。** 底部 footer 有自己的背景色，父容器不裁剪的话
 *    那块方角背景会直接盖掉弹窗的圆角。
 *
 * 3. **遮罩用 flex + margin:auto，不用 place-items:center。** 内容比视口高时，
 *    居中会把顶部推出屏幕外而且滚不回来。
 *
 * 4. **打开时锁 body 滚动。** 否则在弹窗里滚到底会带着背后的页面一起滚。
 */

interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
  /** 主体是否自带内边距。表格类内容通常要贴边 */
  padded?: boolean;
  icon?: ReactNode;
}

export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  width = 520,
  padded = true,
  icon,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);

    // 锁住背景滚动，同时补上滚动条宽度，避免页面横向跳一下
    const prev = document.body.style.overflow;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    const prevPad = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      document.body.style.paddingRight = prevPad;
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="ds-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="ds-modal ds-modal-enter" style={{ width: `min(${width}px, 100%)`, margin: 'auto' }}>
        <header className="ds-modal-head">
          {icon && <span className="ds-modal-icon">{icon}</span>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="text-ds-primary" style={{ margin: 0, fontSize: 18, fontWeight: 500, letterSpacing: '-0.015em', lineHeight: 1.35 }}>
              {title}
            </h2>
            {subtitle && (
              <p className="ds-text-body-sm text-ds-description" style={{ margin: '3px 0 0' }}>
                {subtitle}
              </p>
            )}
          </div>
          <button className="ds-btn-icon" onClick={onClose} aria-label="关闭">
            <IconX size={15} />
          </button>
        </header>

        <div className="ds-modal-body" style={padded ? undefined : { padding: 0 }}>
          {children}
        </div>

        {footer && <footer className="ds-modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
