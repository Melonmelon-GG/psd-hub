import { Link } from 'react-router-dom';

import { url } from '@/config';
import { providerColorStyle, providerStyle } from '@/netdisk/providers';
import { formatCount, formatDimensions, formatRelativeTime, previewAspectRatioStyle, summarize } from '@/utils/format';
import type { Project } from '@/types';

/**
 * 列表卡片：PNG 展示图 + 标题 + 说明摘要 + 作者 + 标签 + 尺寸 + 下载/浏览数，
 * 并在图上角标出**网盘来源**（契约 §1.3 的 providerLabel，图标与主题色取自 netdisk/providers）。
 *
 * v2.0 起 `image` 必有，因此不再有「无预览图」分支与占位图。
 * 图片使用 loading="lazy" 与 decoding="async"，避免一次性解码大量 PNG（契约 §5）。
 */
export function ProjectCard({ project }: { project: Project }) {
  const { image, source } = project;
  const netdisk = providerStyle(source.provider);

  return (
    <article className="project-card">
      <Link to={`/p/${project.id}`} className="project-card__link" aria-label={`查看《${project.title}》详情`}>
        {/* 容器比例跟随展示图真实尺寸；CSS 里的 3:2 仅在尺寸未知时兜底 */}
        <div
          className="project-card__media checkerboard"
          style={previewAspectRatioStyle(image.width, image.height)}
        >
          <img
            className="project-card__image"
            src={url(image.url)}
            alt={`${project.title} 的展示图`}
            loading="lazy"
            decoding="async"
          />

          {/* 网盘来源徽标：服务端已算好 providerLabel，这里只负责展示 */}
          <span
            className={`netdisk-badge netdisk-badge--sm netdisk-badge--${source.provider} project-card__provider`}
            style={providerColorStyle(source.provider)}
            title={`来源：${source.providerLabel}`}
          >
            <span className="netdisk-badge__icon" aria-hidden="true">
              {netdisk.icon}
            </span>
            {source.providerLabel}
          </span>

          <span className="project-card__dimensions">{formatDimensions(image.width, image.height)}</span>
        </div>

        <div className="project-card__body">
          <h3 className="project-card__title">{project.title}</h3>

          <p className="project-card__description">
            {project.description.trim() ? summarize(project.description) : '作者未填写说明'}
          </p>

          {project.tags.length > 0 ? (
            <ul className="project-card__tags">
              {project.tags.slice(0, 4).map((tag) => (
                <li key={tag} className="tag tag--sm">
                  {tag}
                </li>
              ))}
              {project.tags.length > 4 ? (
                <li className="tag tag--sm tag--more">+{project.tags.length - 4}</li>
              ) : null}
            </ul>
          ) : null}

          <div className="project-card__meta">
            <span className="project-card__author" title={project.author}>
              {project.author}
            </span>
            <span className="project-card__dot" aria-hidden="true">
              ·
            </span>
            <time className="project-card__time" dateTime={project.createdAt}>
              {formatRelativeTime(project.createdAt)}
            </time>

            <span className="project-card__stats">
              <span className="project-card__stat" title="下载次数">
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path
                    d="M8 1.6a.8.8 0 0 1 .8.8v6.02l2-2a.8.8 0 1 1 1.14 1.13l-3.37 3.37a.8.8 0 0 1-1.13 0L4.06 7.55A.8.8 0 0 1 5.2 6.42l2 2V2.4A.8.8 0 0 1 8 1.6ZM3.2 12a.8.8 0 0 1 .8.8v.4h8v-.4a.8.8 0 0 1 1.6 0v.8a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2v-.8a.8.8 0 0 1 .8-.8Z"
                    fill="currentColor"
                  />
                </svg>
                {formatCount(project.stats.downloads)}
              </span>
              <span className="project-card__stat" title="浏览次数">
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path
                    d="M8 3C4.7 3 2 5.4 1 8c1 2.6 3.7 5 7 5s6-2.4 7-5c-1-2.6-3.7-5-7-5Zm0 8.2A3.2 3.2 0 1 1 8 4.8a3.2 3.2 0 0 1 0 6.4Zm0-1.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z"
                    fill="currentColor"
                  />
                </svg>
                {formatCount(project.stats.views)}
              </span>
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}
