/**
 * 生产模式静态托管（契约 §3.12）：
 * - GET /assets/* → 长缓存（内容哈希命名，不可变）；
 * - 其它非 /api 的 GET/HEAD → 优先命中真实文件，否则回退 index.html（SPA history 路由）；
 * - /api/* 一律放行给 API 路由，未匹配时由 404 中间件返回 JSON 信封。
 */
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Request, RequestHandler, Response } from 'express';
import type { AppContext } from './context.js';
import { badRequest, notFound } from './lib/errors.js';
import { isFile, safeJoin } from './lib/fsx.js';
import { buildEtagFromStat, matchesIfNoneMatch } from './sendFile.js';

/** 构建产物：内容哈希命名，可永久缓存 */
const ASSETS_CACHE = 'public, max-age=31536000, immutable';
/** 其它静态文件：短缓存 */
const FILE_CACHE = 'public, max-age=3600';
/** index.html 必须每次校验，保证发版后立即生效 */
const HTML_CACHE = 'no-cache';

async function sendStaticFile(req: Request, res: Response, absPath: string, cacheControl: string): Promise<void> {
  const stat = await fsp.stat(absPath);
  const etag = buildEtagFromStat({ size: stat.size, mtimeMs: stat.mtimeMs });
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('ETag', etag);
  res.setHeader('Content-Length', String(stat.size));
  res.type(path.extname(absPath) || '.html');

  if (matchesIfNoneMatch(req.get('if-none-match'), etag)) {
    res.removeHeader('Content-Length');
    res.status(304).end();
    return;
  }
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  try {
    await pipeline(createReadStream(absPath), res);
  } catch (err) {
    if (res.writableEnded || res.destroyed) return;
    throw err;
  }
}

/**
 * 取出 URL 的 pathname（已解码，去掉查询串）。
 *
 * 这里用 `req.url` 而不是 `req.originalUrl`：挂载前缀中间件（契约 §8.4）会把
 * `/psd/assets/app.js` 改写成 `/assets/app.js` 后继续，静态托管必须看到**剥离后**的
 * 路径才能在前缀之下命中真实文件与 SPA 回退（否则会被当成未知路径回退 index.html）。
 * 访问日志仍然记录原始 URL（用的是 originalUrl）。
 */
function pathnameOf(req: Request): string {
  const raw = req.url || '/';
  const withoutQuery = raw.split('?')[0] ?? '/';
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    throw badRequest('请求路径编码不合法');
  }
}

export function createStaticMiddleware(ctx: AppContext): RequestHandler {
  const { staticDir } = ctx.config;
  const indexHtml = path.join(staticDir, 'index.html');

  return async (req, res, next) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      const pathname = pathnameOf(req);
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        next();
        return;
      }
      if (pathname.includes('\0')) throw badRequest('请求路径不合法');

      const relative = pathname.replace(/^\/+/, '');

      if (pathname.startsWith('/assets/')) {
        const assetPath = safeJoin(staticDir, relative);
        if (await isFile(assetPath)) {
          await sendStaticFile(req, res, assetPath, ASSETS_CACHE);
          return;
        }
        throw notFound('静态资源不存在', { path: pathname });
      }

      if (relative !== '') {
        const directPath = safeJoin(staticDir, relative);
        if (await isFile(directPath)) {
          await sendStaticFile(req, res, directPath, FILE_CACHE);
          return;
        }
      }

      if (await isFile(indexHtml)) {
        await sendStaticFile(req, res, indexHtml, HTML_CACHE);
        return;
      }

      throw notFound('静态站点尚未构建（缺少 index.html），请先执行前端构建', { staticDir });
    } catch (err) {
      next(err);
    }
  };
}
