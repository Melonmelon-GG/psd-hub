import { formatBytes } from '@/upload/fieldRules';
import type { UploadProgress as UploadProgressValue } from '@/upload/uploadProject';

/**
 * 上传进度条。
 * ratio 为 null 时（浏览器未给出总字节）退化为不确定进度条。
 */
export function UploadProgress({
  progress,
  fileName,
  onCancel,
  phase = 'uploading',
}: {
  progress: UploadProgressValue;
  fileName?: string;
  onCancel?: () => void;
  phase?: 'generating' | 'uploading';
}) {
  const ratio = progress.ratio;
  const indeterminate = ratio === null;
  const percent = ratio === null ? 0 : Math.round(ratio * 100);

  return (
    <div className="upload-progress" aria-live="polite">
      <div className="upload-progress__head">
        <span className="upload-progress__label">
          {phase === 'generating' ? '正在生成预览图…' : '正在上传…'}
          {fileName ? <span className="upload-progress__file"> {fileName}</span> : null}
        </span>
        <span className="upload-progress__percent">
          {indeterminate ? '' : `${percent}%`}
        </span>
      </div>

      <div
        className={`progress${indeterminate ? ' progress--indeterminate' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent}
        aria-label="上传进度"
      >
        <span
          className="progress__bar"
          style={indeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>

      <div className="upload-progress__foot">
        <span className="upload-progress__bytes">
          {formatBytes(progress.loaded)}
          {progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ''}
        </span>

        {onCancel ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
            取消上传
          </button>
        ) : null}
      </div>
    </div>
  );
}
