/**
 * 统一错误处理：把 ApiError / multer 错误 / JSON 解析错误 / 未知异常
 * 一律映射成契约 §0.2 的错误信封。
 * 500 只回中文泛化提示，堆栈仅写服务端日志，绝不外泄。
 */
import multer from 'multer';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError, badRequest, notFound, payloadTooLarge } from '../lib/errors.js';
import type { Logger } from '../logger.js';
import type { ErrorCode, ErrorEnvelope } from '../types.js';

export interface MappedError {
  status: number;
  body: ErrorEnvelope;
  /** 是否应记录 error 级日志（5xx 与未知异常） */
  severe: boolean;
}

/** multer 的 LIMIT_* 错误 → 中文提示 + 契约错误码 */
function mapMulterError(err: multer.MulterError, maxUploadLabel: string): MappedError {
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return {
        status: 413,
        severe: false,
        body: {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `上传文件超过体积上限（${maxUploadLabel}）`,
            details: { field: err.field ?? 'image', limit: maxUploadLabel },
          },
        },
      };
    case 'LIMIT_FILE_COUNT':
      return wrap(badRequest('上传文件数量超出限制', { code: err.code }));
    case 'LIMIT_UNEXPECTED_FILE':
      return wrap(badRequest(`不支持的上传字段：${err.field ?? '未知'}`, { field: err.field }));
    case 'LIMIT_FIELD_VALUE':
      return wrap(badRequest('表单字段内容过长', { field: err.field }));
    case 'LIMIT_FIELD_COUNT':
      return wrap(badRequest('表单字段数量超出限制'));
    case 'LIMIT_PART_COUNT':
      return wrap(badRequest('multipart 分段数量超出限制'));
    default:
      return wrap(badRequest('上传请求格式不合法', { code: err.code }));
  }
}

/** 把 ApiError 包成 MappedError */
function wrap(err: ApiError): MappedError {
  return { status: err.status, body: err.toEnvelope(), severe: false };
}

/** 任意异常 → 响应体 */
export function mapError(err: unknown, maxUploadLabel: string): MappedError {
  if (err instanceof ApiError) return wrap(err);

  if (err instanceof multer.MulterError) return mapMulterError(err, maxUploadLabel);

  if (err instanceof ZodError) {
    const issues = err.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join('.'),
      message: issue.message,
    }));
    return wrap(badRequest('请求参数校验失败', { issues }));
  }

  // body-parser：JSON 语法错误 / 体积超限
  const typed = err as { type?: string; status?: number; statusCode?: number; message?: string };
  if (typed?.type === 'entity.parse.failed') {
    return wrap(badRequest('请求体不是合法的 JSON'));
  }
  if (typed?.type === 'entity.too.large') {
    return wrap(payloadTooLarge('请求体超过体积上限'));
  }
  if (err instanceof SyntaxError && typed.status === 400) {
    return wrap(badRequest('请求体不是合法的 JSON'));
  }

  return {
    status: 500,
    severe: true,
    body: { error: { code: 'INTERNAL', message: '服务器内部错误，请稍后重试' } },
  };
}

/** 未匹配路由：统一 404 JSON 信封 */
export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    const err: ApiError = notFound(`接口不存在：${req.method} ${req.path}`, {
      method: req.method,
      path: req.path,
    });
    next(err);
  };
}

/**
 * 排空剩余请求体。
 * 提前拒绝（例如 413）时如果不读完请求体就关闭连接，客户端可能收到 RST 而读不到我们发出的
 * 错误响应；这里主动排空（上限 4MB，超出则断开）让客户端能稳定拿到 413。
 */
function drainRequestBody(req: Request, maxBytes = 4 * 1024 * 1024): void {
  if (req.readableEnded || req.destroyed) return;
  let drained = 0;
  req.on('data', (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > maxBytes) req.destroy();
  });
  req.on('error', () => undefined);
  req.resume();
}

/** 全局错误中间件（必须是 4 参数） */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    const maxUploadLabel = res.locals.maxUploadLabel;
    const label = typeof maxUploadLabel === 'string' ? maxUploadLabel : '上传上限';
    const mapped = mapError(err, label);

    if (mapped.severe) {
      logger.error('未处理的服务端异常', { err, status: mapped.status });
    } else if (res.statusCode === 200) {
      logger.debug('请求被拒绝', {
        code: mapped.body.error.code as ErrorCode,
        message: mapped.body.error.message,
      });
    }

    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(mapped.status).json(mapped.body);
    if (mapped.status === 413) drainRequestBody(req);
  };
}
