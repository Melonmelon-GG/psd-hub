/**
 * 能力表：告诉上层「什么时候必须切到本兜底引擎」。
 *
 * 实测基线（详见任务背景表）：
 * - ag-psd 8 位支持 RGB / Grayscale / Indexed；
 * - ag-psd 不支持 CMYK(4) / Lab(9) / Multichannel(7) / Duotone(8) / Bitmap(0)；
 * - ag-psd 的 16 位 RLE 会错位，32 位同样不可靠。
 */

/** 色彩模式编号 → 名称 */
export const COLOR_MODE_NAMES: Readonly<Record<number, string>> = {
  0: 'Bitmap',
  1: 'Grayscale',
  2: 'Indexed',
  3: 'RGB',
  4: 'CMYK',
  7: 'Multichannel',
  8: 'Duotone',
  9: 'Lab',
};

/** ag-psd 8 位可靠支持、可直接交给原生引擎的色彩模式 */
export const NATIVE_SUPPORTED_COLOR_MODES: ReadonlySet<number> = new Set([1, 2, 3]);

/** 必须使用本兜底引擎的色彩模式 */
export const FALLBACK_REQUIRED_COLOR_MODES: ReadonlySet<number> = new Set([0, 4, 7, 8, 9]);

/** 色彩模式编号 → 名称；未知编号返回 `未知(n)` */
export function colorModeName(colorMode: number): string {
  return COLOR_MODE_NAMES[colorMode] ?? `未知(${colorMode})`;
}

/**
 * 是否需要兜底引擎：
 * - 色彩模式不在 {@link NATIVE_SUPPORTED_COLOR_MODES} 内 → true；
 * - 位深不是 8（ag-psd 的 16/32 位不可靠）→ true。
 */
export function requiresFallbackEngine(colorMode: number, bitsPerChannel: number): boolean {
  if (!NATIVE_SUPPORTED_COLOR_MODES.has(colorMode)) return true;
  return bitsPerChannel !== 8;
}
