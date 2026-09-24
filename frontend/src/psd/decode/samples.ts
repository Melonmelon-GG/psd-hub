/**
 * 通道样本的读取与降采样。
 *
 * 位深处理：
 * - 8 位：1 字节/样本；
 * - 16 位：2 字节大端/样本，**取高字节**降到 8 位（生成侧按 `v * 257` 写入，故 `>> 8` 无损往返）；
 * - 32 位：4 字节大端 IEEE-754，clamp 到 0..1 后 ×255（尽力支持）；
 * - 1 位（Bitmap）：按位展开，行内高位在前，`1 = 白(255)`、`0 = 黑(0)`，每行按字节对齐。
 *
 * 通道数据的两种形态：
 * - 图层通道：`2 字节压缩标志` + 数据（RLE 时紧跟本通道 height 项行长度表）；
 * - 合成图像：整个数据段开头一个压缩标志，行长度表为「通道优先」的全局表。
 */
import { clampByte } from './color.ts';
import { decodePackBits } from './packbits.ts';
import type { ByteReader } from './reader.ts';
import { PsdDecodeError } from './types.ts';

/** 每样本字节数（1 位单独处理） */
export function bytesPerSample(bits: number): number {
  return bits <= 8 ? 1 : bits / 8;
}

/** 每行字节数（1 位时按 width/8 向上取整） */
export function bytesPerRow(width: number, bits: number): number {
  return bits === 1 ? (width + 7) >> 3 : (width * bits) / 8;
}

/**
 * 把一行样本（在 src 中已按行内连续存放）降采样为 8 位样本，写入 `out[outOffset, outOffset + width)`。
 */
export function writeRowSamples(
  src: Uint8Array,
  srcOffset: number,
  width: number,
  bits: number,
  out: Uint8Array,
  outOffset: number,
): void {
  switch (bits) {
    case 8: {
      out.set(src.subarray(srcOffset, srcOffset + width), outOffset);
      return;
    }

    case 16: {
      // 大端 16 位：高字节即 `>> 8`
      for (let x = 0; x < width; x++) out[outOffset + x] = src[srcOffset + x * 2];
      return;
    }

    case 32: {
      const view = new DataView(src.buffer, src.byteOffset + srcOffset, width * 4);
      for (let x = 0; x < width; x++) {
        const value = view.getFloat32(x * 4, false);
        const clamped = value <= 0 ? 0 : value >= 1 ? 1 : value;
        out[outOffset + x] = clampByte(clamped * 255);
      }
      return;
    }

    case 1: {
      for (let x = 0; x < width; x++) {
        const byte = src[srcOffset + (x >> 3)];
        out[outOffset + x] = ((byte >> (7 - (x & 7))) & 1) === 1 ? 255 : 0;
      }
      return;
    }

    default:
      throw new PsdDecodeError(`不支持的位深 ${bits}（仅支持 1 / 8 / 16 / 32）`, 'UNSUPPORTED_BITS');
  }
}

/**
 * 从 RLE 行长度表 + 数据区提取一个样本平面（8 位）。
 *
 * @param data 底层字节
 * @param dataOffset 该通道 RLE 数据的起始绝对偏移
 * @param dataEnd 该通道 RLE 数据的结束绝对偏移（用于边界检查）
 * @param rowLengths 行长度表（压缩后字节数）
 * @param rowStart 本通道在表中的起始下标
 * @param rowCount 行数（= 通道高度）
 */
export function extractRlePlane(
  data: Uint8Array,
  dataOffset: number,
  dataEnd: number,
  rowLengths: Int32Array,
  rowStart: number,
  rowCount: number,
  width: number,
  bits: number,
  out: Uint8Array,
  label: string,
): void {
  const rowBytes = bytesPerRow(width, bits);
  const scratch = new Uint8Array(rowBytes);
  let position = dataOffset;

  for (let y = 0; y < rowCount; y++) {
    const length = rowLengths[rowStart + y];
    if (length <= 0) continue; // 空行：Photoshop 会为无边界的空图层写 0 长度
    if (position + length > dataEnd) {
      throw new PsdDecodeError(
        `「${label}」第 ${y} 行 RLE 数据越界：需要 ${length} 字节，剩余 ${Math.max(0, dataEnd - position)} 字节`,
        'TRUNCATED',
      );
    }
    const written = decodePackBits(data, position, length, scratch, 0, rowBytes);
    if (written > 0) writeRowSamples(scratch, 0, width, bits, out, y * width);
    position += length;
  }
}

/**
 * 读取「2 字节压缩标志 + 数据」形态的通道数据（图层通道），返回 8 位样本平面。
 *
 * @param reader 指向该通道数据块起点的读取器（块长度已由调用方限定）
 */
export function readChannelPlane(
  reader: ByteReader,
  width: number,
  height: number,
  bits: number,
  version: 1 | 2,
  label: string,
): Uint8Array {
  const plane = new Uint8Array(width * height);
  const rowBytes = bytesPerRow(width, bits);
  const compression = reader.u16(`${label} 压缩标志`);

  if (compression === 0) {
    const needed = rowBytes * height;
    const source = reader.bytes(needed, `${label} 原始通道数据`);
    for (let y = 0; y < height; y++) {
      writeRowSamples(source, y * rowBytes, width, bits, plane, y * width);
    }
    return plane;
  }

  if (compression === 1) {
    const rowLengths = new Int32Array(height);
    let total = 0;
    for (let y = 0; y < height; y++) {
      const length = version === 2 ? reader.u32(`${label} 行长度`) : reader.u16(`${label} 行长度`);
      rowLengths[y] = length;
      total += length;
    }
    if (total > reader.remaining) {
      throw new PsdDecodeError(
        `「${label}」RLE 行长度表声明 ${total} 字节，超出通道数据块剩余 ${reader.remaining} 字节`,
        'TRUNCATED',
      );
    }
    const start = reader.offset;
    extractRlePlane(reader.data, start, start + total, rowLengths, 0, height, width, bits, plane, label);
    reader.skip(total, `${label} RLE 数据`);
    return plane;
  }

  throw new PsdDecodeError(
    `不支持的通道压缩方式 ${compression}（仅支持 0 = 原始、1 = RLE）`,
    'UNSUPPORTED_COMPRESSION',
  );
}
