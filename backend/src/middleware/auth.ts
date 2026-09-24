/**
 * 令牌鉴权（契约 §0.3）。
 * - 两类令牌均为可选：未配置对应环境变量时该操作完全放开（本地开发便利）；
 * - 已配置时，缺失或错误一律 401 UNAUTHORIZED；
 * - 比较使用 crypto.timingSafeEqual（长度不等直接判否），避免时序侧信道。
 *
 * v2.1 起 `POST /api/projects` 的鉴权改由 `requireUploader` 统一处理
 * （上传令牌旁路 + 主站登录令牌，契约 §8.3），本文件只保留通用的令牌比较工具与
 * 管理令牌守卫。
 */
import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { AppContext } from '../context.js';
import { unauthorized } from '../lib/errors.js';

export type TokenHeader = 'x-upload-token' | 'x-admin-token';

export interface TokenGuardOptions {
  /** 期望的令牌；null 表示未启用 */
  token: string | null;
  header: TokenHeader;
  /** 中文名称，用于错误信息 */
  label: string;
}

/** 常量时间比较（长度不同直接失败，不泄漏前缀信息） */
export function timingSafeEqualString(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 取出 Authorization 头里的主站登录令牌（契约 §8.2 / §8.3）：
 * 形如 `<token>` 或 `Bearer <token>`，缺失/空白返回 null。
 *
 * 注意：v2.1 起 Authorization 专用于**主站登录令牌**；
 * 上传令牌只认 `x-upload-token`（契约 §0.3 的表）。
 */
export function extractLoginToken(req: Request): string | null {
  const authorization = req.get('authorization');
  if (!authorization) return null;
  const trimmed = authorization.trim();
  if (trimmed === '') return null;
  const matched = /^Bearer\s+(.+)$/i.exec(trimmed);
  const token = (matched?.[1] ?? trimmed).trim();
  return token === '' ? null : token;
}

/** 依次尝试专用头与 Authorization: Bearer */
function extractToken(req: Request, header: TokenHeader): string | null {
  const direct = req.get(header);
  if (direct && direct.trim() !== '') return direct.trim();
  const authorization = req.get('authorization');
  if (authorization) {
    const matched = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (matched && matched[1]) return matched[1].trim();
  }
  return null;
}

export function requireToken(options: TokenGuardOptions): RequestHandler {
  const { token, header, label } = options;
  return (req, _res, next) => {
    if (!token) {
      next();
      return;
    }
    const provided = extractToken(req, header);
    if (!provided || !timingSafeEqualString(token, provided)) {
      next(unauthorized(`${label}缺失或无效`, { header }));
      return;
    }
    next();
  };
}

/** 管理令牌：保护 PATCH / DELETE（契约 §0.3） */
export function requireAdminToken(ctx: AppContext): RequestHandler {
  return requireToken({ token: ctx.config.adminToken, header: 'x-admin-token', label: '管理令牌' });
}
