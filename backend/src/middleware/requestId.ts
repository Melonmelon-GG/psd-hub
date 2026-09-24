/**
 * 请求追踪：透传合法 x-request-id，否则生成新的；始终回写响应头。
 */
import type { RequestHandler } from 'express';
import { newRequestId } from '../lib/ids.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestIdMiddleware(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : newRequestId();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  };
}

/** 读取当前请求的追踪 id（日志用） */
export function getRequestId(res: { locals: Record<string, unknown> }): string {
  const value = res.locals.requestId;
  return typeof value === 'string' ? value : '';
}
