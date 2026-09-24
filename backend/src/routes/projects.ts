/**
 * 项目管理路由（契约 §3.3 ~ §3.8、§3.10）。
 * 注意：/tags 必须注册在 /:id 之前，否则 "tags" 会被当作项目 id。
 *
 * v2.0：上传改为「PNG（image 字段）+ 网盘分享链接（netdiskUrl）」；
 * 移除 POST /:id/preview，新增 GET /:id/go（302 跳转 + 下载计数）。
 */
import path from 'node:path';
import { Router } from 'express';
import type { Request } from 'express';
import { ZodError, z } from 'zod';
import {
  DEFAULT_AUTHOR,
  EXTRACT_CODE_MAX_LENGTH,
  NETDISK_URL_MAX_LENGTH,
  SOURCE_TEXT_MAX_LENGTH,
} from '../config.js';
import type { AppContext } from '../context.js';
import type { ApiError } from '../lib/errors.js';
import { badRequest, duplicate, notFound, unsupportedMediaType } from '../lib/errors.js';
import { atomicWriteJson, readHead, removeDirSafe, removeFileSafe } from '../lib/fsx.js';
import { sha256File } from '../lib/hash.js';
import { newProjectId } from '../lib/ids.js';
import { checkNetdiskUrl, isNetdiskProvider } from '../lib/netdisk.js';
import { isPngBuffer, parsePngSize } from '../lib/png.js';
import { requireAdminToken } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { requireUploader } from '../middleware/requireUploader.js';
import { collectTempPaths, createUploaders, pickFile, requireFile } from '../middleware/upload.js';
import { imageRelPath, projectDirAbs, projectDirRel } from '../storage/index.js';
import type { ProjectUpdate } from '../store/types.js';
import type {
  ImageInfo,
  ListProjectsQuery,
  NetdiskSource,
  Project,
  ProjectStats,
  SortKey,
} from '../types.js';

/** 字段约束（契约 §1.1 / §3.6） */
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 5000;
const AUTHOR_MAX = 60;
const TAGS_MAX = 12;
const TAG_LENGTH_MAX = 24;
const PAGE_SIZE_DEFAULT = 12;
const PAGE_SIZE_MAX = 48;
/** 读取 PNG 魔数 / IHDR 的字节数 */
const PNG_HEAD_BYTES = 24;

const SORT_KEYS: readonly SortKey[] = ['newest', 'oldest', 'title', 'downloads', 'views'];

/** multipart 文本字段可能是 string（单次）或 string[]（同名字段重复） */
const textFieldSchema = z.union([z.string(), z.array(z.string())]);
/** 可空文本字段：允许显式 null（表示清空） */
const nullableTextFieldSchema = z.union([z.string(), z.array(z.string()), z.null()]);

const createFormSchema = z.object({
  title: textFieldSchema.optional(),
  description: textFieldSchema.optional(),
  author: textFieldSchema.optional(),
  tags: textFieldSchema.optional(),
  netdiskUrl: textFieldSchema.optional(),
  extractCode: nullableTextFieldSchema.optional(),
  sourceFileName: nullableTextFieldSchema.optional(),
  sourceNote: nullableTextFieldSchema.optional(),
  allowDuplicate: textFieldSchema.optional(),
});

const patchBodySchema = z.object({
  title: textFieldSchema.optional(),
  description: textFieldSchema.optional(),
  author: textFieldSchema.optional(),
  tags: textFieldSchema.optional(),
  netdiskUrl: textFieldSchema.optional(),
  extractCode: nullableTextFieldSchema.optional(),
  sourceFileName: nullableTextFieldSchema.optional(),
  sourceNote: nullableTextFieldSchema.optional(),
});

const FIELD_LABELS: Readonly<Record<string, string>> = {
  title: '标题',
  description: '说明',
  author: '作者',
  tags: '标签',
  netdiskUrl: '网盘链接',
  extractCode: '提取码',
  sourceFileName: '源文件名',
  sourceNote: '备注',
};

/** zod 结构错误 → 中文 BAD_REQUEST */
function zodToApiError(err: ZodError): ApiError {
  const issue = err.issues[0];
  const field = issue ? issue.path.map((segment) => String(segment)).join('.') : 'body';
  const label = FIELD_LABELS[field] ?? '请求参数';
  return badRequest(`${label}格式不正确`, { field, reason: `${label}必须是文本` });
}

