/**
 * 与 docs/API.md 契约逐字对齐的类型定义（**v2.1**）。
 * 契约已冻结：此处不得出现契约之外的字段，字段名不得改动。
 *
 * v2.0 技术路线：「上传 PNG + 网盘分享链接」。
 * v2.1 接入主站登录（契约 §8）：新增错误码与 `GET /api/config` 的两个新字段。
 * v1 的浏览器端 PSD 解析能力（`src/psd/**`、`components/PsdViewer.tsx` 等）
 * 代码仍保留在仓库里，但**不再接入路由与界面**；为让这些文件继续通过 `tsc`，
 * 文件末尾保留了 v1 的类型定义（见「v1 遗留类型」一节）。
 */

/** 契约 §0.2 错误码 */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'DUPLICATE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  /** 契约 §0.2 / §8：账号有效但不是社团成员（v2.1 上传要求成员身份） */
  | 'NOT_A_MEMBER'
  /** 契约 §0.2 / §8：主站登录/校验接口不可达或超时（v2.1） */
  | 'UPSTREAM_UNAVAILABLE'
  /** 前端本地产生的错误码（网络中断、超时、解析失败等），不属于后端契约 */
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

/** 契约 §0.2 错误信封中的 details 为可选、结构随 code 而异 */
export type ApiErrorDetails = {
  field?: string;
  reason?: string;
  /** 409 DUPLICATE 时后端附带的已存在项目 id */
  existingId?: string;
  [key: string]: unknown;
};

/** 契约 §0.2 */
export interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: ApiErrorDetails;
  };
}

/* ============================== 契约 §1 数据模型 ============================== */

/** 契约 §1.3 网盘类型（由服务端按 §6 规则从 URL 主机名识别） */
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

/** 契约 §1.3 NetdiskSource */
export interface NetdiskSource {
  provider: NetdiskProvider;
  /** 中文展示名，服务端算好（如「百度网盘」/「其它链接」） */
  providerLabel: string;
  /** 分享链接，http/https，长度 ≤ 500 */
  url: string;
  /** 提取码，长度 ≤ 16；无则 null */
  extractCode: string | null;
  /** 网盘里那个源文件的文件名（≤ 200） */
  fileName: string | null;
  /** 备注（≤ 200），如「含分层源文件」 */
  note: string | null;
}

/** 契约 §1.2 ImageInfo（v2.0 起为必有） */
export interface ImageInfo {
  /** 原始文件名，例 "深色UI稿.png" */
  fileName: string;
  /** 字节 */
  size: number;
  /** 小写十六进制，用于去重 */
  sha256: string;
  /** 从 PNG IHDR 解析；无法解析时为 null */
  width: number | null;
  height: number | null;
  /** "/api/projects/<id>/files/image" */
  url: string;
  /** "/api/projects/<id>/files/image?download=1" */
  downloadUrl: string;
}

/** 契约 §1.1 Project */
export interface Project {
  id: string;
  title: string;
  description: string;
  author: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** v2.0：展示用 PNG，必有 */
  image: ImageInfo;
  /** v2.0：网盘分享信息，必有 */
  source: NetdiskSource;
  stats: { views: number; downloads: number };
}

/** 契约 §0.4 列表分页信封 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 契约 §3.2 GET /api/config */
export interface ServerConfig {
  name: string;
  version: string;
  maxUploadBytes: number;
  maxUploadLabel: string;
  /** v2.0：仅 image/png */
  acceptedImageTypes: string[];
  /** v2.0：仅 .png */
  acceptedImageExtensions: string[];
  uploadTokenRequired: boolean;
  adminTokenRequired: boolean;
  /** v2.0：提取码长度上限（契约 §3.2） */
  extractCodeMaxLength: number;
  /** v2.0：网盘链接长度上限（契约 §3.2） */
  netdiskUrlMaxLength: number;
  /**
   * v2.1（契约 §8.4）：服务端是否启用主站登录。
   * 后端并行开发中，**该字段可能暂时缺失**；缺失时前端按 `false` 处理，
   * 即退回 v2.0 的旧行为（不强制登录、作者可自由填写）。
   */
  loginEnabled?: boolean;
  /** v2.1（契约 §8.4）：服务端挂载前缀（例 "/psd"）；未设置时挂在根 */
  mountPrefix?: string;
}

/* ============================== 契约 §8 认证（v2.1） ============================== */

/** 契约 §8.1 / §8.2：登录用户信息（`isMember` 决定能否上传） */
export interface AuthUser {
  /** 主站用户名，同时作为作品作者名（服务端强制覆盖） */
  cn: string;
  /** 是否为社团成员；只有 `true` 才能上传 */
  isMember: boolean;
}

/** 契约 §8.1 `POST /api/auth/login` 的 200 响应 */
export interface LoginResponse {
  /** 主站签发的 JWT，原样返回 */
  token: string;
  cn: string;
  isMember: boolean;
  /** 有效期（秒），契约 §8 为 86400 */
  expiresInSeconds: number;
}

