import { RouterProvider, createBrowserRouter } from 'react-router-dom';

import { AuthProvider } from '@/auth/AuthContext';
import { AppShell } from '@/components/AppShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/Toast';
import { ROUTER_BASENAME } from '@/config';
import { GalleryPage } from '@/pages/GalleryPage';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ProjectPage } from '@/pages/ProjectPage';
import { UploadPage } from '@/pages/UploadPage';

/**
 * 路由表。每个页面外层包一层 ErrorBoundary，
 * 这样单个页面渲染异常不会导致整站白屏（头部/页脚仍可用）。
 */
const router = createBrowserRouter(
  [
    {
      path: '/',
      element: (
        <AppShell>
          <ErrorBoundary>
            <GalleryPage />
          </ErrorBoundary>
        </AppShell>
      ),
    },
    {
      path: '/upload',
      element: (
        <AppShell>
          <ErrorBoundary>
            <UploadPage />
          </ErrorBoundary>
        </AppShell>
      ),
    },
    {
      path: '/login',
      element: (
        <AppShell>
          <ErrorBoundary>
            <LoginPage />
          </ErrorBoundary>
        </AppShell>
      ),
    },
    {
      path: '/p/:id',
      element: (
        <AppShell>
          <ErrorBoundary>
            <ProjectPage />
          </ErrorBoundary>
        </AppShell>
      ),
    },
    {
      path: '*',
      element: (
        <AppShell>
          <ErrorBoundary>
            <NotFoundPage />
          </ErrorBoundary>
        </AppShell>
      ),
    },
  ],
  /**
   * 契约 §8.4：平台部署在 `https://7thcv.cn/psd/` 子路径下，
   * 此时 Vite 的 base 为 `/psd/`，`ROUTER_BASENAME` 为 `/psd`（已去尾斜杠）。
   * 不传 basename 的话路由会按站点根解析，子路径部署下所有链接都会 404。
   */
  { basename: ROUTER_BASENAME },
);

/** 应用根组件：全局 Toast + 登录态 Provider + 路由 */
export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ToastProvider>
  );
}
