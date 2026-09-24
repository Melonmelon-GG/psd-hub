/**
 * 健康检查与公开运行时配置（契约 §3.1 / §3.2）。
 */
import { Router } from 'express';
import {
  ACCEPTED_IMAGE_TYPES,
  APP_NAME,
  APP_VERSION,
  EXTRACT_CODE_MAX_LENGTH,
  IMAGE_EXTENSIONS,
  NETDISK_URL_MAX_LENGTH,
  SITE_NAME,
} from '../config.js';
import type { AppContext } from '../context.js';
import type { HealthResponse, PublicConfigResponse } from '../types.js';

export function createHealthRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const body: HealthResponse = {
      ok: true,
      name: APP_NAME,
      version: APP_VERSION,
      uptimeMs: Math.max(0, Date.now() - ctx.startedAt),
      time: new Date().toISOString(),
    };
    res.json(body);
  });

  router.get('/config', (_req, res) => {
    const { config } = ctx;
    const body: PublicConfigResponse = {
      name: SITE_NAME,
      version: APP_VERSION,
      maxUploadBytes: config.maxUploadBytes,
      maxUploadLabel: config.maxUploadLabel,
      acceptedImageTypes: [...ACCEPTED_IMAGE_TYPES],
      acceptedImageExtensions: [...IMAGE_EXTENSIONS],
      uploadTokenRequired: config.uploadToken !== null,
      adminTokenRequired: config.adminToken !== null,
      extractCodeMaxLength: EXTRACT_CODE_MAX_LENGTH,
      netdiskUrlMaxLength: NETDISK_URL_MAX_LENGTH,
      // v2.1：前端据此决定要不要显示登录入口 / 把请求挂到子路径
      loginEnabled: config.mainSiteBaseUrl !== '',
      mountPrefix: config.mountPrefix,
    };
    res.json(body);
  });

  return router;
}
