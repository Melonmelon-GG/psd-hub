/**
 * 表单字段的本地校验，规则与契约 **v2.0** §3.6 保持一致：
 *   image          必填；扩展名 .png，且**读得到文件头时必须命中 PNG 魔数**
 *   netdiskUrl     必填；`http://` / `https://` 开头，长度 ≤ netdiskUrlMaxLength（默认 500）
 *   extractCode    0..16
 *   sourceFileName 0..200
 *   sourceNote     0..200
 *   title          trim 后 1..120
 *   description    0..5000
 *   author         0..60（空则由后端写 "匿名作者"）
 *   tags           0..12 个，每个 1..24 字符，去重后按输入顺序
 * 返回的中文错误信息可直接展示。
 *
 * 说明：文件头（PNG 魔数）只是**提前告知**用户选错了文件，
 * 最终的扩展名/文件头判定仍以服务端为准（契约 §3.6 第 2 步，失败返回 415）。
 */

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 5000;
export const AUTHOR_MAX = 60;
export const TAGS_MAX_COUNT = 12;
export const TAG_MAX_LENGTH = 24;

/** 契约 §3.6：extractCode 0..16 */
export const DEFAULT_EXTRACT_CODE_MAX = 16;
/** 契约 §3.6：netdiskUrl 长度 ≤ 500 */
export const DEFAULT_NETDISK_URL_MAX = 500;
/** 契约 §3.6：sourceFileName 0..200 */
export const SOURCE_FILE_NAME_MAX = 200;
/** 契约 §3.6：sourceNote 0..200 */
export const SOURCE_NOTE_MAX = 200;

/** v2.0 仅接受 PNG（后端 GET /api/config 的 acceptedImageExtensions 为权威值） */
export const ALLOWED_IMAGE_EXTENSIONS = ['.png'] as const;

/** 默认上传体积上限（契约 §3.2 默认 20 MB；后端 GET /api/config 会给出真实值） */
export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 标准 PNG 文件头魔数：89 50 4E 47 0D 0A 1A 0A */
export const PNG_MAGIC_BYTES: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 只取文件名的文件（便于单测传入普通对象） */
export type NamedFileLike = Pick<File, 'name' | 'size'>;
/** 带 MIME 的文件 */
export type TypedFileLike = Pick<File, 'name' | 'size' | 'type'>;
/** 能切片的文件（读文件头用） */
export type SliceableFileLike = Pick<File, 'slice'>;

export interface FieldErrors {
  image?: string;
  netdiskUrl?: string;
  extractCode?: string;
  sourceFileName?: string;
  sourceNote?: string;
  title?: string;
  description?: string;
  author?: string;
  tags?: string;
}

/** 按 UTF-16 码元计数（与后端 JS 实现的 length 一致） */
export function charLength(value: string): number {
  return value.length;
}

/** 单个字段的校验结果 */
export interface FieldCheck {
  ok: boolean;
  /** 出错时的中文提示 */
  message?: string;
}

/* ============================== 文本字段 ============================== */

/** 标题：trim 后必填，1..120 */
export function validateTitle(value: string): FieldCheck {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: '标题不能为空' };
  if (trimmed.length > TITLE_MAX) {
    return { ok: false, message: `标题最多 ${TITLE_MAX} 个字符，当前 ${trimmed.length} 个` };
  }
  return { ok: true };
}

/** 说明：0..5000，允许换行 */
export function validateDescription(value: string): FieldCheck {
  if (value.length > DESCRIPTION_MAX) {
    return { ok: false, message: `说明最多 ${DESCRIPTION_MAX} 个字符，当前 ${value.length} 个` };
  }
  return { ok: true };
}

/** 作者：0..60（可留空，后端会写 "匿名作者"） */
export function validateAuthor(value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed.length > AUTHOR_MAX) {
    return { ok: false, message: `作者最多 ${AUTHOR_MAX} 个字符，当前 ${trimmed.length} 个` };
  }
  return { ok: true };
}

/** 提取码：trim 后 0..16（空则由后端存 null） */
export function validateExtractCode(
  value: string,
  options: { maxLength?: number } = {},
): FieldCheck {
  const max = options.maxLength ?? DEFAULT_EXTRACT_CODE_MAX;
  const trimmed = value.trim();
  if (trimmed.length > max) {
    return { ok: false, message: `提取码最多 ${max} 个字符，当前 ${trimmed.length} 个` };
  }
  return { ok: true };
}