/** 取第一个字符串值（兼容重复字段） */
function firstText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstText(item);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** 路径参数归一化（Express 5 的 params 值可能是 string | string[]） */
function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** 统计"字符数"（按 Unicode 码点，中文标题按 1 个字计） */
function charLength(value: string): number {
  return Array.from(value).length;
}

/**
 * 换行规范化：multipart 表单按规范会把值里的换行转成 CRLF，
 * 这里统一成 LF，保证「上传」与「PATCH」两条写入路径落库结果一致。
 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 是否为真值标记（"1" / "true"） */
function isTruthyFlag(value: unknown): boolean {
  const text = firstText(value)?.trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

/** 是否为"关闭"标记（"0" / "false"） */
function isFalsyFlag(value: unknown): boolean {
  const text = firstText(value)?.trim().toLowerCase();
  return text === '0' || text === 'false' || text === 'no';
}

/**
 * 标签解析：支持逗号分隔（, 与全角 ，）与同名字段重复出现两种写法，
 * 两者可混用；合并后去空、去重（保持输入顺序），每项 1..24 字符，最多 12 个。
 */
function parseTags(value: unknown, options: { allowEmpty: boolean }): string[] {
  const chunks: string[] = [];
  const push = (input: unknown): void => {
    if (typeof input === 'string') chunks.push(...input.split(/[,，]/));
    else if (Array.isArray(input)) for (const item of input) push(item);
  };
  push(value);

  const tags: string[] = [];
  for (const chunk of chunks) {
    const tag = chunk.trim();
    if (tag === '') continue;
    if (charLength(tag) > TAG_LENGTH_MAX) {
      throw badRequest(`单个标签长度不能超过 ${TAG_LENGTH_MAX} 个字符`, {
        field: 'tags',
        reason: `标签「${tag.slice(0, 32)}」过长`,
      });
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > TAGS_MAX) {
    throw badRequest(`标签数量不能超过 ${TAGS_MAX} 个`, { field: 'tags', count: tags.length });
  }
  if (tags.length === 0 && !options.allowEmpty) {
    throw badRequest('标签不能为空', { field: 'tags' });
  }
  return tags;
}

function requireText(value: unknown, field: string, label: string): string {
  const text = firstText(value);
  if (text === undefined) throw badRequest(`${label}不能为空`, { field, reason: `${label}不能为空` });
  return text;
}

function checkLength(text: string, field: string, label: string, max: number, min = 0): void {
  const length = charLength(text);
  if (length < min) {
    throw badRequest(`${label}不能为空`, { field, reason: `${label}不能为空` });
  }
  if (length > max) {
    throw badRequest(`${label}长度不能超过 ${max} 个字符`, { field, length, max });
  }
}

/**
 * 可空文本（提取码 / 源文件名 / 备注）：trim 后为空一律存 null（不存空串），
 * 超长 → 400，缺省 → null。
 */
function parseNullableText(
  value: unknown,
  field: string,
  label: string,
  max: number,
): string | null {
  if (value === null || value === undefined) return null;
  const text = (firstText(value) ?? '').trim();
  if (text === '') return null;
  if (charLength(text) > max) {
    throw badRequest(`${label}长度不能超过 ${max} 个字符`, { field, length: charLength(text), max });
  }
  return text;
}

/** 校验并归一化网盘链接，识别 provider / providerLabel（契约 §6） */
function parseNetdiskUrl(value: unknown): Pick<NetdiskSource, 'provider' | 'providerLabel' | 'url'> {
  const checked = checkNetdiskUrl(firstText(value));
  if (!checked.ok) {
    throw badRequest(`网盘链接不合法：${checked.reason}`, {
      field: 'netdiskUrl',
      reason: checked.reason,
      maxLength: NETDISK_URL_MAX_LENGTH,
    });
  }
  return { provider: checked.provider, providerLabel: checked.providerLabel, url: checked.url };
}

interface CreateFields {
  title: string;
  description: string;
  author: string;
  tags: string[];
  source: NetdiskSource;
  allowDuplicate: boolean;
}

/** 解析并校验 POST /api/projects 的表单字段 */
function parseCreateFields(body: unknown): CreateFields {
  const parsed = createFormSchema.safeParse(body ?? {});
  if (!parsed.success) throw zodToApiError(parsed.error);
  const data = parsed.data;

  const title = requireText(data.title, 'title', '标题').trim();
  checkLength(title, 'title', '标题', TITLE_MAX, 1);

  const description = normalizeNewlines(firstText(data.description) ?? '');
  checkLength(description, 'description', '说明', DESCRIPTION_MAX);

  const authorRaw = (firstText(data.author) ?? '').trim();
  checkLength(authorRaw, 'author', '作者', AUTHOR_MAX);
  const author = authorRaw === '' ? DEFAULT_AUTHOR : authorRaw;

  const tags = parseTags(data.tags, { allowEmpty: true });

  // netdiskUrl 必填：缺字段与非法链接都是 400，details.field = netdiskUrl
  if (firstText(data.netdiskUrl) === undefined) {
    throw badRequest('网盘链接不能为空', { field: 'netdiskUrl', reason: '网盘链接不能为空' });
  }
  const source: NetdiskSource = {
    ...parseNetdiskUrl(data.netdiskUrl),
    extractCode: parseNullableText(data.extractCode, 'extractCode', '提取码', EXTRACT_CODE_MAX_LENGTH),
    fileName: parseNullableText(
      data.sourceFileName,
      'sourceFileName',
      '源文件名',
      SOURCE_TEXT_MAX_LENGTH,
    ),
    note: parseNullableText(data.sourceNote, 'sourceNote', '备注', SOURCE_TEXT_MAX_LENGTH),
  };

  return { title, description, author, tags, source, allowDuplicate: isTruthyFlag(data.allowDuplicate) };
}

/** 解析并校验 PATCH /api/projects/:id 的 JSON body（未出现的字段保持不变） */
function parsePatchFields(body: unknown, existing: Project): ProjectUpdate {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('请求体必须是 JSON 对象');
  }
  const parsed = patchBodySchema.safeParse(body);
  if (!parsed.success) throw zodToApiError(parsed.error);
  const data = parsed.data;
  const patch: ProjectUpdate = {};

  if (data.title !== undefined) {
    const title = requireText(data.title, 'title', '标题').trim();
    checkLength(title, 'title', '标题', TITLE_MAX, 1);
    patch.title = title;
  }
  if (data.description !== undefined) {
    const description = normalizeNewlines(firstText(data.description) ?? '');
    checkLength(description, 'description', '说明', DESCRIPTION_MAX);
    patch.description = description;
  }
  if (data.author !== undefined) {
    const authorRaw = (firstText(data.author) ?? '').trim();
    checkLength(authorRaw, 'author', '作者', AUTHOR_MAX);
    patch.author = authorRaw === '' ? DEFAULT_AUTHOR : authorRaw;
  }
  if (data.tags !== undefined) {
    patch.tags = parseTags(data.tags, { allowEmpty: true });
  }

  // 网盘信息：任一子字段出现就整体重算，netdiskUrl 变了必须重新识别 provider / providerLabel
  const touchesSource =
    data.netdiskUrl !== undefined ||
    data.extractCode !== undefined ||
    data.sourceFileName !== undefined ||
    data.sourceNote !== undefined;
  if (touchesSource) {
    const netdisk =
      data.netdiskUrl === undefined
        ? {
            provider: existing.source.provider,
            providerLabel: existing.source.providerLabel,
            url: existing.source.url,
          }
        : parseNetdiskUrl(data.netdiskUrl);
    patch.source = {
      ...netdisk,
      extractCode:
        data.extractCode === undefined
          ? existing.source.extractCode
          : parseNullableText(data.extractCode, 'extractCode', '提取码', EXTRACT_CODE_MAX_LENGTH),
      fileName:
        data.sourceFileName === undefined
          ? existing.source.fileName
          : parseNullableText(data.sourceFileName, 'sourceFileName', '源文件名', SOURCE_TEXT_MAX_LENGTH),
      note:
        data.sourceNote === undefined
          ? existing.source.note
          : parseNullableText(data.sourceNote, 'sourceNote', '备注', SOURCE_TEXT_MAX_LENGTH),
    };
  }

  return patch;
}

/** 宽容解析列表查询参数：非法值一律回退默认，不报错 */
function parseListQuery(query: Request['query']): ListProjectsQuery {
  const q = firstText(query.q)?.trim();
  const tag = firstText(query.tag)?.trim();
  const author = firstText(query.author)?.trim();
  const providerRaw = firstText(query.provider)?.trim();

  const sortRaw = firstText(query.sort)?.trim() as SortKey | undefined;
  const sort: SortKey = sortRaw && SORT_KEYS.includes(sortRaw) ? sortRaw : 'newest';

  const pageRaw = firstText(query.page)?.trim();
  const pageParsed = pageRaw && /^\d+$/.test(pageRaw) ? Number.parseInt(pageRaw, 10) : Number.NaN;
  const page = Number.isFinite(pageParsed) && pageParsed >= 1 ? pageParsed : 1;

  const sizeRaw = firstText(query.pageSize)?.trim();
  const sizeParsed = sizeRaw && /^\d+$/.test(sizeRaw) ? Number.parseInt(sizeRaw, 10) : Number.NaN;
  const pageSize = Number.isFinite(sizeParsed)
    ? Math.min(PAGE_SIZE_MAX, Math.max(1, sizeParsed))
    : PAGE_SIZE_DEFAULT;

  const result: ListProjectsQuery = { sort, page, pageSize };
  if (q) result.q = q;
  if (tag) result.tag = tag;
  if (author) result.author = author;
  // 非法 provider（如 provider=bogus）按"不过滤"处理，与其它参数的宽容解析保持一致
  if (providerRaw && isNetdiskProvider(providerRaw)) result.provider = providerRaw;
  return result;
}

/** 组装 ImageInfo（契约 §1.2） */
function buildImageInfo(
  id: string,
  file: Express.Multer.File,
  size: number,
  sha256: string,
  pngSize: { width: number; height: number } | null,
): ImageInfo {
  return {
    fileName: file.originalname || 'image.png',
    size,
    sha256,
    width: pngSize?.width ?? null,
    height: pngSize?.height ?? null,
    url: `/api/projects/${id}/files/image`,
    downloadUrl: `/api/projects/${id}/files/image?download=1`,
  };
}

/**
 * 作者名归属（契约 §8.3）：登录令牌通过校验时，author **强制**取令牌里的 cn，
 * 完全忽略表单里的同名（以及重复出现的）字段 —— 这样"以用户名为作者名"不可伪造。
 * 自动化旁路（x-upload-token）与本地降级放行则保留表单里的 author。
 */
function applyUploaderAuthor(fields: CreateFields, req: Request): void {
  const uploader = req.uploader;
  if (!uploader || uploader.via !== 'login') return;
  const cn = uploader.cn;
  if (!cn) return;
  if (charLength(cn) > AUTHOR_MAX) {
    throw badRequest(`登录用户名长度超过 ${AUTHOR_MAX} 个字符，无法作为作者名`, {
      field: 'author',
      source: 'token.cn',
    });
  }
  fields.author = cn;
}

/**
 * 完整的新建流程：校验 → sha256 去重 → 落盘 → meta.json → 写库。
 * 任一步失败都删除已写入的项目目录（回滚），临时文件由调用方 finally 清理。
 */
async function createProjectFromUpload(ctx: AppContext, req: Request): Promise<Project> {
  const imageFile = requireFile(
    pickFile(req.files, 'image'),
    'image',
    '缺少展示图 PNG 文件（表单字段名应为 image）',
  );
  const fields = parseCreateFields(req.body);
  // 写库前覆盖 author：认证身份说了算，表单说了不算
  applyUploaderAuthor(fields, req);

  // 1) 文件头校验：只读头部字节，不整文件载入内存
  const head = await readHead(imageFile.path, PNG_HEAD_BYTES);
  if (!isPngBuffer(head)) {
    throw unsupportedMediaType('展示图文件头不合法：前 8 字节必须是标准 PNG 魔数', {
      field: 'image',
    });
  }
  const pngSize = parsePngSize(head);

  // 2) sha256 去重（基于 PNG 字节；契约 §3.6 第 3 步）
  const sha256 = await sha256File(imageFile.path);
  if (!fields.allowDuplicate) {
    const existing = await ctx.store.sha256Exists(sha256);
    if (existing) {
      throw duplicate('该 PNG 已存在（内容 sha256 相同）', { existingId: existing.id, sha256 });
    }
  }

  // 3) 落盘：projects/<id>/image.png + meta.json，再写 db.json，失败回滚目录
  const id = newProjectId();
  const dirAbs = projectDirAbs(ctx.config, id);
  try {
    const imageRel = imageRelPath(id);
    await ctx.storage.save(imageRel, imageFile.path);
    const stat = await ctx.storage.stat(imageRel);

    const now = new Date().toISOString();
    const image = buildImageInfo(id, imageFile, stat?.size ?? imageFile.size, sha256, pngSize);
    const stats: ProjectStats = { views: 0, downloads: 0 };
    const item: Project = {
      id,
      title: fields.title,
      description: fields.description,
      author: fields.author,
      tags: fields.tags,
      createdAt: now,
      updatedAt: now,
      image,
      source: fields.source,
      stats,
    };

    await atomicWriteJson(path.join(dirAbs, 'meta.json'), item);
    return await ctx.store.create(item);
  } catch (err) {
    await removeDirSafe(dirAbs);
    throw err;
  }
}

export function createProjectsRouter(ctx: AppContext): Router {
  const router = Router();
  const uploaders = createUploaders(ctx);
  /** 上传类接口使用更严格的独立限流 */
  const uploadLimiter = createRateLimiter({
    windowMs: ctx.config.rateLimitWindowMs,
    max: ctx.config.uploadRateLimitMax,
    name: 'upload',
  });

  /** GET /api/projects —— 列表（搜索/过滤/排序/分页） */
  router.get('/', async (req, res) => {
    const query = parseListQuery(req.query);
    const page = await ctx.store.list(query);
    res.json(page);
  });

  /** GET /api/projects/tags —— 标签聚合（必须早于 /:id 注册） */
  router.get('/tags', async (_req, res) => {
    const tags = await ctx.store.allTags();
    res.json({ tags });
  });

  /**
   * GET /api/projects/:id/go —— 跳转到网盘链接（契约 §3.10）
   * 302 + Location: source.url，并把 stats.downloads +1 落库。
   * 必须带 Cache-Control: no-store，否则中间层缓存跳转会让计数失真。
   */
  router.get('/:id/go', async (req, res) => {
    const id = routeParam(req.params.id);
    const existing = await ctx.store.find(id);
    if (!existing) throw notFound('项目不存在');

    await ctx.store.incrementStats(id, { downloads: 1 });

    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, existing.source.url);
  });

  /** GET /api/projects/:id —— 详情（默认计一次浏览） */
  router.get('/:id', async (req, res) => {
    const id = routeParam(req.params.id);
    const existing = await ctx.store.find(id);
    if (!existing) throw notFound('项目不存在');

    const shouldCount = !isFalsyFlag(req.query.count);
    if (!shouldCount) {
      res.json({ item: existing });
      return;
    }
    const updated = await ctx.store.incrementStats(id, { views: 1 });
    res.json({ item: updated ?? existing });
  });

  /**
   * POST /api/projects —— 新建项目（multipart：image + netdiskUrl + title + ...）
   * v2.1：鉴权走 requireUploader（上传令牌旁路 / 主站登录令牌，契约 §8.3）。
   */
  router.post('/', uploadLimiter, requireUploader(ctx), uploaders.fields, async (req, res) => {
    const tempPaths = collectTempPaths(req.files);
    try {
      const item = await createProjectFromUpload(ctx, req);
      res.status(201).json({ item });
    } finally {
      // 校验失败/超限/写库失败都不留临时垃圾
      await Promise.all(tempPaths.map((tempPath) => removeFileSafe(tempPath)));
    }
  });

  /** PATCH /api/projects/:id —— 修改文本字段与网盘信息（契约 §3.7） */
  router.patch('/:id', requireAdminToken(ctx), async (req, res) => {
    const id = routeParam(req.params.id);
    const existing = await ctx.store.find(id);
    if (!existing) throw notFound('项目不存在');

    const patch = parsePatchFields(req.body, existing);
    const item = await ctx.store.update(id, patch);
    if (!item) throw notFound('项目不存在');
    res.json({ item });
  });

  /** DELETE /api/projects/:id —— 删除项目（幂等，始终 204） */
  router.delete('/:id', requireAdminToken(ctx), async (req, res) => {
    const id = routeParam(req.params.id);
    await ctx.store.remove(id);
    await ctx.storage.removeDir(projectDirRel(id));
    res.status(204).end();
  });

  return router;
}
