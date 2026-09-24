import type { ReactNode } from 'react';

import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';

/** 页面骨架：头部导航 + 主内容区 + 页脚 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <SiteHeader />
      <main id="main" className="app-shell__main">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
