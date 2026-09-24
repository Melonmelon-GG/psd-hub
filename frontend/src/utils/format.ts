/**
 * 通用展示格式化（纯函数，便于测试与复用）。
 * 注：本文件是在参考目录结构之外新增的，用于避免日期/数字格式化逻辑在多个组件里重复。
 */

/** ISO 8601 → 本地化日期时间；无效值返回占位符 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** ISO 8601 → 本地化日期（不含时间） */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** 相对时间（刚刚 / N 分钟前 / N 天前），超过 30 天回落到日期 */
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';

  const diff = now - time;
  if (diff < 0) return formatDate(iso);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days} 天前`;
  return formatDate(iso);
}

/** 大数字缩写：1234 → 1.2k */
export function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

/** 0..1 不透明度 → 百分比文本（ag-psd 的 opacity 是小数） */
export function formatOpacityPercent(opacity: number | null | undefined): string {
  if (typeof opacity !== 'number' || !Number.isFinite(opacity)) return '100%';
  return `${Math.round(opacity * 100)}%`;
}

/** 说明摘要：折叠换行并截断 */
export function summarize(text: string, maxLength = 110): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  return `${flat.slice(0, maxLength)}…`;
}

/** 像素尺寸文本 */
export function formatDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (typeof width !== 'number' || typeof height !== 'number') return '—';
  return `${width} × ${height}`;
}

/**
 * 按素材的**真实宽高**生成预览容器的 `aspect-ratio` 内联样式。
 *
 * 为什么需要它：预览容器不能写死比例。CSS 里给 `.preview-box` / `.project-card__media`
 * 设的 `aspect-ratio: 3 / 2` 只是**没有尺寸信息时的兜底**；一旦我们知道工程画布（或预览图）
 * 的真实尺寸，就应该用它撑出容器，否则竖版画布（例如手机 UI 稿 1080×2340）
 * 会被塞进一个横向的框里，四周留出大片空白，看起来就像"预览图比例不对"。
 *
 * 返回 `undefined` 表示尺寸未知，此时沿用 CSS 里的默认比例。
 * 比例极端（超出 0.2 ~ 5）时收敛到边界，避免一张超长/超宽的图把整行卡片撑坏。
 */
export function previewAspectRatioStyle(
  width: number | null | undefined,
  height: number | null | undefined,
): { aspectRatio: string } | undefined {
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;

  const ratio = width / height;
  if (ratio < 0.2 || ratio > 5) {
    return { aspectRatio: ratio < 0.2 ? '1 / 5' : '5 / 1' };
  }
  // 用原始像素值书写比例，语义最清晰，也避免浮点舍入
  return { aspectRatio: `${width} / ${height}` };
}
