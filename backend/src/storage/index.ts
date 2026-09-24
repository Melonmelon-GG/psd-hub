/**
 * 存储工厂 + 落盘布局助手（契约 §4）。
 * 布局：<DATA_DIR>/projects/<id>/{image.png, meta.json}
 * v2.0 起不再有 original.psd / preview.png。
 */
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import type { FileStorage } from './types.js';

/** 项目存储根目录（本地驱动） */
export function projectsRoot(config: AppConfig): string {
  return path.join(config.dataDir, 'projects');
}

/** 项目目录绝对路径（用于 meta.json 与回滚清理） */
export function projectDirAbs(config: AppConfig, id: string): string {
  return path.join(projectsRoot(config), id);
}

/** 项目目录相对路径（用于 storage.removeDir） */
export function projectDirRel(id: string): string {
  return `${id}/`;
}

/** 展示图相对路径：projects/<id>/image.png（v2.0 唯一的数据文件） */
export function imageRelPath(id: string): string {
  return `${id}/image.png`;
}

export type { FileStorage };

/** 按配置创建存储驱动（默认 local） */
export function createStorage(config: AppConfig, logger: Logger): FileStorage {
  if (config.storageDriver === 's3') {
    if (!config.s3.bucket) {
      throw new Error('STORAGE_DRIVER=s3 时必须配置 S3_BUCKET');
    }
    return new S3Storage({
      bucket: config.s3.bucket,
      region: config.s3.region,
      endpoint: config.s3.endpoint,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
      forcePathStyle: config.s3.forcePathStyle,
      logger,
    });
  }
  return new LocalStorage({ root: projectsRoot(config) });
}
