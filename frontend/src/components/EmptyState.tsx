import type { ReactNode } from 'react';

/** 空状态：列表无数据、无搜索结果等 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden="true">
        {icon ?? (
          <svg viewBox="0 0 48 48" focusable="false">
            <rect x="7" y="11" width="34" height="26" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M7 30l8.5-8 7 6.5L30 21l11 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <circle cx="17" cy="19" r="2.6" fill="currentColor" />
          </svg>
        )}
      </div>
      <h3 className="empty-state__title">{title}</h3>
      {description ? <p className="empty-state__text">{description}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
