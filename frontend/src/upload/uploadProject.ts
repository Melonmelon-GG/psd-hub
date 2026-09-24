/**
 * 上传实现：使用 XMLHttpRequest 以获得 onprogress 上传进度（fetch 无法提供上传进度）。
 *
 * 契约 v2.0 §3.6：POST /api/projects，multipart/form-data，
 * 字段 image / netdiskUrl / title / description / author / tags /
 *      extractCode / sourceFileName / sourceNote / allowDuplicate。
 */
import { STREAM_TIMEOUT_MS, getUploadToken, url } from '@/config';
import type { CreateProjectInput, Project } from '@/types';

import { ApiError, toApiError } from '../api/client';
import { getAuthToken } from '../auth/storage';

export interface UploadProgress {
  /** 已上传字节 */
  loaded: number;
  /** 总字节（浏览器可能给出 0，表示未知） */
  total: number;
  /** 0..1；total 未知时为 null（UI 用不确定进度条） */
  ratio: number | null;
}

export interface UploadOptions {
  /** 进度回调，可能被高频调用，UI 侧自行节流 */
  onProgress?: (progress: UploadProgress) => void;
  /** 外部取消 */
  signal?: AbortSignal;
  /** 是否附加上传令牌头（由 GET /api/config 的 uploadTokenRequired 决定） */
  tokenRequired?: boolean;
  /** 超时（毫秒），默认放宽到 3 分钟以适应大文件 */
  timeoutMs?: number;
}

/** 组装契约 v2.0 §3.6 要求的 FormData */
export function buildUploadFormData(input: CreateProjectInput): FormData {
  const form = new FormData();

  // 必填：展示用 PNG（扩展名与文件头由服务端复核）
  form.append('image', input.image, input.image.name);

  // 必填：网盘分享链接（provider / providerLabel 由服务端按 §6 识别）
  form.append('netdiskUrl', input.netdiskUrl.trim());

  form.append('title', input.title.trim());

  // 可选字段：空值仍然发送（后端按 0..N 校验），但 author 为空时交由后端写 "匿名作者"
  form.append('description', input.description ?? '');
  form.append('author', (input.author ?? '').trim());

  // 契约 §3.6：tags 支持逗号分隔或重复字段；这里用逗号分隔的单字段形式
  if (input.tags && input.tags.length > 0) {
    form.append('tags', input.tags.join(','));
  }

  // 契约 §3.6：空串由后端 trim 后存 null
  form.append('extractCode', (input.extractCode ?? '').trim());
  form.append('sourceFileName', (input.sourceFileName ?? '').trim());
  form.append('sourceNote', (input.sourceNote ?? '').trim());

  if (input.allowDuplicate) {
    form.append('allowDuplicate', '1');
  }

  return form;
}

/**
 * 提交上传。成功返回 Project；失败一律抛 ApiError（含 409 DUPLICATE 的 details.existingId）。
 */
export function uploadProject(
  input: CreateProjectInput,
  options: UploadOptions = {},
): Promise<Project> {
  const { onProgress, signal, tokenRequired = true, timeoutMs = STREAM_TIMEOUT_MS } = options;

  return new Promise<Project>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消上传', 'AbortError'));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url('/api/projects'), true);
    xhr.responseType = 'text';
    xhr.timeout = timeoutMs;

    // 契约 §8.3：v2.1 起上传要求携带主站登录令牌；`Bearer ` 前缀可选，这里原样发送
    const authToken = getAuthToken();
    if (authToken) xhr.setRequestHeader('Authorization', authToken);

    // 契约 §0.3：未要求令牌时不发送空令牌头（UPLOAD_TOKEN 是给 CI 的自动化旁路）
    if (tokenRequired) {
      const token = getUploadToken();
      if (token) xhr.setRequestHeader('x-upload-token', token);
    }
    xhr.setRequestHeader('Accept', 'application/json');

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    xhr.upload.onprogress = (event) => {
      if (!onProgress) return;
      const total = event.lengthComputable ? event.total : 0;
      onProgress({
        loaded: event.loaded,
        total,
        ratio: total > 0 ? Math.min(1, event.loaded / total) : null,
      });
    };

    xhr.onload = () => {
      cleanup();
      const raw = typeof xhr.response === 'string' ? xhr.response : xhr.responseText;

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = raw ? (JSON.parse(raw) as { item?: Project }) : undefined;
          if (parsed?.item) {
            resolve(parsed.item);
            return;
          }
          reject(new ApiError('INVALID_RESPONSE', '上传成功但服务端返回的数据不完整', xhr.status));
        } catch {
          reject(new ApiError('INVALID_RESPONSE', '上传成功但无法解析服务端返回的数据', xhr.status));
        }
        return;
      }

      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      reject(toApiError(xhr.status, body, raw));
    };

    xhr.onerror = () => {
      cleanup();
      reject(new ApiError('NETWORK_ERROR', '网络错误，上传失败，请确认后端服务已启动'));
    };

    xhr.ontimeout = () => {
      cleanup();
      reject(new ApiError('TIMEOUT', '上传超时，请检查网络后重试'));
    };

    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('已取消上传', 'AbortError'));
    };

    xhr.send(buildUploadFormData(input));
  });
}

/** 判断某次上传失败是否为体积超限（UI 需要展示后端上限） */
export function isPayloadTooLarge(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'PAYLOAD_TOO_LARGE';
}

/** 判断某次上传失败是否为重复 PNG（同一张 PNG 的 sha256 相同，契约 §3.6 第 3 步） */
export function isDuplicate(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'DUPLICATE';
}

/** 判断是否为用户主动取消 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
