/**
 * 色彩科学：把各色彩模式的 8 位样本平面转成 RGBA。
 *
 * 关键事实（均已实测确认）：
 * 1. **CMYK 存的是反相墨量**：255 = 无墨、0 = 满墨，因此 `R = round(S_C * S_K / 255)`；
 * 2. **Lab 基于 D50**（ICC PCS 照明体），用 D65 会整体偏色（实测 MAE≈66）；
 * 3. Indexed 调色板在文件里是**平面**存放（256R + 256G + 256B），需要转成交错形态。
 */
import { PsdDecodeError } from './types.ts';

/** D50 白点（ICC PCS） */
const D50_X = 0.9642;
const D50_Y = 1.0;
const D50_Z = 0.8249;
const DELTA = 6 / 29;
const DELTA_SQUARED_TIMES_3 = 3 * DELTA * DELTA;

/** 四舍五入并夹到 0..255（NaN 视为 0，避免脏数据污染画面） */
export function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

/** 线性 RGB → sRGB gamma */
export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/** Lab 的逆函数（`t > 6/29` 用立方，否则线性段） */
function labFInv(t: number): number {
  return t > DELTA ? t * t * t : DELTA_SQUARED_TIMES_3 * (t - 4 / 29);
}

/** 写一个 CMYK 像素（输入为文件里的原始反相墨量字节） */
export function writeCmykPixel(
  out: Uint8ClampedArray,
  offset: number,
  c: number,
  m: number,
  y: number,
  k: number,
): void {
  out[offset] = Math.round((c * k) / 255);
  out[offset + 1] = Math.round((m * k) / 255);
  out[offset + 2] = Math.round((y * k) / 255);
}

/** 写一个 Lab 像素（输入为文件里的原始字节，D50 白点） */
export function writeLabPixel(
  out: Uint8ClampedArray,
  offset: number,
  l8: number,
  a8: number,
  b8: number,
): void {
  const fy = ((l8 / 255) * 100 + 16) / 116;
  const fx = fy + (a8 - 128) / 500;
  const fz = fy - (b8 - 128) / 200;

  const x = D50_X * labFInv(fx);
  const y = D50_Y * labFInv(fy);
  const z = D50_Z * labFInv(fz);

  // XYZ(D50) → 线性 sRGB（Lindbloom 推荐矩阵）
  const rl = 3.1338561 * x - 1.6168667 * y - 0.4906146 * z;
  const gl = -0.9787684 * x + 1.9161415 * y + 0.033454 * z;
  const bl = 0.0719453 * x - 0.2289914 * y + 1.4052427 * z;

  out[offset] = clampByte(linearToSrgb(rl) * 255);
  out[offset + 1] = clampByte(linearToSrgb(gl) * 255);
  out[offset + 2] = clampByte(linearToSrgb(bl) * 255);
}

/** CMYK（反相墨量）→ RGB，已 clamp 到 0..255 */
export function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  return [Math.round((c * k) / 255), Math.round((m * k) / 255), Math.round((y * k) / 255)];
}

/** Lab（文件原始字节）→ RGB，D50 白点 */
export function labToRgb(l8: number, a8: number, b8: number): [number, number, number] {
  const out = new Uint8ClampedArray(3);
  writeLabPixel(out, 0, l8, a8, b8);
  return [out[0], out[1], out[2]];
}

/**
 * 把 PSD 的**平面**调色板转成**交错** RGB（长度 768）。
 *
 * ⚠️ 文件里是「前 256 字节全是 R，接着 256 字节全是 G，最后 256 字节全是 B」，
 * 若按交错解读会导致整幅画面颜色错乱。
 */
export function planarPaletteToInterleaved(planar: Uint8Array): Uint8Array {
  if (planar.length < 768) {
    throw new PsdDecodeError(`Indexed 调色板长度不足：${planar.length} 字节（需要 768）`, 'INVALID_STRUCTURE');
  }
  const palette = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    palette[i * 3] = planar[i];
    palette[i * 3 + 1] = planar[256 + i];
    palette[i * 3 + 2] = planar[512 + i];
  }
  return palette;
}

