import { useState } from 'react';
import { Tooltip } from './Tooltip';

/**
 * 国家/地区旗帜。
 *
 * 走过两版弯路，记下来免得再绕：
 *
 * 1. **Unicode 国旗 emoji（🇭🇰）** —— Windows 根本不渲染，退化成两个方块字母；
 *    多数 Linux 桌面同理。样式还由系统 emoji 字体决定，不跟主题。
 * 2. **自绘的文字徽标** —— 跨平台是一致了，但一个写着「HK」的小方块传达不了
 *    任何"这是哪儿"的直觉，远不如一眼认出的旗子。
 *
 * 现在用真实的 SVG 旗帜（public/flags/，来自 flag-icons，MIT）。旗帜图案不适合
 * 手绘：香港的紫荆花、英国的米字旗、韩国的太极卦象，画歪了比不画更糟。
 *
 * 用 <img> 而不是内联 SVG：271 面旗全内联进 JS 是 2.7MB，而 img 让浏览器只请求
 * 实际出现在屏幕上的那几面，还能走 HTTP 缓存。
 */

interface Props {
  /** ISO 3166-1 alpha-2，如 HK。XX 或空表示未知 */
  code: string;
  size?: 'sm' | 'md' | 'lg';
  /** 悬停提示，通常传地区全名 */
  title?: string;
}

const SIZES = { sm: 16, md: 20, lg: 26 } as const;

export function CountryBadge({ code, size = 'sm', title }: Props) {
  const cc = normalize(code);
  const [broken, setBroken] = useState(false);
  const w = SIZES[size];

  // 未知地区、或者这个代码没有对应的旗帜文件时，退回一个中性的地球图标，
  // 不显示裸代码 —— 一个写着 ZZ 的方块只会让人以为是渲染坏了
  if (cc === 'XX' || broken) {
    return (
      <Tooltip content={title ?? '未知地区'}>
        <span className="ds-flag ds-flag-unknown" style={{ width: w, height: w * 0.75 }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
          </svg>
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={title ?? cc}>
      <img
        className="ds-flag"
        src={`/flags/${cc.toLowerCase()}.svg`}
        alt={cc}
        width={w}
        height={Math.round(w * 0.75)}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
      />
    </Tooltip>
  );
}

function normalize(code: string): string {
  const cc = (code ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) && cc !== 'XX' ? cc : 'XX';
}
