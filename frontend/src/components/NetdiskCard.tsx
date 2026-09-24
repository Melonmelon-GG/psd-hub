import { useToast } from '@/hooks/useToast';
import { providerColorStyle, providerStyle } from '@/netdisk/providers';
import type { NetdiskSource } from '@/types';

/**
 * 网盘卡片（v2.0 的核心信息块）：
 * 网盘图标 + 中文名 + 「前往网盘下载」跳转按钮 + 提取码（一键复制）+ 源文件名 / 备注。
 *
 * 两个必须遵守的契约约束（docs/API.md §3.10 / §5）：
 * 1. 「前往网盘下载」**必须是普通链接**，href 指向 `/api/projects/<id>/go`，
 *    不能用 fetch —— 该端点是 302 跳转，fetch 只会把网盘页面当数据读回来，
 *    浏览器不会跳转，服务端的下载计数也就失去意义。
 * 2. 展示用的 `providerLabel` / `provider` **一律以服务端返回为准**，
 *    本地 `detectProvider()` 只服务于上传表单的即时提示。
 */
export function NetdiskCard({
  source,
  goUrl,
}: {
  source: NetdiskSource;
  /** 契约 §3.10 的跳转地址，由 buildNetdiskGoUrl(project.id) 生成 */
  goUrl: string;
}) {
  const toast = useToast();
  const style = providerStyle(source.provider);
  const extractCode = source.extractCode?.trim() ?? '';

  const handleCopyCode = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(extractCode);
        toast.success('提取码已复制到剪贴板');
        return;
      }
      throw new Error('clipboard unavailable');
    } catch {
      // 降级：浏览器不允许自动复制时，把提取码写在提示里让用户手动选中
      toast.warning(`当前浏览器不允许自动复制，请手动复制提取码：${extractCode}`, {
        duration: 0,
      });
    }
  };

  return (
    <section className="netdisk-card" aria-label="网盘下载信息">
      <div className="netdisk-card__head">
        <span
          className={`netdisk-badge netdisk-badge--lg netdisk-badge--${source.provider}`}
          style={providerColorStyle(source.provider)}
          aria-hidden="true"
        >
          {style.icon}
        </span>
        <div className="netdisk-card__titles">
          <h2 className="netdisk-card__title">网盘下载</h2>
          <p className="netdisk-card__provider">{source.providerLabel}</p>
        </div>
      </div>

      {/* 契约 §5：用普通 <a> 触发 302 跳转，不要用 fetch */}
      <a
        className="btn btn--primary btn--block netdisk-card__go"
        href={goUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="M8 2.6a.9.9 0 0 1 .9.9v5.2l1.8-1.8a.9.9 0 1 1 1.27 1.27l-3.34 3.34a.9.9 0 0 1-1.27 0L4.03 8.17A.9.9 0 0 1 5.3 6.9l1.8 1.8V3.5a.9.9 0 0 1 .9-.9Z"
            fill="currentColor"
          />
          <path d="M3.4 12.1a.9.9 0 0 1 .9.9v.2h7.4v-.2a.9.9 0 0 1 1.8 0v.5a1.6 1.6 0 0 1-1.6 1.6H4.1a1.6 1.6 0 0 1-1.6-1.6v-.5a.9.9 0 0 1 .9-.9Z" fill="currentColor" />
        </svg>
        前往网盘下载
      </a>

      <p className="netdisk-card__hint">将跳转到 {source.providerLabel}，下载次数会在跳转时 +1。</p>

      <dl className="netdisk-card__meta">
        <div className="netdisk-card__row">
          <dt>分享链接</dt>
          <dd className="netdisk-card__url" title={source.url}>
            {source.url}
          </dd>
        </div>

        {extractCode ? (
          <div className="netdisk-card__row">
            <dt>提取码</dt>
            <dd className="netdisk-card__code">
              <code className="netdisk-card__code-value">{extractCode}</code>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void handleCopyCode()}
                aria-label="复制提取码"
              >
                复制
              </button>
            </dd>
          </div>
        ) : null}

        {source.fileName ? (
          <div className="netdisk-card__row">
            <dt>源文件</dt>
            <dd className="netdisk-card__ellipsis" title={source.fileName}>
              {source.fileName}
            </dd>
          </div>
        ) : null}
      </dl>

      {source.note ? <p className="netdisk-card__note">{source.note}</p> : null}
    </section>
  );
}
