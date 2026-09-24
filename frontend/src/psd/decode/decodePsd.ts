/**
 * 自研 PSD 解码器入口：把字节流解码成「合成图 + 图层树」的 RGBA 结果。
 *
 * 为什么需要它：`ag-psd` 只支持 Bitmap/Grayscale/RGB/Indexed 四种模式
 * （见 capabilities.ts 的实测结论），CMYK / Lab / Multichannel / Duotone 会直接抛错，
 * 16 位 RLE 也会错位。本解码器覆盖这些情况，并提供与 ag-psd 对齐的图层树。
 *
 * 设计原则：
 * - **纯逻辑、零依赖、不触碰 DOM**：既能跑在浏览器里，也能在 Node 下用
 *   `tools/fixtures/*.rgba` 做逐像素回归。
 * - **容错优先**：图层段损坏不应让整张图无法预览 —— 记录 warning 后仍然输出合成图。
 * - 所有越界读取都会抛 {@link PsdDecodeError}，绝不返回半截数据。
 */
import { colorModeName, COLOR_MODE_NAMES } from './capabilities.ts';
import { planarPaletteToInterleaved, renderRgba } from './color.ts';
import { parseLayerAndMaskSection } from './layers.ts';
import { ByteReader } from './reader.ts';
import { bytesPerRow, extractRlePlane, writeRowSamples } from './samples.ts';
import type { CompressionName, DecodeResult, DecodedLayer, DecodedSurface } from './types.ts';
import { PsdDecodeError } from './types.ts';

/** 16 位/通道的样本降采样后统一按 8 位处理 */
const SUPPORTED_BITS = new Set([1, 8, 16, 32]);

/** 单张图的 RGBA 像素面上限（512MB），防止损坏文件导致 OOM */
const MAX_SURFACE_BYTES = 512 * 1024 * 1024;

/** 画布单边上限，超过基本可以判定文件头损坏 */
const MAX_DIMENSION = 30000;

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new PsdDecodeError('解码入参必须是 ArrayBuffer 或 Uint8Array', 'INVALID_INPUT');
}

/**
 * 合成图像数据段里「颜色通道」的数量。
 *
 * 文件头的通道数 = 颜色通道 + 可选 1 个 alpha，因此颜色通道数取该模式的名义基色数
 * 与文件头声明数的较小值；多出来的那一个即 alpha。
 *
 * Multichannel(7) 是例外：它的通道数完全由用户决定（可以带多个专色通道），
 * 无法区分专色与 alpha，这里按「前 3 个当 RGB」近似，并交由上层提示为近似预览。
 */
function compositeColorChannels(colorMode: number, channels: number): number {
  switch (colorMode) {
    case 4: // CMYK
      return Math.min(4, channels);
    case 3: // RGB
    case 7: // Multichannel
    case 9: // Lab
      return Math.min(3, channels);
    default: // Bitmap / Grayscale / Indexed / Duotone：单通道
      return Math.min(1, channels);
  }
}

