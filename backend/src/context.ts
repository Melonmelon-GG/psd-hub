/**
 * 应用上下文：把配置、数据仓库、文件存储、日志四件套注入到 app 与路由，
 * 便于测试时替换为临时目录 / 内存实现。
 */
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import type { ProjectStore } from './store/types.js';
import type { FileStorage } from './storage/types.js';

export interface AppContext {
  config: AppConfig;
  store: ProjectStore;
  storage: FileStorage;
  logger: Logger;
  /** 进程/应用启动时间戳（用于 uptimeMs） */
  startedAt: number;
}