/** 网盘里的源文件名：trim 后 0..200（空则由后端存 null） */
export function validateSourceFileName(value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed.length > SOURCE_FILE_NAME_MAX) {
    return {
      ok: false,
      message: `源文件名最多 ${SOURCE_FILE_NAME_MAX} 个字符，当前 ${trimmed.length} 个`,
    };
  }
  return { ok: true };
}

/** 网盘备注：0..200（空则由后端存 null） */
export function validateSourceNote(value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed.length > SOURCE_NOTE_MAX) {
    return { ok: false, message: `备注最多 ${SOURCE_NOTE_MAX} 个字符，当前 ${trimmed.length} 个` };
  }
  return { ok: true };
}

/**
 * 标签解析：支持中文逗号、英文逗号分隔，去重（大小写不敏感）并保留输入顺序。
 * 与契约 §3.6 的 `tags` 文本字段语义一致。
 */
export function parseTags(input: string | readonly string[]): string[] {
  const raw = Array.isArray(input) ? input : String(input).split(/[,，]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const tag = String(item).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** 标签整体校验：数量与单项长度 */
export function validateTags(tags: readonly string[]): FieldCheck {
  if (tags.length > TAGS_MAX_COUNT) {
    return {
      ok: false,
      message: `标签最多 ${TAGS_MAX_COUNT} 个，当前 ${tags.length} 个`,
    };
  }
  const tooLong = tags.find((tag) => tag.length > TAG_MAX_LENGTH);
  if (tooLong) {
    return {
      ok: false,
      message: `单个标签最多 ${TAG_MAX_LENGTH} 个字符：「${tooLong}」为 ${tooLong.length} 个`,
    };
  }
  return { ok: true };
}

/* ============================== 网盘链接 ============================== */

/** 取扩展名（小写，含点） */
export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

/**
 * 网盘分享链接校验（契约 §3.6）：必填、`http(s)://`、长度 ≤ 500。
 * 用 `new URL()` 解析，解析失败（含缺少协议头）即视为格式非法。
 */
export function validateNetdiskUrl(
  value: string,
  options: { maxLength?: number } = {},
): FieldCheck {
  const max = options.maxLength ?? DEFAULT_NETDISK_URL_MAX;
  const trimmed = value.trim();

  if (!trimmed) return { ok: false, message: '请填写网盘分享链接' };
  if (trimmed.length > max) {
    return { ok: false, message: `网盘分享链接最多 ${max} 个字符，当前 ${trimmed.length} 个` };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message: '网盘分享链接格式不正确，请粘贴带 https:// 的完整链接',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: '网盘分享链接需以 http:// 或 https:// 开头' };
  }
  if (!parsed.hostname) {
    return { ok: false, message: '网盘分享链接缺少主机名，请检查后重试' };
  }
  return { ok: true };
}

/* ============================== PNG 文件 ============================== */

/** 判断一段字节是否以 PNG 魔数开头 */
export function isPngMagic(bytes: ArrayLike<number> | null | undefined): boolean {
  if (!bytes || bytes.length < PNG_MAGIC_BYTES.length) return false;
  return PNG_MAGIC_BYTES.every((byte, index) => bytes[index] === byte);
}

/**
 * 读取文件前 8 字节用于魔数校验。
 * 读不到（例如被 CSP/权限限制、文件已被移除）时返回 null，
 * 此时**不阻断**，交由服务端做权威判定。
 */
export async function readFileHeader(file: SliceableFileLike): Promise<Uint8Array | null> {
  try {
    const slice = file.slice(0, PNG_MAGIC_BYTES.length);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

/** 校验展示用 PNG：扩展名 + 体积 +（若能读到文件头）PNG 魔数 */
export function validateImageFile(
  file: TypedFileLike | null | undefined,
  options: {
    maxBytes?: number;
    maxLabel?: string;
    allowedExtensions?: readonly string[];
    /** 文件头字节；未提供时跳过魔数校验 */
    header?: ArrayLike<number> | null;
  } = {},
): FieldCheck {
  if (!file) return { ok: false, message: '请选择要上传的 PNG 图片' };

  const allowed: readonly string[] = options.allowedExtensions?.length
    ? options.allowedExtensions.map((ext) => ext.toLowerCase())
    : ALLOWED_IMAGE_EXTENSIONS;
  const ext = fileExtension(file.name);
  if (!allowed.includes(ext)) {
    return {
      ok: false,
      message: `仅支持 ${allowed.join(' / ')} 图片，当前为「${ext || '无扩展名'}」`,
    };
  }

  if (options.header != null && !isPngMagic(options.header)) {
    return { ok: false, message: '这个文件的内容不是有效的 PNG 图片（文件头校验未通过）' };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (file.size > maxBytes) {
    const label = options.maxLabel ?? formatBytes(maxBytes);
    return { ok: false, message: `图片体积超过服务端上限 ${label}` };
  }
  return { ok: true };
}

/* ============================== 整表校验 ============================== */

export interface UploadFormInput {
  image: TypedFileLike | null;
  netdiskUrl: string;
  title: string;
  description: string;
  author: string;
  tags: readonly string[];
  extractCode?: string;
  sourceFileName?: string;
  sourceNote?: string;
  /** 图片文件头（由 readFileHeader 读出；缺省则跳过魔数校验） */
  imageHeader?: ArrayLike<number> | null;
  maxBytes?: number;
  maxLabel?: string;
  allowedExtensions?: readonly string[];
  /** 契约 §3.2 的 extractCodeMaxLength */
  extractCodeMaxLength?: number;
  /** 契约 §3.2 的 netdiskUrlMaxLength */
  netdiskUrlMaxLength?: number;
}

/** 整表校验：返回逐字段错误（无错误则返回空对象） */
export function validateUploadForm(input: UploadFormInput): FieldErrors {
  const errors: FieldErrors = {};

  const imageCheck = validateImageFile(input.image, {
    maxBytes: input.maxBytes,
    maxLabel: input.maxLabel,
    allowedExtensions: input.allowedExtensions,
    header: input.imageHeader,
  });
  if (!imageCheck.ok && imageCheck.message) errors.image = imageCheck.message;

  const urlCheck = validateNetdiskUrl(input.netdiskUrl, {
    maxLength: input.netdiskUrlMaxLength,
  });
  if (!urlCheck.ok && urlCheck.message) errors.netdiskUrl = urlCheck.message;

  const codeCheck = validateExtractCode(input.extractCode ?? '', {
    maxLength: input.extractCodeMaxLength,
  });
  if (!codeCheck.ok && codeCheck.message) errors.extractCode = codeCheck.message;

  const fileNameCheck = validateSourceFileName(input.sourceFileName ?? '');
  if (!fileNameCheck.ok && fileNameCheck.message) errors.sourceFileName = fileNameCheck.message;

  const noteCheck = validateSourceNote(input.sourceNote ?? '');
  if (!noteCheck.ok && noteCheck.message) errors.sourceNote = noteCheck.message;

  const titleCheck = validateTitle(input.title);
  if (!titleCheck.ok && titleCheck.message) errors.title = titleCheck.message;

  const descCheck = validateDescription(input.description);
  if (!descCheck.ok && descCheck.message) errors.description = descCheck.message;

  const authorCheck = validateAuthor(input.author);
  if (!authorCheck.ok && authorCheck.message) errors.author = authorCheck.message;

  const tagCheck = validateTags(input.tags);
  if (!tagCheck.ok && tagCheck.message) errors.tags = tagCheck.message;

  return errors;
}

/**
 * 带文件头读取的整表校验：选中文件后调用一次即可拿到含魔数校验的错误表。
 * 读不到文件头时按「跳过魔数校验」处理，不误伤正常文件。
 */
export async function validateUploadFormWithHeader(
  input: Omit<UploadFormInput, 'imageHeader'>,
): Promise<FieldErrors> {
  const header =
    input.image && fileExtension(input.image.name) === '.png'
      ? await readFileHeader(input.image as unknown as SliceableFileLike)
      : null;
  return validateUploadForm({ ...input, imageHeader: header });
}

/* ============================== 展示辅助 ============================== */

/** 人可读的体积格式化 */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

/** 表单错误是否为空 */
export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
