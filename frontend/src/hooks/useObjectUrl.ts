import { useEffect, useState } from 'react';

/**
 * 把 Blob 包装成 object URL，并在依赖变化或组件卸载时自动 revoke，
 * 避免上传预览等场景泄漏内存。
 */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setObjectUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setObjectUrl(next);
    return () => {
      URL.revokeObjectURL(next);
    };
  }, [blob]);

  return objectUrl;
}
