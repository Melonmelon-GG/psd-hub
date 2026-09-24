/**
 * 与 docs/API.md（v2.0 · 冻结）严格一致的公开数据模型与信封类型。
 * 任何字段改名都必须先修改契约文档。
 *
 * v2.0 技术路线：不再上传/托管 PSD，改为「上传 PNG + 网盘分享链接」。
 *   Project.preview → Project.image（必填 PNG）
 *   Project.psd     → Project.source（网盘信息）
 */

/**
 * 网盘类型（契约 §1.3 / §6）。`other` 为兜底，中文名"其它链接"。
 */
export type NetdiskProvider =
  | 'baidu'
  | 'aliyun'
  | 'quark'
  | '123pan'
  | 'lanzou'
  | 'weiyun'
  | 'ctfile'
  | 'onedrive'
  | 'googledrive'
  | 'mega'
  | 'dropbox'
  | 'other';

/** 展示用 PNG 信息（Project.image，v2.0 起必填） */
export interface ImageInfo {
  /** 原始文件名，例 "深色UI稿.png" */
  fileName: string;
  /** 字节数 */
  size: number;
  /** 小写十六进制 sha256，用于去重与 ETag */
  sha256: string;
  /** 从 PNG IHDR 解析；文件头不足 24 字节时为 null */
  width: number | null;
  height: number | null;
  /** "/api/projects/<id>/files/image" */
  url: string;
  /** "/api/projects/<id>/files/image?download=1" */
  downloadUrl: string;
}

/** 网盘分享信息（Project.source） */
export interface NetdiskSource {
  /** 由服务端按 §6 的规则从 URL 主机名识别 */
  provider: NetdiskProvider;
  /** 中文展示名，服务端算好（如 "百度网盘" / "其它链接"） */
  providerLabel: string;
  /** 分享链接，http/https，长度 ≤ 500 */
  url: string;
  /** 提取码，长度 ≤ 16；无则 null */
  extractCode: string | null;
  /** 网盘里那个源文件的文件名（≤ 200），便于展示 */
  fileName: string | null;
  /** 备注（≤ 200），如 "含分层源文件" */
  note: string | null;
}

/** 计数统计 */
export interface ProjectStats {
  views: number;
  downloads: number;
}

/** 项目实体 */
export interface Project {
  /** 形如 "prj_9f2c1ab73d4e" */
  id: string;
  title: string;
  description: string;
  author: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  image: ImageInfo;
  source: NetdiskSource;
  stats: ProjectStats;
}

/** 列表分页信封（契约 §0.4） */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 错误码联合类型（契约 §0.2；v2.1 新增 NOT_A_MEMBER / UPSTREAM_UNAVAILABLE） */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_A_MEMBER'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'DUPLICATE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'UPSTREAM_UNAVAILABLE';

/** 统一错误信封 */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** 列表排序键 */
export type SortKey = 'newest' | 'oldest' | 'title' | 'downloads' | 'views';

/** 列表查询参数（已做宽容解析与默认值填充） */
export interface ListProjectsQuery {
  q?: string;
  tag?: string;
  author?: string;
  /** 按网盘类型精确过滤（契约 §3.3），非法值不生效 */
  provider?: NetdiskProvider;
  sort: SortKey;
  page: number;
  pageSize: number;
}

/** 标签聚合项 */
export interface TagCount {
  name: string;
  count: number;
}

/** GET /api/health 响应 */
export interface HealthResponse {
  ok: true;
  name: string;
  version: string;
  uptimeMs: number;
  time: string;
}

/** GET /api/config 响应（契约 §3.2；v2.1 新增 loginEnabled / mountPrefix） */
export interface PublicConfigResponse {
  name: string;
  version: string;
  maxUploadBytes: number;
  maxUploadLabel: string;
  acceptedImageTypes: string[];
  acceptedImageExtensions: string[];
  uploadTokenRequired: boolean;
  adminTokenRequired: boolean;
  extractCodeMaxLength: number;
  netdiskUrlMaxLength: number;
  /** 是否启用了主站登录（= 是否配置了 MAIN_SITE_BASE_URL），前端据此决定是否显示登录入口 */
  loginEnabled: boolean;
  /** 挂载前缀（契约 §8.4），未配置时为 "" */
  mountPrefix: string;
}

/** POST /api/auth/login 成功响应（契约 §8.1） */
export interface LoginResponse {
  token: string;
  cn: string;
  isMember: boolean;
  expiresInSeconds: number;
}

/** GET /api/auth/me 成功响应（契约 §8.2） */
export interface MeResponse {
  cn: string;
  isMember: true;
}

/**
 * 上传者身份（内部类型，非 HTTP 契约字段）：由 requireUploader 中间件写入 req.uploader。
 * - `token`：x-upload-token 旁路（自动化），author 取表单值；
 * - `login`：主站登录令牌通过校验，author 强制取 cn；
 * - `open` ：服务端既未配置 UPLOAD_TOKEN 也未配置主站地址时的本地开发降级放行，author 取表单值。
 */
export type UploaderVia = 'token' | 'login' | 'open';

export interface UploaderInfo {
  via: UploaderVia;
  /** 仅 via === 'login' 时为已由主站校验通过的令牌里的 cn */
  cn: string | null;
}
