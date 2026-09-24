/**
 * 图片下发路由（契约 §3.9）。
 *
 * - `GET /api/projects/:id/files/image`：inline，长缓存；
 *   `?download=1` 时改为 attachment（中文文件名安全编码）；
 * - 响应头固定带 ETag / Last-Modified / Accept-Ranges / Content-Length，
 *   并支持 Range（206 / 416）与 If-None-Match（304）；
 * - v1 的 `/files/psd`、`/files/preview` 已随契约 §附录 A 一并移除，
 *   这两个路径不再注册任何路由，请求会落到 404 JSON 信封。
 *
 * 计数说明：契约 §3.9 只规定了下发行为，**统计下载次数的唯一入口是
 * `GET /api/projects/:id/go`（§3.10）**——"下载"在 v2.0 语义上指网盘下载。
 * 因此这里无论 inline 还是 `?download=1` 都不改动 stats。
 */
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import { buildEtagFromSha256, sendStoredFile } from '../sendFile.js';
import { imageRelPath } from '../storage/index.js';

/** PNG：URL 随项目 id 变化，内容不可变，可永久缓存（契约 §3.9） */
const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function isDownloadRequested(value: unknown): boolean {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string') return false;
  const normalized = text.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/** 路径参数归一化（Express 5 的 params 值可能是 string | string[]） */
function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export function createFilesRouter(ctx: AppContext): Router {
  const router = Router();

  /** GET /api/projects/:id/files/image —— 展示图 PNG 字节 */
  router.get('/:id/files/image', async (req, res) => {
    const id = routeParam(req.params.id);
    const project = await ctx.store.find(id);
    if (!project) throw notFound('项目不存在');

    const relPath = imageRelPath(id);
    const stat = await ctx.storage.stat(relPath);
    if (!stat) throw notFound('图片文件不存在或已被移除', { id, relPath });

    await sendStoredFile(req, res, {
      storage: ctx.storage,
      relPath,
      stat,
      fileName: project.image.fileName,
      contentType: 'image/png',
      disposition: isDownloadRequested(req.query.download) ? 'attachment' : 'inline',
      cacheControl: IMAGE_CACHE_CONTROL,
      // 图片字节不可变，用内容 sha256 做强 ETag；重启/重算后仍稳定
      etag: buildEtagFromSha256(project.image.sha256),
    });
  });

  return router;
}
