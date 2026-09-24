/**
 * PackBits（RLE）解码。
 *
 * 规范：
 * - `n` 在 0..127：紧随其后 `n + 1` 字节原样复制；
 * - `n` 在 129..255：紧随 1 字节重复 `257 - n` 次；
 * - `n === 128`：空操作。
 *
 * 越界策略：
 * - 源数据不足 → `TRUNCATED`；
 * - 解出的字节数超过目标缓冲区 → `RLE_OVERFLOW`（绝不写出目标行之外）；
 * - 解出字节数少于目标长度是允许的（目标缓冲区已零初始化，剩余保持 0）。
 */
import { PsdDecodeError } from './types.ts';

/**
 * 把 `src[srcOffset, srcOffset + srcLength)` 的 PackBits 流解到 `dst[dstOffset, dstOffset + dstLength)`。
 * @returns 实际写入 dst 的字节数
 */
export function decodePackBits(
  src: Uint8Array,
  srcOffset: number,
  srcLength: number,
  dst: Uint8Array,
  dstOffset: number,
  dstLength: number,
): number {
  const srcEnd = srcOffset + srcLength;
  const dstEnd = dstOffset + dstLength;

  if (srcOffset < 0 || srcLength < 0 || srcEnd > src.length) {
    throw new PsdDecodeError(`PackBits 源区间越界：[${srcOffset}, ${srcEnd})，长度 ${src.length}`, 'TRUNCATED');
  }
  if (dstOffset < 0 || dstLength < 0 || dstEnd > dst.length) {
    throw new PsdDecodeError(`PackBits 目标区间越界：[${dstOffset}, ${dstEnd})，长度 ${dst.length}`, 'RLE_OVERFLOW');
  }

  let i = srcOffset;
  let o = dstOffset;

  while (i < srcEnd && o < dstEnd) {
    const header = src[i++];

    if (header === 128) continue; // 空操作

    if (header < 128) {
      const count = header + 1;
      if (i + count > srcEnd) {
        throw new PsdDecodeError(
          `PackBits 字面量段数据不足：头部声明 ${count} 字节，仅剩 ${srcEnd - i} 字节`,
          'TRUNCATED',
        );
      }
      if (o + count > dstEnd) {
        throw new PsdDecodeError(
          `PackBits 字面量段超出目标行：需要 ${o + count - dstOffset} 字节，行容量 ${dstLength} 字节`,
          'RLE_OVERFLOW',
        );
      }
      dst.set(src.subarray(i, i + count), o);
      i += count;
      o += count;
      continue;
    }

    const count = 257 - header;
    if (i >= srcEnd) {
      throw new PsdDecodeError('PackBits 游程段缺少重复字节', 'TRUNCATED');
    }
    if (o + count > dstEnd) {
      throw new PsdDecodeError(
        `PackBits 游程段超出目标行：需要 ${o + count - dstOffset} 字节，行容量 ${dstLength} 字节`,
        'RLE_OVERFLOW',
      );
    }
    dst.fill(src[i], o, o + count);
    i += 1;
    o += count;
  }

  return o - dstOffset;
}
