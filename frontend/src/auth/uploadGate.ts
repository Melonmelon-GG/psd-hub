/**
 * 「上传页该不该要求登录」的判定（契约 §8）。
 *
 * 抽成纯函数的原因：
 * 1. 这正是「登录门禁」最容易出错的地方（加载中误判、非成员漏判、降级分支），必须能单测；
 * 2. 组件里只做渲染，判定逻辑只有一处真相。
 *
 * 三条规则：
 * - `loginEnabled === false`（含字段缺失，后端未落地）→ **退回 v2.0 旧行为**：
 *   不强制登录、`author` 由用户自由填写，服务端若配了 UPLOAD_TOKEN 走自动化旁路。
 * - `loginEnabled === true` 且未登录 → 整页替换为「去登录」引导卡片。
 * - `loginEnabled === true` 且已登录为社团成员 → `author` 锁定为登录用户名 `cn`，
 *   因为服务端会用令牌里的 `cn` **强制覆盖**表单里的 `author`（契约 §8.3 第 2 条）。
 */
import type { AuthUser } from '@/types';

/** 登录态（与 `useAuth().status` 一致） */
export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

/** 门禁原因，用于给出不同文案 */
export type UploadGateReason = 'anonymous' | 'not-member';

export interface UploadAccessInput {
  /** `GET /api/config` 的 `loginEnabled`；字段缺失/请求失败时传 false */
  loginEnabled: boolean;
  status: AuthStatus;
  user: AuthUser | null;
}

export interface UploadAccess {
  /** true：整页替换为引导卡片，不允许填写任何表单 */
  requiresLogin: boolean;
  /** 门禁原因；`requiresLogin` 为 false 时为 null */
  gateReason: UploadGateReason | null;
  /** 登录态尚在校验（启动时带令牌调 /api/auth/me）——先渲染占位，避免闪一下表单 */
  pending: boolean;
  /** true：`author` 预填登录用户名且只读 */
  authorLocked: boolean;
  /** 应当随表单提交的 author 值（锁定态为登录用户名；降级态为空串，交给用户填） */
  author: string;
}

/** 旧行为（v2.0）：不要求登录，作者可自由填写 */
const LEGACY_ACCESS: UploadAccess = {
  requiresLogin: false,
  gateReason: null,
  pending: false,
  authorLocked: false,
  author: '',
};

export function resolveUploadAccess(input: UploadAccessInput): UploadAccess {
  const { loginEnabled, status, user } = input;

  // 降级：服务端没启用登录（或字段暂时缺失），一切照 v2.0 走
  if (!loginEnabled) return LEGACY_ACCESS;

  if (status === 'loading') {
    return { ...LEGACY_ACCESS, pending: true };
  }

  if (status !== 'authenticated' || !user) {
    return { requiresLogin: true, gateReason: 'anonymous', pending: false, authorLocked: false, author: '' };
  }

  // 令牌有效但不是社团成员：能登录、不能上传（契约 §8.2 的 403）
  if (!user.isMember) {
    return { requiresLogin: true, gateReason: 'not-member', pending: false, authorLocked: false, author: '' };
  }

  return {
    requiresLogin: false,
    gateReason: null,
    pending: false,
    authorLocked: true,
    author: user.cn,
  };
}

/**
 * 生成上传表单里的 `author` 值。
 * 锁定态直接用登录用户名；降级态用用户填写的值（后端为空时写「匿名作者」）。
 */
export function resolveUploadAuthor(access: UploadAccess, typedAuthor: string): string {
  return access.authorLocked ? access.author : typedAuthor;
}