export interface RenderRgbaOptions {
  colorMode: number;
  width: number;
  height: number;
  /** 颜色通道的 8 位样本平面（每片长度 = width * height），按通道顺序 */
  planes: readonly Uint8Array[];
  /** 透明度平面；null 表示不透明（合成图无 alpha） */
  alpha: Uint8Array | null;
  /** Indexed 模式必需：交错 RGB 调色板（768 字节） */
  palette: Uint8Array | null;
}

/** 把 8 位样本平面渲染成 RGBA（一次性分配，逐像素紧凑循环） */
export function renderRgba(options: RenderRgbaOptions): Uint8ClampedArray {
  const { colorMode, width, height, planes, palette } = options;
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);
  const p0 = planes[0];
  const p1 = planes[1];
  const p2 = planes[2];
  const p3 = planes[3];

  if (!p0) {
    // 没有任何颜色通道数据：输出透明黑（上层会据此标记 surface 不可用）
    return out;
  }

  switch (colorMode) {
    case 3: {
      if (!p1 || !p2) throw new PsdDecodeError('RGB 数据缺少 G/B 通道', 'INVALID_STRUCTURE');
      for (let i = 0, o = 0; i < count; i++, o += 4) {
        out[o] = p0[i];
        out[o + 1] = p1[i];
        out[o + 2] = p2[i];
      }
      break;
    }

    case 4: {
      if (!p1 || !p2 || !p3) throw new PsdDecodeError('CMYK 数据缺少 C/M/Y/K 通道', 'INVALID_STRUCTURE');
      for (let i = 0, o = 0; i < count; i++, o += 4) writeCmykPixel(out, o, p0[i], p1[i], p2[i], p3[i]);
      break;
    }

    case 9: {
      if (!p1 || !p2) throw new PsdDecodeError('Lab 数据缺少 a/b 通道', 'INVALID_STRUCTURE');
      for (let i = 0, o = 0; i < count; i++, o += 4) writeLabPixel(out, o, p0[i], p1[i], p2[i]);
      break;
    }

    case 2: {
      if (!palette) throw new PsdDecodeError('Indexed 模式缺少调色板数据', 'INVALID_STRUCTURE');
      for (let i = 0, o = 0; i < count; i++, o += 4) {
        const index = p0[i] * 3;
        out[o] = palette[index];
        out[o + 1] = palette[index + 1];
        out[o + 2] = palette[index + 2];
      }
      break;
    }

    case 7: {
      // 无通用 RGB 解释，做近似：≥3 通道取前 3 个当 R/G/B；1/2 通道按灰度（2 通道时第 2 个当 alpha）
      if (p1 && p2) {
        for (let i = 0, o = 0; i < count; i++, o += 4) {
          out[o] = p0[i];
          out[o + 1] = p1[i];
          out[o + 2] = p2[i];
        }
      } else {
        for (let i = 0, o = 0; i < count; i++, o += 4) {
          const gray = p0[i];
          out[o] = gray;
          out[o + 1] = gray;
          out[o + 2] = gray;
        }
      }
      break;
    }

    default: {
      // Bitmap(0) / Grayscale(1) / Duotone(8)：1 位或 1 通道灰阶（Bitmap 已展开为 0/255）
      for (let i = 0, o = 0; i < count; i++, o += 4) {
        const gray = p0[i];
        out[o] = gray;
        out[o + 1] = gray;
        out[o + 2] = gray;
      }
      break;
    }
  }

  // 透明度：显式 alpha 平面 > Multichannel 2 通道特例 > 不透明
  const alphaPlane = options.alpha ?? (colorMode === 7 && planes.length === 2 && p1 ? p1 : null);
  if (alphaPlane) {
    for (let i = 0, o = 3; i < count; i++, o += 4) out[o] = alphaPlane[i];
  } else {
    for (let i = 0, o = 3; i < count; i++, o += 4) out[o] = 255;
  }

  return out;
}
