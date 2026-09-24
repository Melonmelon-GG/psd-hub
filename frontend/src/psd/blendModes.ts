/**
 * PSD 混合模式 → Canvas globalCompositeOperation 映射。
 *
 * 说明（已知近似）：
 * - Canvas 2D 的混合模式集合是 PSD 的子集，且语义并不完全一致。
 *   `linear burn` / `linear dodge` / `color burn` / `color dodge` / `vivid light`
 *   / `linear light` / `pin light` / `hard mix` / `divide` / `subtract` 等在 Canvas 中没有等价项，
 *   这里映射到最接近的可用模式，属于**近似实现**。
 * - PSD 的 `normal` 与 `pass through` 都映射到 `source-over`（组图层的穿透效果由渲染层递归实现）。
 * - `dissolve` 需要逐像素随机处理，Canvas 无法表达，降级为 `source-over`。
 */

/** Canvas 合法的 globalCompositeOperation 值（合成类，不含 source-over 之外的裁剪类语义差异） */
export const CANVAS_BLEND_MODES = [
  'source-over',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;

export type CanvasBlendMode = (typeof CANVAS_BLEND_MODES)[number] | 'source-over';

/**
 * 归一化 PSD 混合模式字符串：转小写、去除首尾空白，
 * 并把 PSD 的驼峰/连字符/空格写法统一成以 "-" 分词的形态。
 */
export function normalizeBlendModeKey(mode: string): string {
  return mode
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

/** PSD 混合模式 → Canvas 模式的完整映射表 */
const BLEND_MODE_MAP: Readonly<Record<string, CanvasBlendMode>> = {
  normal: 'source-over',
  'pass-through': 'source-over',
  'pass through': 'source-over',
  dissolve: 'source-over',

  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',

  darken: 'darken',
  'darker-color': 'darken',
  lighten: 'lighten',
  'lighter-color': 'lighten',

  'color-dodge': 'color-dodge',
  'color-dodge-blend': 'color-dodge',
  'color-burn': 'color-burn',
  'color-burn-blend': 'color-burn',

  'hard-light': 'hard-light',
  'soft-light': 'soft-light',

  difference: 'difference',
  exclusion: 'exclusion',

  // Canvas 无对应项，取最接近的近似
  'linear-burn': 'color-burn',
  'linear-dodge': 'color-dodge',
  'linear-light': 'hard-light',
  'vivid-light': 'hard-light',
  'pin-light': 'hard-light',
  'hard-mix': 'hard-light',
  'soft-mix': 'soft-light',
  subtract: 'difference',
  divide: 'color-dodge',

  // HSB/HSL 系列在 Canvas 中的非分离式等价项
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

/**
 * 把 PSD 的 blendMode（可能是 'normal' / 'linear burn' / 'linearBurn' / undefined）
 * 映射为合法的 Canvas globalCompositeOperation。未知值兜底为 'source-over'。
 */
export function mapBlendMode(mode: string | undefined | null): CanvasBlendMode {
  if (!mode || typeof mode !== 'string') return 'source-over';
  const key = normalizeBlendModeKey(mode);
  const direct = BLEND_MODE_MAP[key];
  if (direct) return direct;
  // 去掉连字符再试一次，兼容 'linearBurn' / 'LinearBurn' 之类的写法
  const compact = key.replace(/-/g, '');
  for (const [mapKey, value] of Object.entries(BLEND_MODE_MAP)) {
    if (mapKey.replace(/-/g, '') === compact) return value;
  }
  return 'source-over';
}

/** 是否存在该混合模式的原生等价实现（用于判断是否发生近似降级） */
export function isApproximateBlendMode(mode: string | undefined | null): boolean {
  if (!mode) return false;
  const key = normalizeBlendModeKey(mode);
  const exact = new Set([
    'normal',
    'pass-through',
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'color-dodge',
    'color-burn',
    'hard-light',
    'soft-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
  ]);
  return !exact.has(key);
}

/**
 * 已知的 ag-psd / PSD 混合模式全集（ag-psd 使用**带空格的单词**，如 'linear burn'）。
 * 用于测试与诊断：是否存在未覆盖的模式。
 */
export const KNOWN_PSD_BLEND_MODES = [
  'normal',
  'dissolve',
  'darken',
  'multiply',
  'color burn',
  'linear burn',
  'darker color',
  'lighten',
  'screen',
  'color dodge',
  'linear dodge',
  'lighter color',
  'overlay',
  'soft light',
  'hard light',
  'vivid light',
  'linear light',
  'pin light',
  'hard mix',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'pass through',
] as const;

/** 中文展示名，用于图层面板（未收录的模式原样展示） */
const BLEND_MODE_LABEL: Readonly<Record<string, string>> = {
  normal: '正常',
  'pass-through': '穿透',
  dissolve: '溶解',
  multiply: '正片叠底',
  screen: '滤色',
  overlay: '叠加',
  darken: '变暗',
  'darker-color': '深色',
  lighten: '变亮',
  'lighter-color': '浅色',
  'color-dodge': '颜色减淡',
  'color-burn': '颜色加深',
  'hard-light': '强光',
  'soft-light': '柔光',
  difference: '差值',
  exclusion: '排除',
  'linear-burn': '线性加深',
  'linear-dodge': '线性减淡',
  'linear-light': '线性光',
  'vivid-light': '亮光',
  'pin-light': '点光',
  'hard-mix': '实色混合',
  subtract: '减去',
  divide: '划分',
  hue: '色相',
  saturation: '饱和度',
  color: '颜色',
  luminosity: '明度',
};

/** 把 PSD 混合模式字符串转成中文标签 */
export function blendModeLabel(mode: string | undefined | null): string {
  if (!mode) return '正常';
  const key = normalizeBlendModeKey(mode);
  return BLEND_MODE_LABEL[key] ?? mode;
}
