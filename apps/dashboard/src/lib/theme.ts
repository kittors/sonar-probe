import { useSyncExternalStore } from 'react';

/**
 * 主题切换
 *
 * 之前放在 live.ts 里用 useState 管，有三个毛病，这里逐个解决：
 *
 * 1. `data-theme` 在 useEffect 里才写，首帧是默认浅色 —— 深色用户每次刷新都白闪一下。
 *    → 挪到 index.html 的同步内联脚本里，在样式表解析前就定好。
 *
 * 2. 一部分元素带 transition（按钮、卡片），一部分不带。切换瞬间前者用 0.2s 渐变、
 *    后者立刻变色，看起来就是"某些元素在闪"。
 *    → 切换时给 <html> 打个标记，CSS 里把所有过渡和动画全部冻住，下一帧再解开。
 *
 * 3. theme state 挂在 Shell 上，一变就重渲染整棵树（所有卡片和图表跟着重画）。
 *    → 改成模块级 store + useSyncExternalStore，只有真正读它的组件才重渲染。
 */

export type Theme = 'light' | 'dark';

const KEY = 'sonar-theme';
const listeners = new Set<() => void>();

function read(): Theme {
  const el = document.documentElement.dataset.theme;
  if (el === 'light' || el === 'dark') return el;
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let current: Theme = typeof document === 'undefined' ? 'light' : read();

/** 页面加载完成后解除首帧的过渡冻结。 */
if (typeof document !== 'undefined') {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      delete document.documentElement.dataset.themeBoot;
    });
  });

  // 没手动选过时跟随系统。手动选过就以用户的选择为准，不再被系统切换打断。
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (localStorage.getItem(KEY)) return;
    commit(e.matches ? 'dark' : 'light');
  });
}

function commit(next: Theme): void {
  if (next === current) return;
  current = next;

  const root = document.documentElement;
  // 冻住所有过渡再换色，避免不同元素以不同速度变色
  root.dataset.themeSwitching = '1';
  root.dataset.theme = next;

  // 两帧之后再解冻：一帧让样式生效，一帧确保浏览器已完成重绘
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      delete root.dataset.themeSwitching;
    });
  });

  for (const fn of listeners) fn();
}

/**
 * 切换主题。
 *
 * 不加任何过场动画：换色就是一瞬间的事，配合上面的过渡冻结，
 * 得到的是干净的瞬切。加扩散/淡入之类的效果反而会让人等它演完。
 */
export function setTheme(next: Theme): void {
  if (next === current) return;
  localStorage.setItem(KEY, next);
  commit(next);
}

export function toggleTheme(): void {
  setTheme(current === 'dark' ? 'light' : 'dark');
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): Theme {
  return current;
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'light' as Theme);
}
