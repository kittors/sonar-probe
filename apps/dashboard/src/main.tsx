import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import './styles/theme.css';
import { Shell } from './components/Shell';
import { Overview } from './pages/Overview';
import { NodeDetail } from './pages/NodeDetail';
import { Admin } from './pages/Admin';
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

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '40vh' }}>
        <div className="ds-skeleton" style={{ width: 200, height: 10 }} />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="ds-surface">
        <EmptyState
          icon={<IconShield size={30} />}
          title="这一页需要先登录"
          hint="点右上角的「登录」，用 GitHub 或以访客身份进入都可以。概览页不需要登录。"
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
