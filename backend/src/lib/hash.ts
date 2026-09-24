/**
 * 内容哈希：sha256 用于去重与 ETag（流式计算，大文件不占内存）。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const SHA256_HEX_LENGTH = 64;

/** 流式计算文件 sha256，返回小写十六进制 */
export async function sha256File(absPath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

/** 计算内存缓冲区 sha256 */
export function sha256Buffer(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 是否为合法的 sha256 十六进制串 */
export function isSha256(value: string): boolean {
  return value.length === SHA256_HEX_LENGTH && /^[0-9a-f]+$/.test(value);
}
