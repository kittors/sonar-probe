import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Capability, Role } from './permissions';
import { clearLiveCache } from './live';

/**
 * 认证状态
 *
 * 权限以服务端返回的 capabilities 为准，前端不自己推导 —— 角色到能力的映射
 * 只有一份，在服务端。前端拿到的是算好的结果。
 */

export interface Me {
  id: string;
  /** user 是正式账号（可能有密码、GitHub 或两者），guest 是临时访客 */
  kind: 'user' | 'guest';
  username: string;
  login: string;
  name: string;
  avatar: string;
  email: string;
  role: Role;
  roleLabel: string;
  createdAt: number;
  lastSeen: number;
  note: string;
  disabled: boolean;
  /** 超级管理员：界面上要挡住降权、停用、删除三个操作 */
  isRoot: boolean;
  /** 用初始密码登录后，改掉之前挡在改密页 */
  mustChangePassword: boolean;
}

export interface IdentityInfo {
  provider: 'password' | 'github';
  label: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface AuthConfig {
  github: boolean;
  /** 关掉之后，没绑过 GitHub 的账号不能用它登录 */
  githubSignup: boolean;
  password: boolean;
  needsBootstrap: boolean;
  guestEnabled: boolean;
}

interface AuthValue {
  me: Me | null;
  caps: Set<Capability>;
  identities: IdentityInfo[];
  config: AuthConfig | null;
  loading: boolean;
  /** 有没有这项能力。没登录时恒为 false */
  can: (cap: Capability) => boolean;
  loginWithPassword: (username: string, password: string) => Promise<void>;
  loginAsGuest: (label?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [caps, setCaps] = useState<Set<Capability>>(new Set());
  const [identities, setIdentities] = useState<IdentityInfo[]>([]);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [meRes, cfgRes] = await Promise.all([
        fetch('/api/me', { credentials: 'include' }),
        fetch('/api/auth/config', { credentials: 'include' }),
      ]);

      setConfig(cfgRes.ok ? await cfgRes.json() : null);

      // /api/me 对未登录也返回 200，只是 user 为 null。
      // 匿名同样带着一份 capabilities（概览页要靠它决定显示到哪一层），
      // 所以这里不能因为没有 user 就把权限清空。
      if (meRes.ok) {
        const data = (await meRes.json()) as {
          user: Me | null;
          capabilities: Capability[];
          identities: IdentityInfo[];
        };
        setMe(data.user);
        setCaps(new Set(data.capabilities));
        setIdentities(data.identities ?? []);
      } else {
        setMe(null);
        setCaps(new Set());
        setIdentities([]);
      }
    } catch {
      setMe(null);
      setCaps(new Set());
      setIdentities([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /*
   * 服务端在权限变更时推 auth-refresh。
   *
   * 没有这条的话，管理员改完某人的角色，那个人手里的按钮要等到他自己刷新
   * 才对得上 —— 被收走的能力点了才发现 403，新给的能力则完全看不见。
   * 权限是服务端说了算的东西，它变了就该由服务端来告诉前端。
   */
  useEffect(() => {
    const onAuthChanged = () => void refresh();
    window.addEventListener('sonar:auth-refresh', onAuthChanged);
    return () => window.removeEventListener('sonar:auth-refresh', onAuthChanged);
  }, [refresh]);

  const loginWithPassword = useCallback(
    async (username: string, password: string) => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: '登录失败' }));
        throw new Error(body.error ?? '登录失败');
      }
      // 换人登录了，上一个人的机器列表缓存（含 IP）不能留给他看
      clearLiveCache();
      await refresh();
    },
    [refresh],
  );

  const loginAsGuest = useCallback(
    async (label?: string) => {
      const res = await fetch('/api/auth/guest', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: '访客登录失败' }));
        throw new Error(body.error ?? '访客登录失败');
      }
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setMe(null);
    setCaps(new Set());
    // 机器列表缓存里有 IP 这类信息，换人登录不该看得到上一个人的
    clearLiveCache();
    // 整页刷新，顺带把 WebSocket 和所有缓存状态清干净。
    // 回概览页而不是登录页 —— 退出后还能继续看公开的状态，不必被堵在门口
    location.href = '/';
  }, []);

  const can = useCallback((cap: Capability) => caps.has(cap), [caps]);

  const value = useMemo<AuthValue>(
    () => ({
      me, caps, identities, config, loading, can,
      loginWithPassword, loginAsGuest, logout, refresh,
    }),
    [me, caps, identities, config, loading, can, loginWithPassword, loginAsGuest, logout, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return v;
}

/**
 * 按能力显示内容。
 *
 * 这只是"不碍眼"，不是安全边界 —— 真正拦住越权的是服务端的 requireCap。
 * 所以这里可以放心用，但绝不能把它当成唯一的防线。
 */
export function Can({
  cap,
  children,
  fallback = null,
}: {
  cap: Capability;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = useAuth();
  return <>{can(cap) ? children : fallback}</>;
}
