import { useEffect, useRef, type ReactNode } from 'react';

/**
 * 确认对话框：自绘模态（便于完全掌控样式与焦点管理）。
 * - Esc 关闭
 * - 打开时把焦点移到取消按钮（破坏性操作默认聚焦"取消"，避免误触）
 * - Tab / Shift+Tab 在对话框内循环（焦点陷阱）
 * - 关闭后焦点归还到触发元素
 * - 遮罩层点击可关闭（可通过 dismissOnBackdrop 关闭该行为）
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // 记住触发元素，关闭后归还焦点
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      // 等 DOM 就绪再聚焦
      const timer = setTimeout(() => cancelRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
    previouslyFocused.current?.focus?.();
    return undefined;
  }, [open]);

  // Esc 关闭 + Tab 焦点陷阱
  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busy) onCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      const container = dialogRef.current;
      if (!container) return;

      const focusables = container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, busy, onCancel]);

  // 打开时锁定页面滚动
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={description ? 'confirm-dialog-description' : undefined}
      >
        <h2 id="confirm-dialog-title" className="modal__title">
          {title}
        </h2>

        {description ? (
          <p id="confirm-dialog-description" className="modal__text">
            {description}
          </p>
        ) : null}

        {children ? <div className="modal__content">{children}</div> : null}

        <div className="modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--secondary"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn btn--${tone === 'danger' ? 'danger' : 'primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
