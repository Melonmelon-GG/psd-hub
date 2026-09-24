import type { ReactNode } from 'react';

import { ApiError } from '@/api/client';

/**
 * 可重试的错误状态。
 * 网络错误 / 后端未启动（NETWORK_ERROR）时给出更具体的排查提示。
 */
export function ErrorState({
  error,
  onRetry,
  title = '加载失败',
  retrying = false,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  retrying?: boolean;
}) {
  const { message, hint } = describeError(error);

  return (
    <div className="error-state" role="alert">
      <div className="error-state__icon" aria-hidden="true">
        <svg viewBox="0 0 48 48" focusable="false">
          <circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M24 14v13" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="24" cy="33" r="2" fill="currentColor" />
        </svg>
      </div>

      <h3 className="error-state__title">{title}</h3>
      <p className="error-state__message">{message}</p>
      {hint ? <p className="error-state__hint">{hint}</p> : null}

      {onRetry ? (
        <button type="button" className="btn btn--primary" onClick={onRetry} disabled={retrying}>
          {retrying ? '重试中…' : '重试'}
        </button>
      ) : null}
    </div>
  );
}

/** 把任意错误转成「文案 + 排查提示」 */
export function describeError(error: unknown): { message: string; hint?: string } {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK_ERROR') {
      return {
        message: error.message,
        // 开发态提示具体代理目标（Vite 把 /api 转到 4000），生产态只提示检查服务与网络，
        // 避免把 127.0.0.1:4000 这种本机地址暴露给线上用户造成误导。
        hint: import.meta.env.DEV
          ? '请确认后端服务已在 http://127.0.0.1:4000 启动；开发模式下 Vite 会把 /api 代理到该地址。'
          : '请检查网络连接后重试；若持续失败，可能是服务正在重启或维护中。',
      };
    }
    if (error.code === 'RATE_LIMITED') {
      const retryAfter = error.details?.retryAfter;
      return {
        message: error.message,
        hint: retryAfter ? `建议 ${String(retryAfter)} 秒后再试。` : '请稍后重试。',
      };
    }
    return { message: error.message };
  }

  if (error instanceof Error) return { message: error.message };
  return { message: '发生未知错误，请稍后重试。' };
}

/** 便捷包装：错误状态卡片 + 可选自定义内容 */
export function ErrorStateWithDetail({
  error,
  children,
}: {
  error: unknown;
  children?: ReactNode;
}) {
  const { message, hint } = describeError(error);
  return (
    <div className="error-state" role="alert">
      <p className="error-state__message">{message}</p>
      {hint ? <p className="error-state__hint">{hint}</p> : null}
      {children}
    </div>
  );
}
