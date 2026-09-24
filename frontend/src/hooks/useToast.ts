import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

/**
 * Toast 的上下文、类型与状态逻辑。
 * 视图部分（Provider 组件与列表渲染）在 components/Toast.tsx。
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

/** Toast 上的可选操作按钮（例如 409 重复时的"查看已有工程""仍然上传"） */
export interface ToastAction {
  label: string;
  /** 点击后的行为；返回 Promise 时按钮进入 loading 态 */
  onClick: () => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'danger';
}

export interface ToastOptions {
  tone?: ToastTone;
  /** 毫秒；0 表示不自动关闭（用于需要用户决策的场景） */
  duration?: number;
  action?: ToastAction;
  /** 允许同一时刻出现多条相同文案 */
  allowDuplicate?: boolean;
}

export interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
  duration: number;
  allowDuplicate: boolean;
  action?: ToastAction;
}

export interface ToastContextValue {
  toasts: ToastItem[];
  /** 通用推送，返回 id 便于后续 dismiss */
  push: (message: string, options?: ToastOptions) => string;
  success: (message: string, options?: Omit<ToastOptions, 'tone'>) => string;
  error: (message: string, options?: Omit<ToastOptions, 'tone'>) => string;
  warning: (message: string, options?: Omit<ToastOptions, 'tone'>) => string;
  info: (message: string, options?: Omit<ToastOptions, 'tone'>) => string;
  dismiss: (id: string) => void;
  /** 清空全部 */
  clear: () => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

/** 消费 Toast：必须在 ToastProvider 内使用 */
export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error('useToast 必须在 <ToastProvider> 内部使用');
  }
  return value;
}

/** 最多同时展示的 Toast 数量 */
const MAX_TOASTS = 4;

/** 供 Provider 使用的状态实现 */
export function useToastState(): ToastContextValue {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message: string, options: ToastOptions = {}): string => {
      const { tone = 'info', duration, action, allowDuplicate = false } = options;
      counter.current += 1;
      const id = `toast-${counter.current}`;

      // 需要用户决策的（带操作）默认不自动关闭，避免错过；错误停留更久
      const effectiveDuration = duration ?? (action ? 0 : tone === 'error' ? 7000 : 4000);

      setToasts((prev) => {
        const deduped = allowDuplicate
          ? prev
          : prev.filter((toast) => toast.message !== message);
        return [
          ...deduped,
          { id, message, tone, duration: effectiveDuration, allowDuplicate, action },
        ].slice(-MAX_TOASTS);
      });

      if (effectiveDuration > 0) {
        const timer = setTimeout(() => dismiss(id), effectiveDuration);
        timers.current.set(id, timer);
      }

      return id;
    },
    [dismiss],
  );

  const clear = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setToasts([]);
  }, []);

  return useMemo<ToastContextValue>(
    () => ({
      toasts,
      push,
      dismiss,
      clear,
      success: (message, options) => push(message, { ...options, tone: 'success' }),
      error: (message, options) => push(message, { ...options, tone: 'error' }),
      warning: (message, options) => push(message, { ...options, tone: 'warning' }),
      info: (message, options) => push(message, { ...options, tone: 'info' }),
    }),
    [toasts, push, dismiss, clear],
  );
}