/** 契约 §8.2 `GET /api/auth/me` 的 200 响应 */
export interface MeResponse {
  cn: string;
  isMember: boolean;
}

/** 契约 §3.4 GET /api/projects/tags */
export interface TagCount {
  name: string;
  count: number;
}

/** 契约 §3.3 sort 枚举 */
export type ProjectSort = 'newest' | 'oldest' | 'title' | 'downloads' | 'views';

/** 契约 §3.3 列表查询参数 */
export interface ListProjectsQuery {
  q?: string;
  tag?: string;
  author?: string;
  /** 契约 §3.3：按网盘类型过滤 */
  provider?: NetdiskProvider;
  sort?: ProjectSort;
  page?: number;
  pageSize?: number;
}

/** 契约 §3.7 PATCH 请求体（Project 的可改子集；v2.0 增加网盘字段） */
export interface UpdateProjectInput {
  title?: string;
  description?: string;
  author?: string;
  tags?: string[];
  netdiskUrl?: string;
  extractCode?: string;
  sourceFileName?: string;
  sourceNote?: string;
}

/** 契约 §3.6 POST /api/projects 的表单字段（multipart/form-data） */
export interface CreateProjectInput {
  /** 展示用 PNG；扩展名 .png 且文件头须为 PNG 魔数 */
  image: File;
  /** 网盘分享链接，http:// 或 https:// 开头，长度 ≤ 500 */
  netdiskUrl: string;
  title: string;
  description?: string;
  author?: string;
  tags?: string[];
  /** 提取码，0..16 字符，空则后端存 null */
  extractCode?: string;
  /** 网盘里源文件的文件名，0..200，空则 null */
  sourceFileName?: string;
  /** 备注，0..200，空则 null */
  sourceNote?: string;
  /** "1" 时跳过 sha256 去重检查 */
  allowDuplicate?: boolean;
}

/* ============================== v1 遗留类型 ==============================
 * 以下类型属于 v1 契约（浏览器端 PSD 解析 + PSD 托管路线），
 * **v2.0 路线不再使用**，保留以便将来恢复在线预览：
 *   - `src/psd/**`（loadPsd / layerTree / render / decode/*）仍引用 `PsdMeta`、`PsdEngineKind`、`PsdFidelity`
 *   - `components/PsdViewer.tsx` / `LayerPanel.tsx` / `PsdInfoPanel.tsx` 保留在原地（不再被任何页面引用）
 * 它们已从 `Project` 上摘除，因此这些组件无法再从项目数据里拿到 PSD 信息，
 * 但类型本身必须保留，否则 `tsc` 会因这些文件引用不存在的类型而失败。
 */

/** v1 契约 §1.1 PsdFileInfo（v2.0 已归档，服务端不再返回） */
export interface PsdFileInfo {
  fileName: string;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  colorMode: string | null;
  bitsPerChannel: number | null;
  layerCount: number | null;
  /** 文件头版本 —— 'PSD' 常规文档 / 'PSB' 大型文档 */
  version: 'PSD' | 'PSB' | null;
  /** 文件头声明的通道数（1..56，含 alpha 通道） */
  channels: number | null;
  /** 合成图是否带 alpha；Multichannel 无法判定时为 null */
  hasAlpha: boolean | null;
  /** "/api/projects/<id>/files/psd?download=1" */
  downloadUrl: string;
  /** "/api/projects/<id>/files/psd" */
  streamUrl: string;
}

/** v1 契约 §1.1 PreviewInfo（v2.0 由 ImageInfo 取代） */
export interface PreviewInfo {
  fileName: string;
  size: number;
  width: number | null;
  height: number | null;
  source: 'uploaded' | 'generated';
  /** "/api/projects/<id>/files/preview" */
  url: string;
  /** "/api/projects/<id>/files/preview?download=1" */
  downloadUrl: string;
}

/** 详情页的 PSD 解析元信息（前端本地解析结果，不回填给后端） */
export interface PsdMeta {
  width: number;
  height: number;
  colorMode: string;
  bitsPerChannel: number;
  layerCount: number;
  /** 解析耗时（毫秒） */
  parseMs: number;
  /** 通道数（来自解析结果） */
  channels?: number;
  /** 由哪条引擎解出来的：ag-psd 主引擎 / 自研兜底解码器 */
  engine?: PsdEngineKind;
  /** 该色彩模式是否只能近似预览（如 Duotone 按灰度、Multichannel 按 RGB） */
  approximate?: boolean;
  /** 近似或降级原因（中文，可直接展示） */
  approxReason?: string;
}

/** PSD 预览所用的引擎 */
export type PsdEngineKind = 'ag-psd' | 'fallback';

/**
 * 预览保真度分级，用于在界面上给出准确的预期管理：
 *   exact    —— 逐像素与 Photoshop 解码一致（RGB / Grayscale / Indexed）
 *   lossy    —— 色彩空间换算有固有误差，但视觉一致（CMYK / Lab / 16 位）
 *   approximate —— 语义上就只能近似（Duotone 按灰度、Multichannel 按 RGB）
 */
export type PsdFidelity = 'exact' | 'lossy' | 'approximate';
