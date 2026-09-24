/**
 * 主站登录相关端点（契约 §8.1 / §8.2）。
 *
 * - `POST /api/auth/login`：把凭据**转发**给主站，成功把令牌原样交给前端；
 *   本服务不保存密码、不写日志、不落库。
 * - `GET /api/auth/me`：复用主站的成员专属接口校验令牌，供前端刷新页面后恢复登录态。
 *
 * 限流：**只有登录接口**挂独立的严格限流（LOGIN_RATE_LIMIT_MAX，默认 10 次/分钟/IP）——
 * 登录是典型的爆破目标，且每个请求都会打到主站，代价高于普通读接口。
 * `/api/auth/me` 不挂严格限流（它每次刷新页面都会被调用，与登录共用一个桶会误伤正常用户），
 * 交给全局限流即可。
 */
import { Router } from 'express';
import type { Request } from 'express';
import {
  MainSiteLoginError,
  loginOnMainSite,
  mainSiteOptions,
  readCnFromTokenUnverified,
  verifyMemberToken,
} from '../auth/mainSite.js';
import type { MainSiteLoginResult } from '../auth/mainSite.js';
import { MAIN_SITE_TOKEN_TTL_SECONDS } from '../config.js';
import type { AppContext } from '../context.js';
import { badRequest, notAMember, unauthorized, upstreamUnavailable } from '../lib/errors.js';
import { extractLoginToken } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import type { LoginResponse, MeResponse } from '../types.js';

/** 取请求体里的非空字符串字段（非字符串 / 缺失 / 空白都算未提供） */
function readCredentialField(body: unknown, field: string): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value;
}

/**
 * 校验登录令牌并返回 cn（/api/auth/me 与上传鉴权用的是同一套判定）：
 * 令牌缺失/无效 → 401；非成员 → 403；主站不可达 → 502；cn 解不出 → 401。
 */
async function resolveMemberIdentity(
  req: Request,
  ctx: AppContext,
): Promise<{ cn: string } | { error: Error }> {
  const token = extractLoginToken(req);
  if (!token) return { error: unauthorized('缺少登录令牌，请先登录') };

  const verdict = await verifyMemberToken(token, mainSiteOptions(ctx.config));
  if (verdict === 'invalid') return { error: unauthorized('登录令牌无效或已过期，请重新登录') };
  if (verdict === 'not-member') return { error: notAMember('该账号不是社团成员') };
  if (verdict === 'unavailable') {
    return { error: upstreamUnavailable('主站校验服务暂时不可用，请稍后重试') };
  }

  const cn = readCnFromTokenUnverified(token);
  if (!cn) return { error: unauthorized('登录令牌中缺少有效的用户名（cn），请重新登录') };
  return { cn };
}

export function createAuthRouter(ctx: AppContext): Router {
  const router = Router();

  /**
   * 登录接口的独立严格限流（防密码爆破，契约 §8 的安全加固）。
   *
   * ⚠️ 只挂在 `/auth/login` 上，**不要**用 `router.use()` 挂给整个 router：
   * `/auth/me` 是前端每次刷新页面都会调用的「恢复登录态」接口，
   * 若与登录共用 10 次/分钟这个桶，同一 NAT 出口下的多标签页刷新、
   * 或多人共用一条出口 IP，都会被误判为爆破而拿到 429。
   * `/auth/me` 交给全局限流即可（见 middleware/rateLimit 的全局配置）。
   */
  const loginLimiter = createRateLimiter({
    windowMs: ctx.config.rateLimitWindowMs,
    max: ctx.config.loginRateLimitMax,
    name: 'login',
  });

  /** POST /api/auth/login —— 转发凭据到主站（契约 §8.1） */
  router.post('/auth/login', loginLimiter, async (req, res) => {
    const cn = readCredentialField(req.body, 'cn');
    const password = readCredentialField(req.body, 'password');
    if (!cn || !password) {
      const missing = !cn ? 'cn' : 'password';
      throw badRequest('用户名和密码不能为空', {
        field: missing,
        reason: missing === 'cn' ? '用户名不能为空' : '密码不能为空',
      });
    }

    let result: MainSiteLoginResult;
    try {
      result = await loginOnMainSite(cn, password, mainSiteOptions(ctx.config));
    } catch (err) {
      if (err instanceof MainSiteLoginError) {
        // 只记录失败类别，绝不记录 cn/password/令牌
        ctx.logger.debug('主站登录失败', { kind: err.kind });
        if (err.kind === 'invalid-credentials') throw unauthorized('用户名或密码错误');
        if (err.kind === 'not-member') throw notAMember('该账号不是社团成员，无法登录展示台');
        throw upstreamUnavailable('主站登录服务暂时不可用，请稍后重试');
      }
      throw err;
    }

    // 契约 §8.1：账号有效但不是社团成员 → 403 NOT_A_MEMBER
    if (!result.isMember) {
      throw notAMember('该账号不是社团成员，无法登录展示台');
    }

    const body: LoginResponse = {
      token: result.token,
      cn: result.cn,
      isMember: true,
      expiresInSeconds: MAIN_SITE_TOKEN_TTL_SECONDS,
    };
    res.json(body);
  });

  /** GET /api/auth/me —— 恢复登录态（契约 §8.2） */
  router.get('/auth/me', async (req, res) => {
    const identity = await resolveMemberIdentity(req, ctx);
    if ('error' in identity) throw identity.error;
    const body: MeResponse = { cn: identity.cn, isMember: true };
    res.json(body);
  });

  return router;
}
