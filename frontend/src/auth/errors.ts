/**
 * 登录/鉴权失败的语义映射（契约 §8.1 / §8.2）。
 *
 * 401 与 403 在 v2.1 里是**两件完全不同的事**，前端必须分开提示：
 * - 401 `UNAUTHORIZED`      → 用户名或密码错（或令牌无效/过期）
 * - 403 `NOT_A_MEMBER`      → 账号本身有效，但不是社团成员，无法上传
 * - 502 `UPSTREAM_UNAVAILABLE` → 主站登录接口不可达/超时，属于服务端故障，不是用户输错
 *
 * 抽成纯函数是为了能单测，且让登录页与上传页共用同一套文案。
 */
import { ApiError } from '@/api/client';

/** 鉴权失败的原因分类 */
export type AuthErrorKind = 'invalid-credentials' | 'not-a-member' | 'upstream' | 'network' | 'unknown';

export interface AuthErrorInfo {
  kind: AuthErrorKind;
  /** 可直接展示给用户的中文文案 */
  message: string;
}

const NOT_A_MEMBER_MESSAGE = '该账号不是社团成员，无法上传。';
const INVALID_CREDENTIALS_MESSAGE = '用户名或密码错误，请检查后重试。';
const UPSTREAM_MESSAGE = '主站登录服务暂时不可用，请稍后重试。';

/** 把登录/取用户信息时的异常翻译成「原因 + 中文文案」 */
export function describeAuthError(error: unknown): AuthErrorInfo {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'NOT_A_MEMBER':
        return { kind: 'not-a-member', message: NOT_A_MEMBER_MESSAGE };
      case 'UNAUTHORIZED':
        return { kind: 'invalid-credentials', message: INVALID_CREDENTIALS_MESSAGE };
      case 'UPSTREAM_UNAVAILABLE':
        return { kind: 'upstream', message: UPSTREAM_MESSAGE };
      case 'NETWORK_ERROR':
      case 'TIMEOUT':
        return { kind: 'network', message: error.message };
      default:
        return { kind: 'unknown', message: error.message };
    }
  }

  return {
    kind: 'unknown',
    message: error instanceof Error ? error.message : '登录失败，请稍后重试。',
  };
}

/** 上传被拒时（401/403）的提示；登录已启用时的措辞与「上传令牌」无关 */
export function describeUploadAuthError(error: ApiError, loginEnabled: boolean): string {
  if (error.code === 'NOT_A_MEMBER') return NOT_A_MEMBER_MESSAGE;
  if (error.code === 'UNAUTHORIZED') {
    return loginEnabled
      ? '登录状态已失效，请重新登录后再上传。'
      : '上传令牌缺失或无效：请确认服务端 UPLOAD_TOKEN 与前端配置一致。';
  }
  return error.message;
}
