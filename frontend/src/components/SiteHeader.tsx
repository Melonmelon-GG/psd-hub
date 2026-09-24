import { Link, NavLink } from 'react-router-dom';

import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/hooks/useToast';

/**
 * 品牌名分两行展示：
 *   上一行「柒世纪视频组」字号较大
 *   下一行「平面工程分享平台」字号较小
 * 且两行**左右边缘对齐**（等宽）。
 *
 * 实现方式：把每个字拆成独立的 flex item，用 `justify-content: space-between`
 * 把该行撑满容器宽度。容器宽度取 `max-content`，即由「较宽的那一行」自然宽度决定，
 * 另一行则被撑开补齐 —— 这样两行的左边缘与右边缘都会严格对齐。
 *
 * 为什么不用 `text-align: justify`：它对「单行 + 强制换行」的文本在浏览器里不可靠
 * （最后一行永远不对齐），而 flex 的做法在所有浏览器上都是确定的。
 */
const BRAND_PRIMARY = '柒世纪视频组';
const BRAND_SECONDARY = '平面工程分享平台';
const BRAND_FULL = `${BRAND_PRIMARY}${BRAND_SECONDARY}`;

/** 逐字拆成独立元素，交给 flex 的 space-between 撑出两端对齐 */
function BrandLine({ text, variant }: { text: string; variant: 'primary' | 'secondary' }) {
  return (
    <span className={`site-header__title-line site-header__title-line--${variant}`}>
      {Array.from(text).map((char, index) => (
        // 字符可能重复（「平」出现两次），所以 key 用「字符 + 下标」；列表是静态的，无重排问题
        <span key={`${char}-${index}`}>{char}</span>
      ))}
    </span>
  );
}

/** 顶部导航：站点标识 + 主导航 + 上传入口 + 登录态 */
export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <NavLink to="/" className="site-header__brand" aria-label={`${BRAND_FULL} 首页`}>
          <span className="site-header__logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" focusable="false">
              <rect width="32" height="32" rx="8" fill="url(#brandGradient)" />
              <path d="M9 23V9h5.6a4.2 4.2 0 0 1 0 8.4h-2.8V23z" fill="#fff" />
              <rect x="18" y="9" width="5" height="14" rx="1.6" fill="#fff" opacity="0.6" />
              <defs>
                <linearGradient id="brandGradient" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#5b8cff" />
                  <stop offset="1" stopColor="#8f5bff" />
                </linearGradient>
              </defs>
            </svg>
          </span>
          {/* 品牌名已由外层 aria-label 提供给读屏器；这里隐藏，避免被逐字念成 14 个字符 */}
          <span className="site-header__title" aria-hidden="true">
            <BrandLine text={BRAND_PRIMARY} variant="primary" />
            <BrandLine text={BRAND_SECONDARY} variant="secondary" />
          </span>
        </NavLink>

        <nav className="site-header__nav" aria-label="主导航">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `site-header__link${isActive ? ' is-active' : ''}`}
          >
            全部工程
          </NavLink>
          <NavLink
            to="/upload"
            className={({ isActive }) =>
              `btn btn--primary btn--sm site-header__upload${isActive ? ' is-active' : ''}`
            }
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path
                d="M8 2.5a.9.9 0 0 1 .9.9v3.7h3.7a.9.9 0 0 1 0 1.8H8.9v3.7a.9.9 0 0 1-1.8 0V8.9H3.4a.9.9 0 0 1 0-1.8h3.7V3.4A.9.9 0 0 1 8 2.5Z"
                fill="currentColor"
              />
            </svg>
            上传工程
          </NavLink>

          <AuthArea />
        </nav>
      </div>
    </header>
  );
}

/**
 * 登录态区域（契约 §8）：
 * - 未登录 → 「登录」链接
 * - 已登录 → 用户名 + 「退出」按钮（退出只清本地，令牌是无状态 JWT，服务端没有 logout 端点）
 * - loading → 什么都不渲染，避免刷新页面时用户名/登录链接来回闪
 *
 * 放在 `.site-header__nav` 内部靠右，保持既有布局；品牌区的两行文字结构完全不动。
 */
function AuthArea() {
  const { status, user, logout } = useAuth();
  const toast = useToast();

  if (status === 'loading') return null;

  if (status !== 'authenticated' || !user) {
    return (
      <Link to="/login" className="site-header__link site-header__login">
        登录
      </Link>
    );
  }

  return (
    <span className="site-header__auth">
      <span className="site-header__user" title={`已登录：${user.cn}`}>
        {user.cn}
      </span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => {
          logout();
          toast.info('已退出登录');
        }}
      >
        退出
      </button>
    </span>
  );
}
