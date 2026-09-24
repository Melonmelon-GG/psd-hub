import { useEffect, useState } from 'react';

/**
 * 防抖：返回延迟 delay 毫秒后才更新的值。
 * 用于搜索框——输入时立即回显、延迟触发请求。
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    // delay <= 0 时同步跟随，避免多余的一帧延迟
    if (delay <= 0) {
      setDebounced(value);
      return;
    }
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
