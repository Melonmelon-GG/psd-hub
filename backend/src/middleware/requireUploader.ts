/**
 * 上传鉴权（契约 §8.3）—— `POST /api/projects` 专用。
 *
 * 判定顺序（严格按契约）：
 * 1. 配置了 `UPLOAD_TOKEN` 且 `x-upload-token` 与之匹配 → 通过（自动化旁路，
 *    `req.uploader = { via: 'token', cn: null }`，author 取表单值）；
 * 2. 否则取 `Authorization`（`Bearer ` 前缀可选）当作**主站登录令牌**：
 *    缺失 → 401 UNAUTHORIZED；
 *    主站校验 401 → 401 UNAUTHORIZED；403 → 403 NOT_A_MEMBER；
 *    主站不可达/超时/5xx → 502 UPSTREAM_UNAVAILABLE（失败关闭，绝不放行）；
 *    200 → `req.uploader = { via: 'login', cn }`，cn 取自令牌载荷；解不出 cn → 401；
 * 3. 服务端既没配 `UPLOAD_TOKEN` 也没配 `MAIN_SITE_BASE_URL` → **放行并记警告**。
 *
 * 关于第 3 条（刻意的降级）：这与 v2.0「未配置令牌即放开」的行为一致，
 * 保证本地开发 / 纯内网部署不必先接主站就能用。一旦配置了任意一种凭据，
 * 该降级立即关闭。
 */
import type { Request, RequestHandler } from 'express';
import { mainSiteOptions, readCnFromTokenUnverified, verifyMemberToken } from '../auth/mainSite.js';
import type { AppContext } from '../context.js';
import { notAMember, unauthorized, upstreamUnavailable } from '../lib/errors.js';
import type { UploaderInfo } from '../types.js';
import { extractLoginToken, timingSafeEqualString } from './auth.js';

declare global {
  namespace Express {
    interface Request {
      /** 由 requireUploader 写入的上传者身份；未经过上传路由时为 undefined */
      uploader?: UploaderInfo;
    }
  }
}

/** 把 uploader 挂到 req 上 */
function assignUploader(req: Request, uploader: UploaderInfo): void {
  req.uploader = uploader;
}

export function requireUploader(ctx: AppContext): RequestHandler {
  const { uploadToken, mainSiteBaseUrl } = ctx.config;
  const options = mainSiteOptions(ctx.config);
  /** 降级放行只警告一次，避免每个请求刷屏 */
  let warnedDegraded = false;

  return async (req, _res, next) => {
    try {
      // 1) 自动化旁路：只认 x-upload-token（v2.1 起 Authorization 让给登录令牌）
      if (uploadToken) {
        const provided = req.get('x-upload-token')?.trim() ?? '';
        if (provided !== '' && timingSafeEqualString(uploadToken, provided)) {
          assignUploader(req, { via: 'token', cn: null });
          next();
          return;
        }
      }

      // 3) 两种凭据都没配置 → 降级放行（本地开发）。注意顺序：只要配了任一种就不降级。
      if (!uploadToken && mainSiteBaseUrl === '') {
        if (!warnedDegraded) {
          warnedDegraded = true;
          ctx.logger.warn(
            '未配置 UPLOAD_TOKEN，也未配置 MAIN_SITE_BASE_URL：上传接口当前不做任何鉴权（仅建议本地开发使用）',
          );
        }
        assignUploader(req, { via: 'open', cn: null });
        next();
        return;
      }

      // 配了 UPLOAD_TOKEN 但没配主站：只认上传令牌，Authorization 无从校验 → 401
      if (mainSiteBaseUrl === '') {
        next(unauthorized('上传令牌缺失或无效', { header: 'x-upload-token' }));
        return;
      }

      // 2) 主站登录令牌
      const token = extractLoginToken(req);
      if (!token) {
        next(unauthorized('请先登录社团账号后再上传'));
        return;
      }

      const verdict = await verifyMemberToken(token, options);
      if (verdict === 'invalid') {
        next(unauthorized('登录令牌无效或已过期，请重新登录'));
        return;
      }
      if (verdict === 'not-member') {
        next(notAMember('该账号不是社团成员，无法上传作品'));
        return;
      }
      if (verdict === 'unavailable') {
        next(upstreamUnavailable('主站校验服务暂时不可用，请稍后重试'));
        return;
      }

      // 校验通过后才读取 cn：此时令牌由主站确认有效，载荷里的 cn 才可信
      const cn = readCnFromTokenUnverified(token);
      if (!cn) {
        next(unauthorized('登录令牌中缺少有效的用户名（cn），请重新登录'));
        return;
      }
      assignUploader(req, { via: 'login', cn });
      next();
    } catch (err) {
      next(err);
    }
  };
}
