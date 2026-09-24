/**
 * 统一业务异常：code 与 HTTP 状态码一一对应（契约 §0.2），
 * message 一律为面向用户的中文可读信息。
 */
import type { ErrorCode, ErrorEnvelope } from '../types.js';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_A_MEMBER: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  DUPLICATE: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_UNAVAILABLE: 502,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    if (details) this.details = details;
  }

  /** 转为契约规定的错误信封 */
  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function badRequest(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError('BAD_REQUEST', message, details);
}

export function unauthorized(message = '缺少或无效的访问令牌', details?: Record<string, unknown>): ApiError {
  return new ApiError('UNAUTHORIZED', message, details);
}

/** 账号有效但不是社团成员（契约 §0.2 / §8.1 / §8.3） */
export function notAMember(message = '该账号不是社团成员，无法上传作品', details?: Record<string, unknown>): ApiError {
  return new ApiError('NOT_A_MEMBER', message, details);
}

/** 主站登录/校验接口不可达或超时（契约 §0.2 / §8.1 / §8.3） */
export function upstreamUnavailable(
  message = '主站登录服务暂时不可用，请稍后重试',
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError('UPSTREAM_UNAVAILABLE', message, details);
}

export function notFound(message = '资源不存在', details?: Record<string, unknown>): ApiError {
  return new ApiError('NOT_FOUND', message, details);
}

export function methodNotAllowed(message = '该请求方法不被允许', details?: Record<string, unknown>): ApiError {
  return new ApiError('METHOD_NOT_ALLOWED', message, details);
}

export function duplicate(message = '该资源已存在', details?: Record<string, unknown>): ApiError {
  return new ApiError('DUPLICATE', message, details);
}

export function payloadTooLarge(message = '上传文件超过体积上限', details?: Record<string, unknown>): ApiError {
  return new ApiError('PAYLOAD_TOO_LARGE', message, details);
}

export function unsupportedMediaType(message = '不支持的文件类型', details?: Record<string, unknown>): ApiError {
  return new ApiError('UNSUPPORTED_MEDIA_TYPE', message, details);
}

export function rateLimited(message = '请求过于频繁，请稍后再试', details?: Record<string, unknown>): ApiError {
  return new ApiError('RATE_LIMITED', message, details);
}

export function internal(message = '服务器内部错误，请稍后重试'): ApiError {
  return new ApiError('INTERNAL', message);
}
