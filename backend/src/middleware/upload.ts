/**
 * 上传中间件：multer diskStorage → <DATA_DIR>/tmp。
 * - 体积上限 maxUploadBytes（默认 20MB，超出由 multer 抛 LIMIT_FILE_SIZE → 统一映射为 413）；
 * - 字段白名单只有 `image`（v2.0 起不再接受 psd/preview），扩展名仅 `.png`，否则 415；
 * - 字段数/文件数/文本字段体积均有上限，防止 multipart 滥用。
 * 临时文件由路由层在 finally 中清理，校验失败/超限都不留垃圾。
 */
import path from 'node:path';
import multer from 'multer';
import type { RequestHandler } from 'express';
import { IMAGE_EXTENSIONS } from '../config.js';
import type { AppContext } from '../context.js';
import { badRequest, unsupportedMediaType } from '../lib/errors.js';
import { ensureDir } from '../lib/fsx.js';
import { newTempSuffix } from '../lib/ids.js';

export interface Uploaders {
  /** POST /api/projects：image 必填（唯一允许的文件字段） */
  fields: RequestHandler;
  /** 临时目录绝对路径 */
  tmpDir: string;
}

/** 只保留安全扩展名，避免临时文件名被原始名污染 */
function safeExtension(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export function createUploaders(ctx: AppContext): Uploaders {
  const { maxUploadBytes, tmpDir } = ctx.config;

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir(tmpDir).then(
        () => cb(null, tmpDir),
        (err: unknown) => cb(err as Error, tmpDir),
      );
    },
    filename: (_req, file, cb) => {
      cb(null, `${Date.now().toString(36)}-${newTempSuffix()}${safeExtension(file.originalname)}`);
    },
  });

  const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
    // 未知字段（如 v1 的 psd/preview）在 multer 内部就被拦成 LIMIT_UNEXPECTED_FILE → 400，
    // 这里的 else 只是防御性兜底。
    if (file.fieldname !== 'image') {
      cb(badRequest(`不支持的上传字段：${file.fieldname}`, { field: file.fieldname }));
      return;
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
      cb(null, true);
      return;
    }
    cb(
      unsupportedMediaType('展示图必须是 PNG 文件（扩展名 .png）', {
        field: 'image',
        fileName: file.originalname,
        allowed: [...IMAGE_EXTENSIONS],
      }),
    );
  };

  const baseOptions: multer.Options = {
    storage,
    fileFilter,
    // busboy 默认按 latin1 解析 multipart 头里的 filename，中文文件名会变成乱码，
    // 显式声明 UTF-8 才能正确保留「深色UI稿.png」这类名字。
    defParamCharset: 'utf8',
    limits: {
      fileSize: maxUploadBytes,
      files: 2,
      fields: 20,
      fieldNameSize: 100,
      fieldSize: 200 * 1024,
      parts: 24,
    },
  };

  const upload = multer(baseOptions);

  return {
    fields: upload.fields([{ name: 'image', maxCount: 1 }]),
    tmpDir,
  };
}

/** 从 req.files 中取出指定字段的文件（multer.fields 形态） */
export function pickFile(
  files: Express.Multer.File[] | { [field: string]: Express.Multer.File[] } | undefined,
  field: string,
): Express.Multer.File | null {
  if (!files || Array.isArray(files)) return null;
  const list = files[field];
  if (!list || list.length === 0) return null;
  return list[0] ?? null;
}

/** 收集本次请求产生的全部临时文件路径（清理用） */
export function collectTempPaths(
  files: Express.Multer.File[] | { [field: string]: Express.Multer.File[] } | undefined,
): string[] {
  if (!files) return [];
  const list = Array.isArray(files) ? files : Object.values(files).flat();
  return list.filter((file): file is Express.Multer.File => Boolean(file?.path)).map((file) => file.path);
}

/** 缺少必填文件时的统一报错 */
export function requireFile(file: Express.Multer.File | null, field: string, message: string): Express.Multer.File {
  if (!file) throw badRequest(message, { field });
  return file;
}
