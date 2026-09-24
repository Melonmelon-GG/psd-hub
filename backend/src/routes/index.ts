/**
 * API 路由装配：全部挂在 /api 前缀下。
 * projects 与 files 两个 Router 共用 /projects 前缀，
 * 因为 /:id 只匹配单段路径，不会吞掉 /:id/files/xxx。
 */
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { createAuthRouter } from './auth.js';
import { createFilesRouter } from './files.js';
import { createHealthRouter } from './health.js';
import { createProjectsRouter } from './projects.js';

export function mountApi(ctx: AppContext): Router {
  const router = Router();
  router.use(createHealthRouter(ctx));
  router.use(createAuthRouter(ctx));
  router.use('/projects', createProjectsRouter(ctx));
  router.use('/projects', createFilesRouter(ctx));
  return router;
}
