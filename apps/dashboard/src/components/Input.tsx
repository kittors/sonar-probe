import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
  type Ref,
} from 'react';
import { IconEye, IconEyeOff, IconX } from './icons';

/**
 * 文本输入。全站的输入框都从这里出，不再直接写 <input>。
 *
 * 裸 <input> 会漏出一堆浏览器自己的东西，样式表管不到：
 *
 * - **历史记录下拉。** 点进筛选框，浏览器弹出一个系统样式的列表，里面是以前敲过的词。
 *   只有 autocomplete="off" 能关掉 —— 这是 HTML 属性，CSS 无能为力，所以默认关，
 *   真正需要填充的地方（登录的用户名、密码）由调用方显式传 autoComplete。
 * - **拼写检查的红波浪线。** 主机名、标签、公钥全是"拼错的英文"，默认关。
 * - **自动填充的底色。** Chrome 会把自动填充过的框染成浅蓝/浅黄，在 theme.css 里统一盖掉。
 * - **iOS 的内阴影和圆角**、Edge 的"显示密码"按钮、Safari 的钥匙图标：同样在样式表里去掉，
 *   密码框的显示/隐藏换成下面 PasswordInput 自己画的按钮。
 */

type NativeInputProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'prefix'>;

export interface TextInputProps extends NativeInputProps {
  /** 只开放这几种：其余 type（number、date、search…）都会带出系统自己的控件 */
  type?: 'text' | 'password' | 'email' | 'url';
  /** 框内左侧的图标 */
  leading?: ReactNode;
  /** 框内右侧的附加内容（单位、按钮） */
  trailing?: ReactNode;
  /** 给了就在有内容时显示一个清空按钮 */
  onClear?: () => void;
  /** 胶囊形，用于搜索、筛选 */
  pill?: boolean;
}

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

export function TextInput({
  type = 'text',
  leading,
  trailing,
  onClear,
  pill,
  className,
  style,
  autoComplete = 'off',
  spellCheck = false,
  ...rest
}: TextInputProps) {
  const hasValue = rest.value != null && String(rest.value) !== '';
  const showClear = Boolean(onClear) && hasValue && !rest.disabled && !rest.readOnly;
  const inputClass = cx('ds-input', pill && 'ds-input-pill', className);

  // 没有任何附加物时就是一个 input，不多包一层 —— 调用方给的宽度直接落在它身上
  if (!leading && !trailing && !onClear) {
    return (
      <input
        {...rest}
        type={type}
        className={inputClass}
        style={style}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
    );
  }

  return (
    <span className={cx('ds-input-wrap', pill && 'ds-input-pill')} style={style}>
      {leading && <span className="ds-input-leading">{leading}</span>}
      <input
        {...rest}
        type={type}
        className={inputClass}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
        style={{
          paddingLeft: leading ? (pill ? 36 : 34) : undefined,
          paddingRight: showClear || trailing ? 36 : undefined,
        }}
      />
      {(showClear || trailing) && (
        <span className="ds-input-trailing">
          {showClear ? (
            <button
              type="button"
              className="ds-input-btn"
              onClick={onClear}
              aria-label="清空"
              // 按下时不让输入框失焦：清空之后人通常还要接着输入
              onMouseDown={(e) => e.preventDefault()}
            >
              <IconX size={13} />
            </button>
          ) : (
            trailing
          )}
        </span>
      )}
    </span>
  );
}

/**
 * 密码框。显示/隐藏是自己画的按钮，各浏览器长得一样；
 * Edge 自带的那只眼睛和 Safari 的钥匙图标在样式表里藏掉了，否则会和它并排出现两个。
 */
export function PasswordInput(props: Omit<TextInputProps, 'type' | 'trailing' | 'onClear'>) {
  const [visible, setVisible] = useState(false);
  return (
    <TextInput
      {...props}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          className="ds-input-btn"
          onClick={() => setVisible((v) => !v)}
          onMouseDown={(e) => e.preventDefault()}
          aria-label={visible ? '隐藏密码' : '显示密码'}
          aria-pressed={visible}
          disabled={props.disabled}
        >
          {visible ? <IconEyeOff size={15} /> : <IconEye size={15} />}
        </button>
      }
    />
  );
}

type NativeTextAreaProps = ComponentPropsWithRef<'textarea'>;

/**
 * 多行输入：随内容自动长高，到上限后再出滚动条。
 *
 * 不用系统右下角那个拖拽角 —— 它在每个系统上长得都不一样，而且拖小了能把内容藏起来。
 */
export function TextArea({
  className,
  spellCheck = false,
  autoComplete = 'off',
  rows = 3,
  maxHeight = 320,
  ref,
  ...rest
}: NativeTextAreaProps & { maxHeight?: number }) {
  const own = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight + 2 > maxHeight ? 'auto' : 'hidden';
  }, [rest.value, maxHeight]);

  return (
    <textarea
      {...rest}
      ref={(node) => {
        own.current = node;
        assignRef(ref, node);
      }}
      rows={rows}
      spellCheck={spellCheck}
      autoComplete={autoComplete}
      className={cx('ds-input ds-textarea', className)}
    />
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as { current: T | null }).current = value;
}
