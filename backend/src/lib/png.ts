/**
 * PNG 识别与尺寸解析（契约 §3.6 / §1.2）。
 *
 * v2.0 起唯一允许的图片格式就是 PNG：
 * - 上传时校验文件头魔数 `89 50 4E 47 0D 0A 1A 0A`（不是 PNG → 415）；
 * - 从 IHDR 读宽高填进 `ImageInfo.width/height`（读不出一律 null，不猜）。
 *
 * 注意：`src/lib/psdHeader.ts` 里也有一份同名的老实现，那是 v1 遗留模块（当前无调用方），
 * 本文件是 v2.0 生产路径唯一使用的实现。
 */

/** PNG 魔数：89 50 4E 47 0D 0A 1A 0A */
export const PNG_MAGIC: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 读取 IHDR 所需的最小字节数：8（签名）+ 8（块头）+ 8（宽高） */
const IHDR_MIN_BYTES = 24;

/** 前 8 字节是否为标准 PNG 魔数 */
export function isPngBuffer(buffer: Uint8Array | null | undefined): boolean {
  if (!buffer || buffer.length < PNG_MAGIC.length) return false;
  for (let index = 0; index < PNG_MAGIC.length; index += 1) {
    if (buffer[index] !== PNG_MAGIC[index]) return false;
  }
  return true;
}

/**
 * 从 PNG 的 IHDR 读取宽高。
 * 不足 24 字节、魔数不对、或偏移 12..16 不是 "IHDR" → null（调用方不因此报错）。
 */
export function parsePngSize(
  buffer: Uint8Array | null | undefined,
): { width: number; height: number } | null {
  if (!buffer || buffer.length < IHDR_MIN_BYTES) return null;
  if (!isPngBuffer(buffer)) return null;
  const view = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}
