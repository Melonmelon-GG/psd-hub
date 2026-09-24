/**
 * 统一文件下发助手（契约 §3.10 / §3.11）：
 * - 手动实现单区间 Range：bytes=start-end / bytes=start- / bytes=-suffix → 206 + Content-Range；
 *   越界 → 416 + Content-Range: bytes * /size；
 * - ETag（sha256 前 16 字节或 size-mtime）+ If-None-Match → 304；
 * - 始终回写 Accept-Ranges / Content-Length / Last-Modified；
 * - Content-Disposition 同时给 ASCII 回退名与 filename*=UTF-8''（中文名安全）。
 */
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import type { FileStorage, StoredFileStat } from './storage/types.js';

export type FileDisposition = 'inline' | 'attachment';

export interface SendStoredFileOptions {
  storage: FileStorage;
  /** 存储驱动内的相对路径 */
  relPath: string;
  stat: StoredFileStat;
  /** 原始文件名（可含中文） */
  fileName: string;
  contentType: string;
  disposition: FileDisposition;
  cacheControl: string;
  etag: string;
}

export interface SendResult {
  status: number;
  /** 实际发送的字节数（304/416 为 0） */
  bytesSent: number;
}

export type RangeParseResult =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/** ETag：sha256 前 16 字节（32 个十六进制字符），强校验 */
export function buildEtagFromSha256(sha256: string): string {
  return `"${sha256.slice(0, 32)}"`;
}

/** ETag：内容不可哈希时退化为 size-mtime（预览图用） */
export function buildEtagFromStat(stat: StoredFileStat): string {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/**
 * 单个字节区间解析。
 * 语法不支持（多区间/非法写法）→ none（按 RFC 忽略 Range，回整文件 200）；
 * 语法合法但越界 → unsatisfiable（416）。
 */
export function parseRangeHeader(header: string | undefined, size: number): RangeParseResult {
  if (!header) return { kind: 'none' };
  const value = header.trim();
  if (!/^bytes=/i.test(value)) return { kind: 'none' };
  const spec = value.slice('bytes='.length).trim();
  if (spec.includes(',')) return { kind: 'none' }; // 多区间不支持，忽略
  const matched = /^(\d*)-(\d*)$/.exec(spec);
  if (!matched) return { kind: 'none' };
  const [, rawStart = '', rawEnd = ''] = matched;
  if (rawStart === '' && rawEnd === '') return { kind: 'none' };

  if (rawStart === '') {
    // bytes=-N：最后 N 字节
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    if (size === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - suffix);
    return { kind: 'range', start, end: size - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start)) return { kind: 'none' };
  if (start >= size) return { kind: 'unsatisfiable' };
  const requestedEnd = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
  if (!Number.isFinite(requestedEnd)) return { kind: 'none' };
  if (requestedEnd < start) return { kind: 'none' };
  const end = Math.min(requestedEnd, Math.max(size - 1, 0));
  return { kind: 'range', start, end };
}

/** If-None-Match 匹配（支持 *、多值与弱比较） */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const value = header.trim();
  if (value === '*') return true;
  const normalize = (input: string): string => input.trim().replace(/^W\//i, '');
  const target = normalize(etag);
  return value
    .split(',')
    .map((part) => normalize(part))
    .some((part) => part === target);
}

/**
 * Content-Disposition：
 * 中文/非 ASCII 文件名无法放进 filename=，故同时输出 ASCII 回退名与 filename*=UTF-8''...
 */
export function buildContentDisposition(disposition: FileDisposition, fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** 下发文件（自动处理 Range / 条件请求 / HEAD） */
export async function sendStoredFile(
  req: Request,
  res: Response,
  options: SendStoredFileOptions,
): Promise<SendResult> {
  const { stat, etag } = options;
  const size = stat.size;

  res.setHeader('Content-Type', options.contentType);
  res.setHeader('Cache-Control', options.cacheControl);
  res.setHeader('Content-Disposition', buildContentDisposition(options.disposition, options.fileName));
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
  res.setHeader('Accept-Ranges', 'bytes');

  if (matchesIfNoneMatch(req.get('if-none-match'), etag)) {
    res.removeHeader('Content-Length');
    res.removeHeader('Content-Disposition');
    res.status(304).end();
    return { status: 304, bytesSent: 0 };
  }

  const range = parseRangeHeader(req.get('range'), size);
  if (range.kind === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.removeHeader('Content-Disposition');
    // 416 也是错误信封，Content-Type 必须回到 application/json
    res.removeHeader('Content-Type');
    res.status(416).json({
      error: {
        code: 'BAD_REQUEST',
        message: '请求的字节范围无效',
        details: { range: req.get('range') ?? '', size },
      },
    });
    return { status: 416, bytesSent: 0 };
  }

  const start = range.kind === 'range' ? range.start : 0;
  const end = range.kind === 'range' ? range.end : Math.max(size - 1, 0);
  const bytesSent = size === 0 ? 0 : end - start + 1;

  if (range.kind === 'range') {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else {
    res.status(200);
  }
  res.setHeader('Content-Length', String(bytesSent));

  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return { status: res.statusCode, bytesSent: 0 };
  }

  const stream = await options.storage.createReadStream(
    options.relPath,
    range.kind === 'range' ? { start, end } : undefined,
  );

  try {
    await pipeline(stream, res);
  } catch (err) {
    // 客户端中断下载（abort）不该冒泡成 500 日志
    if (res.writableEnded || res.destroyed) return { status: res.statusCode, bytesSent };
    throw err;
  }
  return { status: res.statusCode, bytesSent };
}
