/**
 * 面板设置（前端侧）。
 *
 * 这里只放**展示口径** —— 数字该按什么单位、什么货币、什么时区渲染。
 * 完整设置（保留策略、告警阈值、汇率覆盖）由设置页单独去拉，普通页面用不上。
 *
 * 做成模块级单例而不是 Context，理由和 live.ts 一样：
 *   1. 它要在 React 之外生效 —— format.ts 的 bytes()/money() 是纯函数，
 *      被几十处调用，其中不少在 map 回调里，改成 hook 等于把"格式化一个数字"
 *      变成组件树的关注点；
 *   2. 页面切换时不该重新拉一次。
 *
 * 首帧不能闪：口径变了会让页面上每个数字都跳一下（1.83 TB → 2.01 TB）。
 * 所以上一次的设置写进 localStorage，模块一加载就先用上，网络回来再对齐。
 */

import { useSyncExternalStore } from 'react';
import { applyDisplaySettings } from './format';
import type { Currency } from './currency';

export type TrafficDirection = 'both' | 'tx' | 'rx';

/** 服务端 /api/settings/public 的形态。对所有人开放，含匿名访客。 */
export interface PublicSettings {
  panelName: string;
  panelTagline: string;
  displayCurrency: Currency;
  costIncludeExpired: boolean;
  byteBase: 1024 | 1000;
  binaryUnitLabels: boolean;
  trafficDirection: TrafficDirection;
  timezone: string;
  expiryWarnDays: number;
  quotaWarnPercent: number;
  /** 1 USD = N，每个支持的币种都有值 */
  rates: Partial<Record<Currency, number>>;
  ratesMeta: {
    fetchedAt: number;
    source: string;
    /** 一次都没拉到过，用的是内置参考值 */
    usingFallback: boolean;
    /** 拉到过但已经超过一天没更新 */
    stale: boolean;
  };
}

/**
 * 兜底值必须和服务端的 DEFAULT_SETTINGS 对得上。
 *
 * 它只在"页面刚打开、请求还没回来、也没有本地缓存"那一小段里生效。
 * 对不上的后果是首帧按一套口径渲染、下一帧按另一套 —— 正是缓存想避免的那种闪。
 */
const FALLBACK: PublicSettings = {
  panelName: 'Sonar',
  panelTagline: '服务器探针',
  displayCurrency: 'USD',
  costIncludeExpired: false,
  byteBase: 1024,
  binaryUnitLabels: false,
  trafficDirection: 'both',
  timezone: 'UTC',
  expiryWarnDays: 7,
  quotaWarnPercent: 80,
  rates: {},
  ratesMeta: { fetchedAt: 0, source: '', usingFallback: true, stale: false },
};

const CACHE_KEY = 'sonar-settings';

class SettingsStore {
  private listeners = new Set<() => void>();
  private snapshot: PublicSettings = FALLBACK;

  constructor() {
    this.restore();
    // 不等任何组件挂载就发请求：设置越早到位，页面重排的机会越少
    void this.load();
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      // 缓存可能是旧版本写的，字段不全 —— 用 FALLBACK 铺底再覆盖
      this.snapshot = { ...FALLBACK, ...(JSON.parse(raw) as Partial<PublicSettings>) };
      this.push();
    } catch {
      // 隐私模式或数据损坏，当作没有缓存
    }
  }

  /** 把展示口径推给 format.ts。设置一旦变化，必须先推这个再通知组件重渲染。 */
  private push(): void {
    applyDisplaySettings({
      byteBase: this.snapshot.byteBase,
      binaryUnitLabels: this.snapshot.binaryUnitLabels,
      timezone: this.snapshot.timezone,
      expiryWarnDays: this.snapshot.expiryWarnDays,
      quotaWarnPercent: this.snapshot.quotaWarnPercent,
    });
  }

  async load(): Promise<void> {
    try {
      const res = await fetch('/api/settings/public', { credentials: 'include' });
      if (!res.ok) return;
      this.apply((await res.json()) as PublicSettings);
    } catch {
      // 设置拉不到就继续用缓存或兜底值。为一份展示口径挡住整个页面不值得
    }
  }

  apply(next: PublicSettings): void {
    this.snapshot = { ...FALLBACK, ...next };
    this.push();
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(this.snapshot));
    } catch {
      // 配额满了就算了，缓存只是优化
    }
    for (const fn of this.listeners) fn();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): PublicSettings => this.snapshot;
}

const store = new SettingsStore();

export function useSettings(): PublicSettings {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** 非组件代码里读一次当前设置。 */
export function currentSettings(): PublicSettings {
  return store.getSnapshot();
}

/**
 * 服务端推来新设置时调用。
 *
 * 口径是全局的：管理员把进制从 1024 改成 1000，另一个正开着页面的人
 * 必须跟着一起变，否则两个人对着同一台机器会读出差 10% 的数字，
 * 而谁都不知道对方看到的是什么。
 */
export function applyPushedSettings(next: PublicSettings): void {
  store.apply(next);
}

/** 设置页保存后拉一次最新的公开口径。 */
export function reloadSettings(): Promise<void> {
  return store.load();
}

const DIRECTION_LABEL: Record<TrafficDirection, string> = {
  both: '双向合计',
  tx: '仅出站',
  rx: '仅入站',
};

export function trafficDirectionLabel(d: TrafficDirection): string {
  return DIRECTION_LABEL[d] ?? DIRECTION_LABEL.both;
}
