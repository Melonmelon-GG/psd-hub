/**
 * 自研 PSD 兜底解码引擎。
 *
 * 用途：`ag-psd` 无法处理的色彩模式（CMYK / Lab / Multichannel / Duotone）
 * 与不可靠的场景（16 位 RLE），由本模块接管，输出与 ag-psd 对齐的图层树与 RGBA 像素面。
 *
 * 能力边界与实测依据见 `docs/COLOR-MODES.md`。
 */
export { decodePsd } from './decodePsd.ts';
export {
  COLOR_MODE_NAMES,
  NATIVE_SUPPORTED_COLOR_MODES,
  FALLBACK_REQUIRED_COLOR_MODES,
  colorModeName,
  requiresFallbackEngine,
} from './capabilities.ts';
export { cmykToRgb, labToRgb, planarPaletteToInterleaved, renderRgba } from './color.ts';
export { PSD_BLEND_MODES, resolveBlendMode, countLayerNodes } from './layers.ts';
export { ByteReader } from './reader.ts';
export { decodePackBits } from './packbits.ts';
export type { CompressionName, DecodeResult, DecodedLayer, DecodedSurface } from './types.ts';
export { PsdDecodeError } from './types.ts';