/** 读取合成图像数据段，返回各通道的 8 位样本平面 */
function readCompositePlanes(
  reader: ByteReader,
  ctx: {
    version: 1 | 2;
    width: number;
    height: number;
    bitsPerChannel: number;
    channels: number;
    warnings: string[];
  },
): { planes: Uint8Array[]; compression: CompressionName } {
  const { version, width, height, bitsPerChannel, channels } = ctx;
  const compressionFlag = reader.u16('合成图像压缩标志');
  if (compressionFlag !== 0 && compressionFlag !== 1) {
    throw new PsdDecodeError(
      `不支持的合成图压缩方式 ${compressionFlag}（仅支持 0 = 原始、1 = RLE；` +
        `2/3 为 ZIP 压缩，Photoshop 默认不会使用）`,
      'UNSUPPORTED_COMPRESSION',
    );
  }
  const compression: CompressionName = compressionFlag === 0 ? 'raw' : 'rle';
  const rowBytes = bytesPerRow(width, bitsPerChannel);
  const planes: Uint8Array[] = [];

  if (compression === 'raw') {
    for (let c = 0; c < channels; c++) {
      const plane = new Uint8Array(width * height);
      const source = reader.bytes(rowBytes * height, `通道 ${c} 原始数据`);
      for (let y = 0; y < height; y++) {
        // 复用 samples 的位深处理：1/8/16/32 位都在这里统一降到 8 位
        writeRowSamples(source, y * rowBytes, width, bitsPerChannel, plane, y * width);
      }
      planes.push(plane);
    }
    return { planes, compression };
  }

  // RLE：行长度表为「通道优先」的全局表（先 channel0 的全部行，再 channel1 …）
  const rowLengths = new Int32Array(channels * height);
  let total = 0;
  for (let c = 0; c < channels; c++) {
    for (let y = 0; y < height; y++) {
      const length = version === 2 ? reader.u32('行长度') : reader.u16('行长度');
      rowLengths[c * height + y] = length;
      total += length;
    }
  }

  const dataStart = reader.offset;
  if (dataStart + total > reader.limit) {
    throw new PsdDecodeError(
      `合成图 RLE 行长度表声明 ${total} 字节，超出剩余 ${reader.limit - dataStart} 字节`,
      'TRUNCATED',
    );
  }

  let cursor = dataStart;
  for (let c = 0; c < channels; c++) {
    const plane = new Uint8Array(width * height);
    extractRlePlane(reader.data, cursor, dataStart + total, rowLengths, c * height, height, width, bitsPerChannel, plane, `通道 ${c}`);
    for (let y = 0; y < height; y++) cursor += rowLengths[c * height + y];
    planes.push(plane);
  }
  reader.skip(total, '合成图 RLE 数据');
  return { planes, compression };
}

/**
 * 解码一个 PSD / PSB。
 *
 * @throws {PsdDecodeError} 签名/版本/结构非法、越界、内存超限等情况
 */
