/**
 * 进程入口：loadConfig → 建目录 → createApp → listen → 优雅关闭。
 *
 * 优雅关闭：SIGINT/SIGTERM 后停止接收新连接、等待在途请求，
 * 超过 10s 强制断开剩余连接并退出。
 */
import path from 'node:path';
import type { Server } from 'node:http';
import { config as loadDotenv } from 'dotenv';
import type { Express } from 'express';
import { createApp } from './app.js';
import { APP_NAME, APP_VERSION, loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { ensureDir, isFile } from './lib/fsx.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import { JsonProjectStore } from './store/jsonStore.js';
import { createStorage } from './storage/index.js';

// .env 只补充未设置的环境变量，不覆盖真实环境（生产用真实环境变量更优先）；
// quiet 关掉 dotenv 自带的广告行，保持启动日志干净
loadDotenv({ quiet: true });

/** 优雅关闭超时（毫秒） */
const SHUTDOWN_TIMEOUT_MS = 10000;

function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(port, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/** 启动横幅：令牌只显示"已启用/未启用"，绝不打印令牌值 */
function printBanner(ctx: AppContext, server: Server, logger: Logger): void {
  const { config } = ctx;
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? `${address.address}:${address.port}` : String(address);
  const lines = [
    '='.repeat(66),
    ` ${APP_NAME} v${APP_VERSION} 已启动`,
    ` 监听地址   : http://${config.host}:${config.port}（实际绑定 ${bound}）`,
    ' API 前缀   : /api',
    ` DATA_DIR   : ${config.dataDir}`,
    ` 上传上限   : ${config.maxUploadLabel}`,
    ` 存储驱动   : ${config.storageDriver}`,
    ` 静态托管   : ${config.serveStatic ? `已开启（${config.staticDir}）` : '未开启'}`,
    ` 上传令牌   : ${config.uploadToken ? '已启用' : '未启用'}`,
    ` 管理令牌   : ${config.adminToken ? '已启用' : '未启用'}`,
    ` 主站登录   : ${
      config.mainSiteBaseUrl
        ? `已启用（${config.mainSiteBaseUrl}${config.mainSiteVerifyPath}）`
        : '未启用（上传仅认 x-upload-token）'
    }`,
    ` 挂载前缀   : ${config.mountPrefix === '' ? '（无，挂在根路径）' : config.mountPrefix}`,
    ` 限流       : 全局 ${config.rateLimitMax} 次/${config.rateLimitWindowMs}ms，上传 ${config.uploadRateLimitMax} 次/${config.rateLimitWindowMs}ms，登录 ${config.loginRateLimitMax} 次/${config.rateLimitWindowMs}ms`,
    ` 运行环境   : ${config.nodeEnv}`,
    '='.repeat(66),
  ];
  logger.info(lines.join('\n'));
}

/**
 * 退出前让出一次事件循环：管道模式下 stdout/stderr 是异步写，
 * 立刻 process.exit 可能截断最后一行日志。
 */
function flushThenExit(code: number): void {
  process.exitCode = code;
  const timer = setTimeout(() => process.exit(code), 50);
  timer.unref();
}

/** 注册信号处理与全局异常兜底 */
function registerShutdown(ctx: AppContext, server: Server): void {
  let closing = false;

  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    ctx.logger.info(`收到 ${signal}，停止接收新连接并等待在途请求…`);

    const forceTimer = setTimeout(() => {
      ctx.logger.warn(`优雅关闭超时（${SHUTDOWN_TIMEOUT_MS / 1000}s），强制断开剩余连接并退出`);
      server.closeAllConnections();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    // 关闭空闲 keep-alive 连接，避免它们在 close() 上无限等待
    server.closeIdleConnections();
    server.close((err) => {
      clearTimeout(forceTimer);
      if (err) {
        ctx.logger.error('HTTP 服务关闭时发生异常', { err });
        flushThenExit(1);
        return;
      }
      ctx.logger.info('HTTP 服务已关闭，进程退出');
      flushThenExit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    ctx.logger.error('未处理的 Promise 拒绝', { err: reason });
  });
  process.on('uncaughtException', (err) => {
    ctx.logger.error('未捕获的异常', { err });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, pretty: !config.isProduction });

  // 启动即建目录：DATA_DIR 与 multer 临时目录
  await ensureDir(config.dataDir);
  await ensureDir(config.tmpDir);

  const store = new JsonProjectStore({ file: path.join(config.dataDir, 'db.json'), logger });
  await store.init();

  const storage = createStorage(config, logger);
  await storage.ensureReady();

  const ctx: AppContext = { config, store, storage, logger, startedAt: Date.now() };
  const app = createApp(ctx);

  if (config.serveStatic && !(await isFile(path.join(config.staticDir, 'index.html')))) {
    logger.warn('SERVE_STATIC=true 但静态目录缺少 index.html，页面访问将返回 404', {
      staticDir: config.staticDir,
    });
  }

  const server = await listen(app, config.port, config.host);
  printBanner(ctx, server, logger);
  registerShutdown(ctx, server);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[psd-hub-api] 启动失败：${message}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
