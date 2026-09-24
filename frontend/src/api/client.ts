/**
 * fetch 封装：拼接 base、按需附加令牌头、统一把后端错误信封转成 ApiError。
 * 契约 §0.2 / §0.3 / §5 / §8。
 */
import { getAuthToken } from '@/auth/storage';
import { DEFAULT_TIMEOUT_MS, getUploadToken, url } from '@/config';
import type { ApiErrorCode, ApiErrorDetails, ApiErrorEnvelope } from '@/types';

/** 统一的 API 错误；调用方通过 code 判定分支，message 永远是中文可读文案 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: ApiErrorDetails | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    status = 0,
    details?: ApiErrorDetails,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** 409 DUPLICATE 时后端给出已存在项目 id */
  get existingId(): string | undefined {
    const id = this.details?.existingId;
    return typeof id === 'string' && id ? id : undefined;
  }
}

/** 各错误码的兜底中文文案（后端未给 message 或响应体无法解析时使用） */
const FALLBACK_MESSAGE: Record<ApiErrorCode, string> = {
  BAD_REQUEST: '请求参数不合法，请检查填写内容。',
  UNAUTHORIZED: '令牌缺失或无效，请重新填写上传令牌。',
  NOT_A_MEMBER: '该账号不是社团成员，无法上传。',
  NOT_FOUND: '请求的内容不存在或已被删除。',
  METHOD_NOT_ALLOWED: '请求方式不被支持。',
  DUPLICATE: '这张 PNG 已存在。',
  PAYLOAD_TOO_LARGE: '文件体积超过服务端上限。',
  UNSUPPORTED_MEDIA_TYPE: '文件类型不受支持，请上传 .png 图片。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。',
  INTERNAL: '服务端出现异常，请稍后重试。',
  UPSTREAM_UNAVAILABLE: '主站登录服务暂时不可用，请稍后重试。',
  NETWORK_ERROR: '无法连接到服务器，请确认后端已启动。',
  TIMEOUT: '请求超时，请检查网络后重试。',
  INVALID_RESPONSE: '服务端返回了无法解析的内容。',
};

/** HTTP 状态码 → 契约错误码 */
function codeFromStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      // 契约 §0.2：403 在 v2.1 里只表示「账号有效但不是社团成员」
      return 'NOT_A_MEMBER';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 409:
      return 'DUPLICATE';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 429:
      return 'RATE_LIMITED';
    case 502:
      // 契约 §0.2：主站登录/校验接口不可达或超时
      return 'UPSTREAM_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
  }
}

/** 后端返回的 code 可能超出前端已知集合，未知值归入 INTERNAL 以免丢失 message */
function normalizeCode(code: unknown, status: number): ApiErrorCode {
  if (typeof code !== 'string') return codeFromStatus(status);
  return code in FALLBACK_MESSAGE ? (code as ApiErrorCode) : codeFromStatus(status);
}

/** 把任意响应体解析成 ApiError（契约 §0.2 信封，兼容非信封的降级响应） */
export function toApiError(status: number, body: unknown, rawText?: string): ApiError {
  if (body && typeof body === 'object' && 'error' in body) {
    const envelope = body as ApiErrorEnvelope;
    const payload = envelope.error;
    if (payload && typeof payload === 'object') {
      const code = normalizeCode(payload.code, status);
      const message =
        typeof payload.message === 'string' && payload.message.trim()
          ? payload.message
          : FALLBACK_MESSAGE[code];
      const details =
        payload.details && typeof payload.details === 'object'
          ? (payload.details as ApiErrorDetails)
          : undefined;
      return new ApiError(code, message, status, details);
    }
  }

  const code = codeFromStatus(status);
  const text = rawText?.trim();
  // 非信封响应（例如反向代理的 HTML 错误页）不把原文暴露给用户，只保留状态码信息
  const message = text && text.length < 200 && !text.startsWith('<')
    ? text
    : FALLBACK_MESSAGE[code];
  return new ApiError(code, message, status);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** 查询参数；undefined / 空串会被忽略 */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON 请求体；与 body 二选一 */
  json?: unknown;
  /** 原始请求体（FormData 等），设置后不自动加 Content-Type */
  body?: BodyInit;
  /** 是否附加上传令牌（仅 POST /api/projects 需要，契约 §0.3） */
  withUploadToken?: boolean;
  /**
   * 是否在本地存在登录令牌时自动附加 `Authorization: <token>`。
   * 默认 `true`（契约 §8：上传需要登录令牌）。
   * 登录请求本身要显式传 `false`，避免把过期的旧令牌一起发出去。
   */
  withAuth?: boolean;
  /** tokenRequired 由 GET /api/config 得知，为 false 时不发空令牌头 */
  tokenRequired?: boolean;
  /** 自定义超时 */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 期望的响应类型 */
  responseType?: 'json' | 'text' | 'void' | 'arrayBuffer';
}

/** 拼接 query string（契约 §3.3：非法参数由后端宽容处理，前端只负责不传空值） */
function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** 合并外部 signal 与超时 signal */
function createAbortContext(timeoutMs: number, external?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
    timedOut: () => timedOut,
  };
}

/** 核心请求函数：所有 api/projects.ts 的调用都经过它 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    query,
    json,
    body,
    withUploadToken = false,
    withAuth = true,
    tokenRequired = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    responseType = 'json',
  } = options;

  const headers = new Headers({ Accept: 'application/json' });

  // 契约 §8.2：`Authorization: <JWT>`，`Bearer ` 前缀可选 —— 这里按契约原样发送，不加前缀。
  // 本地没有令牌时不发空头（契约 §0.3 的同一条原则）。
  if (withAuth) {
    const authToken = getAuthToken();
    if (authToken) headers.set('Authorization', authToken);
  }

  // 契约 §0.3：未配置令牌时不要发送空令牌头
  if (withUploadToken && tokenRequired) {
    const token = getUploadToken();
    if (token) headers.set('x-upload-token', token);
  }

  let payload: BodyInit | undefined = body;
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    payload = JSON.stringify(json);
  }

  const target = `${url(path)}${buildQuery(query)}`;
  const abortCtx = createAbortContext(timeoutMs, signal);

  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: payload,
      signal: abortCtx.signal,
    });
  } catch (error) {
    abortCtx.cleanup();
    // 外部主动取消：原样抛出，由调用方忽略
    if (signal?.aborted) throw error;
    if (abortCtx.timedOut()) {
      throw new ApiError('TIMEOUT', FALLBACK_MESSAGE.TIMEOUT);
    }
    throw new ApiError('NETWORK_ERROR', FALLBACK_MESSAGE.NETWORK_ERROR);
  }
  abortCtx.cleanup();

  if (!response.ok) {
    const rawText = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = rawText ? JSON.parse(rawText) : undefined;
    } catch {
      parsed = undefined;
    }
    // 429 的 Retry-After 通过 details 透出，便于 UI 提示
    const apiError = toApiError(response.status, parsed, rawText);
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter && !apiError.details?.retryAfter) {
      return Promise.reject(
        new ApiError(apiError.code, apiError.message, apiError.status, {
          ...(apiError.details ?? {}),
          retryAfter,
        }),
      );
    }
    throw apiError;
  }

  if (responseType === 'void' || response.status === 204) {
    return undefined as T;
  }

  if (responseType === 'arrayBuffer') {
    return (await response.arrayBuffer()) as T;
  }

  if (responseType === 'text') {
    return (await response.text()) as T;
  }

  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('INVALID_RESPONSE', FALLBACK_MESSAGE.INVALID_RESPONSE, response.status);
  }
}
