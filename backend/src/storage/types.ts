/**
 * 文件存储抽象：本地磁盘与对象存储共用同一份路由代码。
 * relPath 一律以 "<项目 id>/..." 形式给出，由实现决定根目录。
 */
import type { Readable } from 'node:stream';

export interface StoredFileStat {
  size: number;
  mtimeMs: number;
}

export interface ByteRange {
  /** 起始字节（含） */
  start: number;
  /** 结束字节（含） */
  end: number;
}

export interface FileStorage {
  /** 驱动名，用于日志与启动横幅 */
  readonly kind: 'local' | 's3';
  /** 保存文件：src 可以是磁盘上的临时文件（会被移动）或内存缓冲区 */
  save(relPath: string, src: string | Buffer): Promise<void>;
  /** 取文件信息，不存在返回 null */
  stat(relPath: string): Promise<StoredFileStat | null>;
  /** 打开读取流，可指定字节区间（Range 请求用） */
  createReadStream(relPath: string, range?: ByteRange): Promise<Readable>;
  /** 删除某个项目目录（前缀）下的全部文件 */
  removeDir(prefix: string): Promise<void>;
  /** 判断文件是否存在 */
  exists(relPath: string): Promise<boolean>;
  /** 启动自检（建根目录 / 校验桶） */
  ensureReady(): Promise<void>;
}
