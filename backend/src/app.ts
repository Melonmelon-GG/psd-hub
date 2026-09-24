/**
 * createApp：装配中间件与路由，但**不** listen（便于测试注入随机端口）。
 *
 * 中间件顺序：挂载前缀（§8.4）→ requestId → 安全头 → 访问日志 → CORS → JSON 解析 → 限流
 *            → 业务路由 → （可选）静态托管 → 404 → 统一错误处理。
 */
import cors from 'cors';
import type { CorsOptions } from 'cors';
import express from 'express';
import type { Express, RequestHandler } from 'express';
import type { AppConfig } from './config.js';
import type { AppContext } from './context.js';
import { createErrorHandler, notFoundHandler } from './middleware/errors.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { getRequestId, requestIdMiddleware } from './middleware/requestId.js';
import { securityHeaders } from './middleware/security.js';
import { mountApi } from './routes/index.js';
import { createStaticMiddleware } from './static.js';

/** JSON 请求体上限（PATCH 只改元数据，1MB 足够） */
const JSON_BODY_LIMIT = '1mb';

/** CORS：允许的请求头与需要暴露给前端的响应头（契约 §0.3 / §3.10） */
export const CORS_ALLOWED_HEADERS: readonly string[] = [
  'Content-Type',
  'Authorization',
  'x-upload-token',
  'x-admin-token',
];

export const CORS_EXPOSED_HEADERS: readonly string[] = [
  'Content-Disposition',
  'Content-Range',
  'Accept-Ranges',
  'ETag',
  'x-request-id',
];

function createCorsOptions(config: AppConfig): CorsOptions {
  return {
    // '*' = 通配；否则使用逗号分隔白名单
    origin: config.corsOrigins === '*' ? '*' : config.corsOrigins,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    credentials: false,
    maxAge: 86400,
  };
}

/** 访问日志：请求结束后记录一行，5xx 记 error、4xx 记 warn */
function accessLogger(ctx: AppContext): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        requestId: getRequestId(res),
        method: req.method,
        path: (req.originalUrl || req.url || '').split('?')[0],
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        ip: req.ip ?? '',
      };
      if (res.statusCode >= 500) ctx.logger.error('请求处理失败', fields);
      else if (res.statusCode >= 400) ctx.logger.warn('请求被拒绝', fields);
      else ctx.logger.info('请求完成', fields);
    });
    next();
  };
}

/**
 * 挂载前缀（契约 §8.4）：为与主站同源部署在 `https://7thcv.cn/psd/` 而支持。
 * - `/psd/api/projects` → 剥掉前缀，改写成 `/api/projects` 后继续走原有路由；
 * - `/psd`（无尾斜杠）→ 302 到 `/psd/`，避免相对路径解析错位；
 * - `/` → 302 到 `/psd/`；
 * - 未配置 MOUNT_PREFIX 时本中间件完全不存在（行为与 v2.0 一致）。
 *
 * 必须挂在**最外层**（其它中间件之前），这样日志里保留的仍是原始 URL，
 * 而下游路由看到的已是剥离后的路径，静态托管与 SPA 回退自然同样落在前缀之下。
 */
export function createMountPrefixMiddleware(mountPrefix: string): RequestHandler {
  if (mountPrefix === '') {
    return (_req, _res, next) => next();
  }
  const prefixedRoot = `${mountPrefix}/`;

  return (req, res, next) => {
    const url = req.url || '/';
    const queryIndex = url.indexOf('?');
    const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);

    // 正好是前缀本身（无尾斜杠）→ 补上尾斜杠再进 SPA
    if (pathname === mountPrefix) {
      res.redirect(302, prefixedRoot);
      return;
    }
    if (pathname.startsWith(prefixedRoot)) {
      const rest = url.slice(mountPrefix.length);
      req.url = rest === '' ? '/' : rest;
      next();
      return;
    }
    // 根路径 → 送到前缀下（查询串一并保留）
    if (pathname === '/') {
      const query = queryIndex === -1 ? '' : url.slice(queryIndex);
      res.redirect(302, `${prefixedRoot}${query}`);
      return;
    }
    // 其它不带前缀的路径原样放行：交给路由/静态中间件按原有规则处理
    next();
  };
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  if (ctx.config.trustProxy !== false) {
    app.set('trust proxy', ctx.config.trustProxy);
  }

  app.use(createMountPrefixMiddleware(ctx.config.mountPrefix));
  app.use(requestIdMiddleware());
  app.use(securityHeaders());
  app.use(accessLogger(ctx));
  // 供错误中间件生成"超过体积上限（20 MB）"这类提示
  app.use((_req, res, next) => {
    res.locals.maxUploadLabel = ctx.config.maxUploadLabel;
    next();
  });
  app.use(cors(createCorsOptions(ctx.config)));

  app.use('/api', express.json({ limit: JSON_BODY_LIMIT }));
  app.use(
    '/api',
    createRateLimiter({
      windowMs: ctx.config.rateLimitWindowMs,
      max: ctx.config.rateLimitMax,
      name: 'global',
    }),
  );
  app.use('/api', mountApi(ctx));

  if (ctx.config.serveStatic) {
    app.use(createStaticMiddleware(ctx));
  }

  app.use(notFoundHandler());
  app.use(createErrorHandler(ctx.logger));
  return app;
}
