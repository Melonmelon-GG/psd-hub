/**
 * 契约 §2 / §3 的项目相关端点封装（**v2.0**）。
 * 所有路径均以 "/api" 开头，最终由 client.ts 用 config.url() 拼接基址（契约 §5）。
 *
 * v2.0 变更：
 * - 列表新增 `provider` 过滤（契约 §3.3）
 * - 新增 `buildNetdiskGoUrl()`：契约 §3.10 的跳转端点，供「前往网盘下载」按钮使用
 * - 移除 v1 的 `replacePreview`（`POST /api/projects/:id/preview` 已归档）
 * - 保留 `fetchPsdBytes`：v1 的浏览器内 PSD 解析模块（`src/psd/**`、`components/PsdViewer.tsx`）
 *   仍保留在仓库中以便将来恢复在线预览，为让其继续通过 `tsc` 而保留该函数；
 *   它**不参与任何 v2.0 页面**，对应的服务端端点已移除，实际调用会得到 404。
 */
import { STREAM_TIMEOUT_MS, url } from '@/config';
import type {
  CreateProjectInput,
  ListProjectsQuery,
  Paginated,
  Project,
  ProjectSort,
  ServerConfig,
  TagCount,
  UpdateProjectInput,
} from '@/types';

import { request } from './client';

/** 契约 §3.3 GET /api/projects */
export async function listProjects(
  query: ListProjectsQuery = {},
  signal?: AbortSignal,
): Promise<Paginated<Project>> {
  return request<Paginated<Project>>('/api/projects', {
    query: {
      q: query.q,
      tag: query.tag,
      author: query.author,
      provider: query.provider,
      sort: query.sort,
      page: query.page,
      pageSize: query.pageSize,
    },
    signal,
  });
}

/**
 * 契约 §3.5 GET /api/projects/:id
 * count=0 时不增加浏览计数（探测/预取用）。
 */
export async function getProject(
  id: string,
  options: { count?: boolean; signal?: AbortSignal } = {},
): Promise<Project> {
  const { count = true, signal } = options;
  const body = await request<{ item: Project }>(`/api/projects/${encodeURIComponent(id)}`, {
    query: { count: count ? undefined : 0 },
    signal,
  });
  return body.item;
}

/** 契约 §3.2 GET /api/config */
export async function getConfig(signal?: AbortSignal): Promise<ServerConfig> {
  return request<ServerConfig>('/api/config', { signal });
}

/** 契约 §3.1 GET /api/health（后端存活探针） */
export async function getHealth(signal?: AbortSignal): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/health', { signal });
}

/** 契约 §3.4 GET /api/projects/tags */
export async function getTags(signal?: AbortSignal): Promise<TagCount[]> {
  const body = await request<{ tags: TagCount[] }>('/api/projects/tags', { signal });
  return Array.isArray(body.tags) ? body.tags : [];
}

/* ------------------------------ URL 拼接（契约 §5） ------------------------------ */

/**
 * 契约 §3.10 `GET /api/projects/:id/go` —— 302 跳转到网盘链接并计一次下载。
 *
 * ⚠️ 该 URL 必须交给**普通链接**（`<a href>` 或 `window.open`）使用，**不能 fetch**：
 * fetch 会跟随 302 并把网盘页面当数据读回来，浏览器也就不会真正跳转。
 * 服务端响应带 `Cache-Control: no-store`，因此不要缓存这个地址。
 */
export function buildNetdiskGoUrl(id: string): string {
  return url(`/api/projects/${encodeURIComponent(id)}/go`);
}

/**
 * 展示用 PNG 的地址：契约 §1.2 已在 `image.url` / `image.downloadUrl` 给出相对路径，
 * 这里只负责按 §5 补上基址，方便组件里少写一层 url() 调用。
 */
export function buildImageUrl(image: { url: string }): string {
  return url(image.url);
}

/** 展示用 PNG 的下载地址（`?download=1`，强制附件） */
export function buildImageDownloadUrl(image: { downloadUrl: string }): string {
  return url(image.downloadUrl);
}

export interface CreateProjectResult {
  item: Project;
}

/**
 * 契约 §3.6 POST /api/projects（multipart/form-data）。
 * 上传走 XHR 以便获取进度，故实际实现位于 upload/uploadProject.ts；
 * 这里暴露类型便于统一从 projects 模块引用。
 */
export type { CreateProjectInput };

/**
 * 契约 §3.7 PATCH /api/projects/:id
 * 注意：管理令牌不在本前端范围内（契约 §0.3 由部署方在反向代理或页面外解决），
 * 故此处不带令牌；若服务端要求 admin 令牌，会返回 401 并由 UI 提示。
 * v2.0 起可修改网盘字段；`netdiskUrl` 变更后服务端会重新识别 provider / providerLabel。
 */
export async function updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
  const body = await request<{ item: Project }>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: input,
  });
  return body.item;
}

/** 契约 §3.8 DELETE /api/projects/:id（204，无响应体，幂等） */
export async function deleteProject(id: string): Promise<void> {
  await request<void>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    responseType: 'void',
  });
}

/**
 * 【v1 遗留，v2.0 不再使用】下载 PSD 原始字节供浏览器内解析。
 * 对应的服务端端点 `/api/projects/:id/files/psd` 已随 v2.0 归档（见 docs/API.md 附录 A），
 * 但 `components/PsdViewer.tsx` 仍被保留在仓库中，故这里保留该函数以维持其可编译性。
 */
export async function fetchPsdBytes(streamUrl: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  return request<ArrayBuffer>(streamUrl, {
    responseType: 'arrayBuffer',
    timeoutMs: STREAM_TIMEOUT_MS,
    signal,
  });
}

/** 排序下拉的展示标签，键与契约 §3.3 的 sort 枚举一致 */
export const SORT_OPTIONS: ReadonlyArray<{ value: ProjectSort; label: string }> = [
  { value: 'newest', label: '最新上传' },
  { value: 'oldest', label: '最早上传' },
  { value: 'title', label: '标题排序' },
  { value: 'downloads', label: '下载最多' },
  { value: 'views', label: '浏览最多' },
];

/** 校验 URL 中的 sort 参数（非法值回落到 newest，契约 §3.3 宽容解析） */
export function normalizeSort(value: string | null): ProjectSort {
  const found = SORT_OPTIONS.find((option) => option.value === value);
  return found ? found.value : 'newest';
}
