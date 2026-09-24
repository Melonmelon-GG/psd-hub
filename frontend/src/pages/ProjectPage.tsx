import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ApiError } from '@/api/client';
import { buildImageDownloadUrl, buildImageUrl, buildNetdiskGoUrl, deleteProject, getProject } from '@/api/projects';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ErrorState } from '@/components/ErrorState';
import { NetdiskCard } from '@/components/NetdiskCard';
import { Skeleton } from '@/components/Spinner';
import { TagList } from '@/components/TagList';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useToast } from '@/hooks/useToast';
import { formatBytes } from '@/upload/fieldRules';
import { formatCount, formatDateTime, formatDimensions, previewAspectRatioStyle } from '@/utils/format';
import type { Project } from '@/types';

/**
 * 工程详情页（v2.0）。
 * 左：PNG 大图（按 `image.width / image.height` 的真实画布比例撑容器）
 * 右：标题、作者、时间、标签、说明、**网盘卡片**、图片信息、下载 PNG、复制链接、删除
 *
 * v2.0 已移除 PSD 预览 tab 与 PSD 元信息：
 * 浏览器端 PSD 解析模块与 `PsdViewer` / `PsdInfoPanel` 组件仍保留在仓库里，
 * 但不再被任何页面引用（契约附录 A）。
 */
