import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ToastContext, useToastState, type ToastAction, type ToastItem } from '@/hooks/useToast';

/**
 * Toast Provider 与视图。
 * - 容器使用 aria-live="polite"，错误使用 role="alert" 便于屏幕阅读器播报。
 * - 带操作的 Toast 不自动关闭，用户需显式关闭。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const value = useToastState();
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={value.toasts} onDismiss={value.dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="toast-viewport" role="region" aria-label="通知">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/** 各语气的图标（内联 SVG，避免额外依赖） */
const TONE_ICON: Record<ToastItem['tone'], ReactNode> = {
  success: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm4.03 6.28-4.6 5.2a.9.9 0 0 1-1.33.04L5.9 10.7a.9.9 0 1 1 1.3-1.24l1.53 1.6 3.95-4.47a.9.9 0 1 1 1.35 1.19Z"
        fill="currentColor"
      />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm0 3.6a.9.9 0 0 1 .9.9v5a.9.9 0 0 1-1.8 0v-5a.9.9 0 0 1 .9-.9Zm0 8.2a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z"
        fill="currentColor"
      />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M9.13 2.4 1.6 15.5A1.8 1.8 0 0 0 3.16 18.2h13.68a1.8 1.8 0 0 0 1.56-2.7L10.87 2.4a1 1 0 0 0-1.74 0ZM10 6.5a.9.9 0 0 1 .9.9v3.6a.9.9 0 0 1-1.8 0V7.4a.9.9 0 0 1 .9-.9Zm0 6.6a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1Z"
        fill="currentColor"
      />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm0 3.2a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Zm1 10.3H9a.9.9 0 0 1 0-1.8h.1V9.4H9a.9.9 0 0 1 0-1.8h1.1a.9.9 0 0 1 .9.9v5.5a.9.9 0 0 1 0 1.8Z"
        fill="currentColor"
      />
    </svg>
  ),
};

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const [actionPending, setActionPending] = useState(false);
  const actionRef = useRef<HTMLButtonElement>(null);

  // 带操作且不自动关闭时，把焦点移到操作按钮，方便键盘用户立即处理
  useEffect(() => {
    if (toast.action && toast.duration === 0) actionRef.current?.focus();
  }, [toast.action, toast.duration]);

  const runAction = async (action: ToastAction) => {
    if (actionPending) return;
    try {
      setActionPending(true);
      await action.onClick();
    } catch (error) {
      console.warn('Toast 操作执行失败', error);
    } finally {
      setActionPending(false);
    }
  };

  return (
    <div
      className={`toast toast--${toast.tone}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
    >
      <span className="toast__icon" aria-hidden="true">
        {TONE_ICON[toast.tone]}
      </span>

      <p className="toast__message">{toast.message}</p>

      <div className="toast__actions">
        {toast.action ? (
          <button
            ref={actionRef}
            type="button"
            className={`btn btn--sm toast__action toast__action--${toast.action.variant ?? 'primary'}`}
            onClick={() => void runAction(toast.action as ToastAction)}
            disabled={actionPending}
          >
            {actionPending ? '处理中…' : toast.action.label}
          </button>
        ) : null}

        <button
          type="button"
          className="toast__close"
          aria-label="关闭通知"
          onClick={() => onDismiss(toast.id)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M4.2 4.2a.75.75 0 0 1 1.06 0L8 6.94l2.74-2.74a.75.75 0 1 1 1.06 1.06L9.06 8l2.74 2.74a.75.75 0 1 1-1.06 1.06L8 9.06l-2.74 2.74a.75.75 0 0 1-1.06-1.06L6.94 8 4.2 5.26a.75.75 0 0 1 0-1.06Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