export function decodePsd(input: ArrayBuffer | Uint8Array): DecodeResult {
  const startedAt = now();
  const bytes = toBytes(input);
  const reader = new ByteReader(bytes);

  /* ------------------------------ 1. 文件头 ------------------------------ */
  const signature = reader.ascii4('文件签名');
  if (signature !== '8BPS') {
    throw new PsdDecodeError(`不是 PSD 文件：签名应为 "8BPS"，实际为 "${signature}"`, 'INVALID_SIGNATURE');
  }

  const rawVersion = reader.u16('版本');
  if (rawVersion !== 1 && rawVersion !== 2) {
    throw new PsdDecodeError(`不支持的 PSD 版本 ${rawVersion}（1 = PSD，2 = PSB）`, 'UNSUPPORTED_VERSION');
  }
  const version = rawVersion as 1 | 2;

  const reserved = reader.bytes(6, '保留字段');
  for (let i = 0; i < 6; i++) {
    if (reserved[i] !== 0) {
      throw new PsdDecodeError('文件头保留字段应为全 0，该文件可能已损坏', 'INVALID_HEADER');
    }
  }

  const channels = reader.u16('通道数');
  if (channels < 1 || channels > 56) {
    throw new PsdDecodeError(`通道数 ${channels} 非法（规范为 1..56）`, 'INVALID_HEADER');
  }

  const height = reader.u32('高度');
  const width = reader.u32('宽度');
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new PsdDecodeError(`画布尺寸 ${width}×${height} 非法（单边需在 1..${MAX_DIMENSION} 之间）`, 'INVALID_DIMENSION');
  }
  if (width * height * 4 > MAX_SURFACE_BYTES) {
    throw new PsdDecodeError(
      `画布 ${width}×${height} 的像素面超过 ${MAX_SURFACE_BYTES / 1024 / 1024}MB 上限，无法在浏览器内解码`,
      'SIZE_LIMIT',
    );
  }

  const bitsPerChannel = reader.u16('位深');
  if (!SUPPORTED_BITS.has(bitsPerChannel)) {
    throw new PsdDecodeError(`不支持的位深 ${bitsPerChannel}（仅支持 1 / 8 / 16 / 32）`, 'UNSUPPORTED_BITS');
  }

  const colorMode = reader.u16('色彩模式');
  if (!(colorMode in COLOR_MODE_NAMES)) {
    throw new PsdDecodeError(`不支持的色彩模式编码 ${colorMode}`, 'UNSUPPORTED_COLOR_MODE');
  }

  const warnings: string[] = [];
  if (bitsPerChannel === 32) warnings.push('32 位/通道为尽力支持：按浮点样本线性映射到 8 位预览。');

  /* --------------------------- 2. 色彩模式数据段 --------------------------- */
  const colorModeDataLength = reader.u32('色彩模式数据长度');
  const colorModeData = reader.bytes(colorModeDataLength, '色彩模式数据');
  let palette: Uint8Array | null = null;
  if (colorMode === 2) {
    if (colorModeDataLength !== 768) {
      throw new PsdDecodeError(`Indexed 调色板应为 768 字节，实际 ${colorModeDataLength} 字节`, 'INVALID_STRUCTURE');
    }
    // ⚠️ 调色板在文件里是「平面」存放：先 256 个 R，再 256 个 G，最后 256 个 B
    palette = planarPaletteToInterleaved(colorModeData);
  } else if (colorMode === 8) {
    // 双色调一律按灰度近似：本版本不解析双色调曲线，因此**无论有没有曲线数据**都要提示，
    // 没有数据时更要提示（说明文件里的专色信息缺失，预览只能是灰度）。
    warnings.push(
      colorModeDataLength > 0
        ? '双色调（Duotone）按灰度近似预览：已忽略文件里的双色调曲线数据。'
        : '双色调（Duotone）按灰度近似预览：该文件未包含双色调曲线数据。',
    );
  }

  /* ----------------------------- 3. 图像资源段 ----------------------------- */
  const imageResourcesLength = reader.u32('图像资源段长度');
  reader.skip(imageResourcesLength, '图像资源段');

  /* -------------------------- 4. 图层与蒙版信息段 -------------------------- */
  const layerAndMaskLength = version === 2 ? reader.u64('图层与蒙版信息长度') : reader.u32('图层与蒙版信息长度');
  let layers: DecodedLayer[] = [];
  let layerCount = 0;
  if (layerAndMaskLength > 0) {
    const section = reader.sub(layerAndMaskLength, '图层与蒙版信息');
    try {
      const parsed = parseLayerAndMaskSection(section, { version, colorMode, bitsPerChannel, palette, warnings });
      layers = parsed.layers;
      layerCount = parsed.layerCount;
    } catch (error) {
      // 图层段损坏时仍应能看合成图：降级为「无图层树」而不是整体失败
      if (error instanceof PsdDecodeError) {
        warnings.push(`图层结构解析失败，已跳过图层树（仍可查看合成图）：${error.message}`);
        layers = [];
        layerCount = 0;
      } else {
        throw error;
      }
    }
  }

  /* ---------------------------- 5. 合成图像数据 ---------------------------- */
  const { planes, compression } = readCompositePlanes(reader, {
    version,
    width,
    height,
    bitsPerChannel,
    channels,
    warnings,
  });

  /* ------------------------------- 6. 转 RGBA ------------------------------- */
  const colorChannels = compositeColorChannels(colorMode, channels);
  const colorPlanes = planes.slice(0, colorChannels);
  const alphaPlane = channels > colorChannels ? planes[colorChannels] : null;

  if (colorMode === 7) {
    warnings.push('多通道（Multichannel）没有通用的 RGB 显示规则，此处按前 3 个通道近似预览。');
  }

  const compositeData = renderRgba({
    colorMode,
    width,
    height,
    planes: colorPlanes,
    alpha: alphaPlane,
    palette,
  });

  const composite: DecodedSurface = { width, height, data: compositeData };

  return {
    width,
    height,
    version,
    colorMode,
    colorModeName: colorModeName(colorMode),
    bitsPerChannel,
    channels,
    compression,
    composite,
    layers,
    layerCount,
    palette,
    warnings,
    decodeMs: Math.round(now() - startedAt),
  };
}