export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [notFound, setNotFound] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [retryNonce, setRetryNonce] = useState(0);

  useDocumentTitle(project?.title ?? null);

  // 拉取详情（契约 §3.5，默认计一次浏览）
  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setNotFound(false);

    getProject(id, { signal: controller.signal })
      .then((item) => {
        setProject(item);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.code === 'NOT_FOUND') setNotFound(true);
        else setError(err);
        setLoading(false);
      });

    return () => controller.abort();
  }, [id, retryNonce]);

  const handleCopyLink = async () => {
    const link = window.location.href;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
        toast.success('链接已复制到剪贴板');
        return;
      }
      throw new Error('clipboard unavailable');
    } catch {
      // 降级：选中地址栏内容提示用户手动复制
      toast.warning('当前浏览器不允许自动复制，请手动复制地址栏链接');
    }
  };

  const handleDelete = async () => {
    if (!project) return;
    setDeleting(true);
    try {
      await deleteProject(project.id);
      toast.success('工程已删除');
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'UNAUTHORIZED') {
        toast.error('删除需要管理员令牌（x-admin-token），请由部署方在服务端配置或通过代理附加。');
      } else {
        toast.error(err instanceof Error ? err.message : '删除失败，请稍后重试');
      }
      setDeleting(false);
      setConfirmOpen(false);
    }
  };

  /* ------------------------------ 渲染 ------------------------------ */

  if (loading && !project) {
    return (
      <div className="page project-page project-page--loading">
        <Skeleton height="32px" width="40%" />
        <div className="project-page__layout">
          <Skeleton height="480px" radius="lg" />
          <div className="project-page__sidebar">
            <Skeleton height="24px" width="80%" />
            <Skeleton height="16px" width="60%" />
            <Skeleton height="120px" radius="md" />
          </div>
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="page project-page">
        <div className="notice notice--warning" role="status">
          <h1 className="notice__title">工程不存在或已被删除</h1>
          <p className="notice__text">该工程可能已被作者移除，或者链接有误。</p>
          <Link to="/" className="btn btn--primary">
            返回列表
          </Link>
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="page project-page">
        <ErrorState
          error={error}
          title="详情加载失败"
          retrying={loading}
          onRetry={() => setRetryNonce((value) => value + 1)}
        />
      </div>
    );
  }

  const { image, source } = project;

  return (
    <div className="page project-page">
      <nav className="breadcrumb" aria-label="面包屑">
        <Link to="/" className="breadcrumb__link">
          全部工程
        </Link>
        <span className="breadcrumb__sep" aria-hidden="true">
          /
        </span>
        <span className="breadcrumb__current">{project.title}</span>
      </nav>

      <div className="project-page__layout">
        {/* ---------------------------- 左侧：PNG 大图 ---------------------------- */}
        <section className="project-media" aria-label="展示图">
          <figure className="project-media__figure">
            {/* 容器比例跟随 PNG 的真实画布尺寸，避免竖版稿被塞进横向框里 */}
            <div
              className="project-media__frame checkerboard"
              style={previewAspectRatioStyle(image.width, image.height)}
            >
              <img
                className="project-media__image"
                src={buildImageUrl(image)}
                alt={`${project.title} 的展示图`}
                decoding="async"
              />
            </div>
            <figcaption className="project-media__caption">
              {image.fileName} · {formatDimensions(image.width, image.height)} ·{' '}
              {formatBytes(image.size)}
            </figcaption>
          </figure>
        </section>

        {/* ---------------------------- 右侧：信息区 ---------------------------- */}
        <aside className="project-page__sidebar">
          <h1 className="project-page__title">{project.title}</h1>

          <div className="project-page__author-row">
            <span className="avatar" aria-hidden="true">
              {project.author.slice(0, 1) || '匿'}
            </span>
            <div className="project-page__author-meta">
              <span className="project-page__author">{project.author}</span>
              <time className="project-page__time" dateTime={project.createdAt}>
                上传于 {formatDateTime(project.createdAt)}
              </time>
            </div>
          </div>

          <div className="project-page__stats">
            <span className="project-page__stat">
              <strong>{formatCount(project.stats.views)}</strong> 次浏览
            </span>
            <span className="project-page__stat">
              <strong>{formatCount(project.stats.downloads)}</strong> 次下载
            </span>
          </div>

          {project.tags.length > 0 ? (
            <div className="project-page__section">
              <h2 className="project-page__section-title">标签</h2>
              <TagList tags={project.tags} />
            </div>
          ) : null}

          <div className="project-page__section">
            <h2 className="project-page__section-title">说明</h2>
            {/* 契约 §7：不解析 Markdown，按纯文本 pre-wrap 原样渲染 */}
            <p className="project-page__description">
              {project.description.trim() ? project.description : '作者未填写说明。'}
            </p>
          </div>

          {/* 网盘卡片：契约 §3.10 的跳转端点 + 提取码一键复制 */}
          <NetdiskCard source={source} goUrl={buildNetdiskGoUrl(project.id)} />

          <div className="project-page__section">
            <h2 className="project-page__section-title">文件信息</h2>
            <dl className="meta-list">
              <div className="meta-list__row">
                <dt>文件名</dt>
                <dd title={image.fileName}>{image.fileName}</dd>
              </div>
              <div className="meta-list__row">
                <dt>体积</dt>
                <dd>{formatBytes(image.size)}</dd>
              </div>
              <div className="meta-list__row">
                <dt>尺寸</dt>
                <dd>{formatDimensions(image.width, image.height)}</dd>
              </div>
              <div className="meta-list__row">
                <dt>SHA-256</dt>
                <dd className="meta-list__hash" title={image.sha256}>
                  {image.sha256.slice(0, 16)}…
                </dd>
              </div>
            </dl>
          </div>

          {/* 下载按钮：契约 §5 要求直接给 href，让浏览器接管，不用 fetch+blob */}
          <div className="project-page__downloads">
            <a
              className="btn btn--primary btn--block"
              href={buildImageDownloadUrl(image)}
              download
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M8 1.6a.9.9 0 0 1 .9.9v6.05l1.86-1.86a.9.9 0 1 1 1.27 1.27l-3.4 3.4a.9.9 0 0 1-1.27 0l-3.4-3.4A.9.9 0 0 1 5.24 6.7L7.1 8.55V2.5A.9.9 0 0 1 8 1.6Z"
                  fill="currentColor"
                />
                <path d="M3.2 12.4a.9.9 0 0 1 .9.9v.3h7.8v-.3a.9.9 0 0 1 1.8 0v.6a1.5 1.5 0 0 1-1.5 1.5H3.8a1.5 1.5 0 0 1-1.5-1.5v-.6a.9.9 0 0 1 .9-.9Z" fill="currentColor" />
              </svg>
              下载 PNG
            </a>
          </div>

          <div className="project-page__secondary-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void handleCopyLink()}>
              复制链接
            </button>
          </div>

          <div className="project-page__danger">
            <button type="button" className="btn btn--danger btn--sm" onClick={() => setConfirmOpen(true)}>
              删除该工程
            </button>
            <p className="project-page__danger-hint">
              删除需要服务端配置的管理员令牌；操作不可撤销。
            </p>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="确认删除该工程？"
        description={`《${project.title}》及其 PNG 图片将被永久删除，且无法恢复。网盘上的源文件不受影响。`}
        confirmLabel="永久删除"
        busy={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
