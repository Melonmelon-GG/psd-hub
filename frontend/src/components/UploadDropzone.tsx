import { useCallback, useRef, useState, type DragEvent } from 'react';

import { formatBytes } from '@/upload/fieldRules';

/**
 * 拖拽 / 点击选择的文件投放区（v2.0 只用于选择 PNG 展示图）。
 * - 支持键盘操作（Enter / Space 触发文件选择）
 * - 校验逻辑由调用方传入（扩展名、体积上限来自 GET /api/config）
 */
export function UploadDropzone({
  accept,
  file,
  onFile,
  error,
  disabled = false,
  title = '拖拽文件到此处',
  hint,
  inputId,
}: {
  accept: string;
  file: File | null;
  onFile: (file: File | null) => void;
  error?: string;
  disabled?: boolean;
  title?: string;
  hint?: string;
  inputId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave 会在子元素间反复触发，用计数器避免闪烁
  const dragDepth = useRef(0);

  const openPicker = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled) return;

    const dropped = event.dataTransfer.files?.[0];
    if (dropped) onFile(dropped);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    dragDepth.current += 1;
    setDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  return (
    <div className="dropzone-wrapper">
      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}${error ? ' has-error' : ''}${
          disabled ? ' is-disabled' : ''
        }${file ? ' has-file' : ''}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${title}，或点击选择文件`}
        aria-describedby={`${inputId}-hint`}
        aria-disabled={disabled}
        aria-invalid={Boolean(error)}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPicker();
          }
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
      >
        <input
          ref={inputRef}
          id={inputId}
          className="dropzone__input"
          type="file"
          accept={accept}
          disabled={disabled}
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            onFile(selected);
            // 允许重复选择同一个文件
            event.target.value = '';
          }}
        />

        {file ? (
          <div className="dropzone__file">
            <span className="dropzone__file-icon" aria-hidden="true">
              <svg viewBox="0 0 40 40" focusable="false">
                <path
                  d="M11 4h11.5L31 12.5V34a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                <path d="M22 4v9h9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              </svg>
            </span>

            <div className="dropzone__file-meta">
              <p className="dropzone__file-name" title={file.name}>
                {file.name}
              </p>
              <p className="dropzone__file-size">{formatBytes(file.size)}</p>
            </div>

            <button
              type="button"
              className="btn btn--ghost btn--sm dropzone__clear"
              onClick={(event) => {
                event.stopPropagation();
                onFile(null);
              }}
            >
              重新选择
            </button>
          </div>
        ) : (
          <div className="dropzone__prompt">
            <span className="dropzone__icon" aria-hidden="true">
              <svg viewBox="0 0 48 48" focusable="false">
                <path
                  d="M24 32V14m0 0-6.5 6.5M24 14l6.5 6.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M14 32v3a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <p className="dropzone__title">{title}</p>
            <p className="dropzone__subtitle">或点击选择文件</p>
          </div>
        )}
      </div>

      <p id={`${inputId}-hint`} className={`field__hint${error ? ' field__hint--error' : ''}`}>
        {error ?? hint}
      </p>
    </div>
  );
}
