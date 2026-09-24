import { useEffect } from 'react';

/** 站点标题后缀 */
const SITE_TITLE = '柒世纪视频组平面工程分享平台';

/**
 * 随页面变化的 document.title。
 * 详情页传入工程标题，列表页传空则使用站点默认标题。
 */
export function useDocumentTitle(title?: string | null): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title && title.trim() ? `${title.trim()} · ${SITE_TITLE}` : SITE_TITLE;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
