/**
 * LocalStorage：<DATA_DIR>/projects/<id>/... 本地磁盘驱动。
 * 写入优先使用 rename（同卷原子、零拷贝），跨卷时自动退化为复制。
 */
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { atomicWriteFile, ensureDir, exists, moveFile, removeDirSafe, safeJoin, statOrNull } from '../lib/fsx.js';
import type { ByteRange, FileStorage, StoredFileStat } from './types.js';

export interface LocalStorageOptions {
  /** 存储根目录，通常为 <DATA_DIR>/projects */
  root: string;
}

export class LocalStorage implements FileStorage {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(options: LocalStorageOptions) {
    this.root = options.root;
  }

  /** relPath → 绝对路径（阻断路径逃逸） */
  absPath(relPath: string): string {
    return safeJoin(this.root, relPath);
  }

  async ensureReady(): Promise<void> {
    await ensureDir(this.root);
  }

  async save(relPath: string, src: string | Buffer): Promise<void> {
    const dest = this.absPath(relPath);
    await ensureDir(path.dirname(dest));
    if (Buffer.isBuffer(src)) {
      await atomicWriteFile(dest, src);
      return;
    }
    await moveFile(src, dest);
  }

  async stat(relPath: string): Promise<StoredFileStat | null> {
    const stat = await statOrNull(this.absPath(relPath));
    if (!stat || !stat.isFile()) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  }

  async createReadStream(relPath: string, range?: ByteRange): Promise<Readable> {
    const abs = this.absPath(relPath);
    return range
      ? createReadStream(abs, { start: range.start, end: range.end })
      : createReadStream(abs);
  }

  async removeDir(prefix: string): Promise<void> {
    await removeDirSafe(this.absPath(prefix));
  }

  async exists(relPath: string): Promise<boolean> {
    return exists(this.absPath(relPath));
  }
}
