/**
 * 带边界检查的大端字节读取器。
 *
 * 所有整数均为大端（PSD/PSB 规范）。每次读取前都校验剩余长度，
 * 越界统一抛 {@link PsdDecodeError}（code = 'TRUNCATED'），
 * 保证解码器遇到损坏文件时既不越界也不返回半截数据。
 */
import { PsdDecodeError } from './types.ts';

export class ByteReader {
  /** 底层字节（子读取器与父读取器共享同一份） */
  readonly data: Uint8Array;
  /** 当前读取位置（绝对偏移） */
  offset: number;

  private readonly view: DataView;
  private readonly end: number;

  constructor(data: Uint8Array, start = 0, end: number = data.length, view?: DataView) {
    if (start < 0 || end > data.length || start > end) {
      throw new PsdDecodeError(`读取器区间非法：[${start}, ${end})，字节长度 ${data.length}`, 'INVALID_STRUCTURE');
    }
    this.data = data;
    this.view = view ?? new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.offset = start;
    this.end = end;
  }

  /** 本读取器可读区间的绝对结束位置 */
  get limit(): number {
    return this.end;
  }

  /** 剩余可读字节数 */
  get remaining(): number {
    return this.end - this.offset;
  }

  /** 边界检查：不足则抛 TRUNCATED */
  require(byteCount: number, what: string): void {
    if (byteCount < 0 || this.offset + byteCount > this.end) {
      throw new PsdDecodeError(
        `读取「${what}」越界：需要 ${byteCount} 字节，仅剩 ${Math.max(0, this.remaining)} 字节`,
        'TRUNCATED',
      );
    }
  }

  u8(what: string): number {
    this.require(1, what);
    return this.view.getUint8(this.offset++);
  }

  u16(what: string): number {
    this.require(2, what);
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  i16(what: string): number {
    this.require(2, what);
    const value = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return value;
  }

  u32(what: string): number {
    this.require(4, what);
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  i32(what: string): number {
    this.require(4, what);
    const value = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }

  /** 8 字节大端无符号整数（PSB 的长度字段）；超出安全整数范围直接报错 */
  u64(what: string): number {
    this.require(8, what);
    const high = this.view.getUint32(this.offset, false);
    const low = this.view.getUint32(this.offset + 4, false);
    this.offset += 8;
    const value = high * 0x1_0000_0000 + low;
    if (!Number.isSafeInteger(value)) {
      throw new PsdDecodeError(`「${what}」的 64 位长度 ${value} 超出安全整数范围`, 'INVALID_STRUCTURE');
    }
    return value;
  }

  /** 取 n 字节视图（不拷贝），并前进 n 字节 */
  bytes(byteCount: number, what: string): Uint8Array {
    this.require(byteCount, what);
    const slice = this.data.subarray(this.offset, this.offset + byteCount);
    this.offset += byteCount;
    return slice;
  }

  /** 跳过 n 字节 */
  skip(byteCount: number, what: string): void {
    this.require(byteCount, what);
    this.offset += byteCount;
  }

  /** 取一个长度为 n 的独立子读取器，并把父读取器前进 n 字节 */
  sub(byteCount: number, what: string): ByteReader {
    this.require(byteCount, what);
    const child = new ByteReader(this.data, this.offset, this.offset + byteCount, this.view);
    this.offset += byteCount;
    return child;
  }

  /** 读 4 字节 ASCII 签名（如 '8BPS' / '8BIM'） */
  ascii4(what: string): string {
    const raw = this.bytes(4, what);
    return String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  }
}
