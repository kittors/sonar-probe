import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BlockRule, EventLog, NodeState, ServerMessage } from './types';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'down';

const CACHE_KEY = 'sonar-nodes-cache';
/** 缓存只用来填刷新时的空窗，超过 10 分钟的就没有参考价值了 */
const CACHE_TTL_MS = 10 * 60_000;

/** 退出登录时清掉：换个人登录不该看见上一个人的机器列表 */
export function clearLiveCache(): void {
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    /* 存储不可用就无所谓了 */
  }
}

/**
 * 实时数据源
 *
 * 做成模块级单例而不是 React Context：概览页和详情页都要用同一份流，
 * 用单例可以在两个页面之间切换时保持连接不断，不用每次进详情页重连一次。
 */
class LiveStore {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private retry = 0;
  private timer: number | null = null;
  private closed = false;

  nodes: NodeState[] = [];
  events: EventLog[] = [];
  conn: ConnState = 'connecting';
  lastTick = 0;
  /**
   * 是否已经有可渲染的数据（收到过 snapshot，或从缓存里恢复了一份）。
   *
   * 少了这个标志就分不清"还在连"和"这台机器不存在"—— 两者的 nodes 里都找不到
   * 目标 id，但前者该显示骨架，后者该说明机器已被移除。
   */
  ready = false;

  private snapshot = {
    nodes: this.nodes,
    events: this.events,
    conn: this.conn,
    lastTick: this.lastTick,
    ready: this.ready,
  };

  constructor() {
    this.restore();
  }

  /*
   * 从会话缓存里恢复上一次的机器列表。
   *
   * 刷新页面时 WebSocket 要重新握手，这段空窗期里 nodes 是空的，整个详情页会被
   * "正在加载"顶掉，看起来就是整页闪一下。先拿上次的数据垫上，等真数据到了
   * 无缝替换，视觉上就没有断层了。
   *
   * 用 sessionStorage 不用 localStorage：这份数据含机器 IP，只应该活在当前标签页里，
   * 关掉就没了。退出登录时还会显式清掉（见 clearLiveCache）。
   */
  private restore(): void {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as { at: number; nodes: NodeState[] };
      // 过期的缓存宁可不要 —— 拿半小时前的负载当现状看比空白更误导
      if (!cached?.nodes?.length || Date.now() - cached.at > CACHE_TTL_MS) {
        sessionStorage.removeItem(CACHE_KEY);
        return;
      }
      this.nodes = cached.nodes;
      this.ready = true;
    } catch {
      // 存储被禁用（隐私模式）或数据损坏，当作没有缓存
    }
  }

  private persist(): void {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), nodes: this.nodes }));
    } catch {
      // 配额满了就算了，缓存只是优化
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.connect();
    return () => {
      this.listeners.delete(fn);
      // 不在这里断开：页面间切换会短暂降到 0 个订阅者，
      // 断了再连会让详情页首屏闪一下空状态。
    };
  };

  getSnapshot = () => this.snapshot;

  private emit(): void {
    this.snapshot = {
      nodes: this.nodes,
      events: this.events,
      conn: this.conn,
      lastTick: this.lastTick,
      ready: this.ready,
    };
    for (const fn of this.listeners) fn();
  }

  private connect(): void {
    if (this.closed) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.conn = 'live';
      this.emit();
      this.startHeartbeat();
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'snapshot':
        case 'tick':
          this.nodes = msg.nodes;
          this.lastTick = msg.ts;
          this.ready = true;
          this.persist();
          break;
        case 'event':
          this.events = [msg.event, ...this.events].slice(0, 80);
          break;
        case 'block':
          this.onBlock?.(msg.rule);
          break;
      }
      this.emit();
    };

    ws.onclose = (ev) => {
      this.stopHeartbeat();
      if (this.closed) return;
      // 4401 = 服务端说会话无效。重连多少次都没用，直接回登录页
      if (ev.code === 4401) {
        this.conn = 'down';
        this.emit();
        location.href = `/login?redirect=${encodeURIComponent(location.pathname)}`;
        return;
      }
      this.conn = this.retry === 0 ? 'reconnecting' : this.retry > 6 ? 'down' : 'reconnecting';
      this.emit();
      this.scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  }

  private heartbeat: number | null = null;

  /**
   * 心跳。
   *
   * 两个作用：刷新会话活跃时间（管理员的"此刻在线"靠它），以及上报当前在看哪一页。
   * 30 秒一次，服务端判定在线的窗口是 90 秒，留了三倍余量扛网络抖动。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const ping = () => {
      if (this.ws?.readyState !== 1) return;
      this.ws.send(JSON.stringify({ type: 'ping', view: currentView() }));
    };
    ping();
    this.heartbeat = window.setInterval(ping, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** 指数退避，上限 15 秒 —— 后端重启时不要把它打爆。 */
  private scheduleReconnect(): void {
    if (this.timer !== null) return;
    const delay = Math.min(15_000, 600 * 2 ** this.retry);
    this.retry++;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  onBlock: ((rule: BlockRule) => void) | null = null;

  seedEvents(events: EventLog[]): void {
    if (this.events.length === 0) {
      this.events = events;
      this.emit();
    }
  }
}

/** 把当前 URL 翻译成审计里好读的页面标识。 */
function currentView(): string {
  const p = location.pathname;
  if (p === '/') return 'overview';
  if (p.startsWith('/node/')) return `node:${p.slice(6)}`;
  if (p.startsWith('/admin')) return 'admin';
  return p;
}

const store = new LiveStore();

export function useLive() {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function seedEvents(events: EventLog[]): void {
  store.seedEvents(events);
}

/**
 * 取单台机器。
 *
 * 一并返回 ready：调用方要用它区分"还在加载"和"这台机器不存在"，
 * 只看 node 是不是 null 是分不出来的。
 */
export function useLiveNode(id: string | undefined): { node: NodeState | null; ready: boolean } {
  const { nodes, ready } = useLive();
  if (!id) return { node: null, ready };
  return { node: nodes.find((n) => n.id === id) ?? null, ready };
}

/** 通用异步取数，带竞态保护和手动刷新。 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef
      .current()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

// 主题管理已挪到 lib/theme.ts —— 它需要绕开 React 的渲染时机来防首帧闪烁。
