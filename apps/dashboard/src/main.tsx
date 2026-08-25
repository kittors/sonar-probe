import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import './styles/theme.css';
import { Shell } from './components/Shell';
import { Overview } from './pages/Overview';
import { NodeDetail } from './pages/NodeDetail';
import { Admin } from './pages/Admin';
import { Profile } from './pages/Profile';
import { SshAccess } from './pages/SshAccess';
import { AuthProvider, useAuth } from './lib/auth';
import { EmptyState } from './components/ui';
import { IconShield } from './components/icons';

/**
 * 登录守卫。
 *
 * 只包详情页和管理页。未登录时**就地**提示，不跳转到独立登录页 ——
 * 登录入口一直在右上角，跳走反而让人失去上下文。
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const { pathname } = useLocation();

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '40vh' }}>
        <div className="ds-skeleton" style={{ width: 200, height: 10 }} />
      </div>
    );
  }

  /*
   * 还没改初始密码的人，先去改密码。
   *
   * 服务端已经把所有带权限的接口挡住了（requireCap 里那一段），前端不跟着跳的话，
   * 人看到的是一个每个模块都在报 403 的页面 —— 症状离原因很远，
   * 而原因其实只有一句话："你还没改密码"。
   *
   * 必须排除 /settings 本身，否则改密码那一页也会把自己重定向到自己。
   */
  if (me?.mustChangePassword && pathname !== '/settings') {
    return <Navigate to="/settings" replace />;
  }

  if (!me) {
    return (
      <div className="ds-surface">
        <EmptyState
          icon={<IconShield size={30} />}
          title="这一页需要先登录"
          hint="点右上角的「登录」，用账号密码、GitHub 或访客身份进入都可以。概览页不需要登录。"
        />
      </div>
    );
  }

  return <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Shell>
          <Routes>
            {/* 概览对所有人开放，数据按身份脱敏 */}
            <Route path="/" element={<Overview />} />
            <Route
              path="/node/:id"
              element={
                <RequireAuth>
                  <NodeDetail />
                </RequireAuth>
              }
            />
            <Route
              path="/ssh"
              element={
                <RequireAuth>
                  <SshAccess />
                </RequireAuth>
              }
            />
            <Route
              path="/settings"
              element={
                <RequireAuth>
                  <Profile />
                </RequireAuth>
              }
            />
            <Route
              path="/admin"
              element={
                <RequireAuth>
                  <Admin />
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
