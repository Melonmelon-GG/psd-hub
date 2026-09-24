/**
 * 文件系统小工具：目录创建、原子写、安全路径拼接、体积格式化等。
 * 所有写操作都做 Windows 友好的容错（EPERM/EBUSY 重试）。
 */
import { createReadStream, createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { badRequest } from './errors.js';
import { newTempSuffix } from './ids.js';

/** 递归创建目录（幂等） */
export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

/** 判断路径是否存在 */
export async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** stat，失败返回 null */
export async function statOrNull(target: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

/** 是否为普通文件 */
export async function isFile(target: string): Promise<boolean> {
  const stat = await statOrNull(target);
  return stat !== null && stat.isFile();
}

/** Windows 上重命名可能被索引/杀软短暂占用，做有限重试 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!retryable || attempt >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

/** 删除文件，忽略不存在 */
export async function removeFileSafe(filePath: string): Promise<void> {
  try {
    await fsp.rm(filePath, { force: true });
  } catch {
    /* 忽略：临时文件清理不应影响主流程 */
  }
}

/**
 * 原子写文件：临时文件 → fsync → rename 覆盖。
 * 同目录写临时文件保证 rename 是同卷操作（原子）。
 */
export async function atomicWriteFile(filePath: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${newTempSuffix()}.tmp`;
  const handle = await fsp.open(tmpPath, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmpPath, filePath);
  } catch (err) {
    await removeFileSafe(tmpPath);
    throw err;
  }
}

/** 原子写 JSON（默认 2 空格缩进，便于人工排查） */
export async function atomicWriteJson(
  filePath: string,
  data: unknown,
  options: { pretty?: boolean } = {},
): Promise<void> {
  const pretty = options.pretty ?? true;
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  await atomicWriteFile(filePath, text);
}

/** 递归删除目录（幂等，忽略错误） */
export async function removeDirSafe(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* 忽略：回滚/清理失败不应掩盖原始异常 */
  }
}

/** 字节数 → 人类可读（512 * 1024 * 1024 → "512 MB"） */
export function humanBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

/**
 * 安全拼接：确保结果仍位于 base 之内，阻断 ../ 与绝对路径逃逸。
 */
export function safeJoin(base: string, ...segments: string[]): string {
  const root = path.resolve(base);
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw badRequest('非法的路径参数', { reason: '路径越界' });
  }
  return target;
}

/** 读取文件头部若干字节（用于魔数校验，避免整文件读入内存） */
export async function readHead(filePath: string, bytes: number): Promise<Buffer> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 移动文件：优先 rename（同卷原子），跨卷时退化为 复制 + 删除。
 */
export async function moveFile(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to));
  try {
    await renameWithRetry(from, to);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM') throw err;
  }
  await pipeline(createReadStream(from), createWriteStream(to));
  await removeFileSafe(from);
}
