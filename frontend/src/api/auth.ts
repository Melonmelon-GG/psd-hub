/**
 * 契约 §8 认证端点封装（v2.1）。
 *
 * 两个端点都走 `api/client.request`，因此：
 * - 业务基址由 `config.url()` 拼接（契约 §5）；
 * - 失败一律抛 `ApiError`，401 / 403 / 502 的语义区分见 `auth/errors.ts`。
 */
import type { LoginResponse, MeResponse } from '@/types';

import { request } from './client';

/**
 * 契约 §8.1 `POST /api/auth/login`。
 *
 * 本服务只做转发：把 `cn` / `password` 交给主站 `POST {MAIN_SITE_BASE_URL}/api/login`，
 * 成功后把主站令牌**原样**返回。前端拿到后存 localStorage 并用于后续请求头。
 *
 * `withAuth: false`：登录请求绝不能带上本地可能已过期的旧令牌，
 * 否则部分实现会把 Authorization 优先于表单体解析，导致「换账号登录失败」。
 */
export async function login(cn: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>('/api/auth/login', {
    method: 'POST',
    json: { cn: cn.trim(), password },
    withAuth: false,
  });
}

/**
 * 契约 §8.2 `GET /api/auth/me`。
 * 用于刷新页面后恢复登录态；401 = 令牌无效/过期，403 = 有效但非社团成员。
 */
export async function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/me', { signal });
}
