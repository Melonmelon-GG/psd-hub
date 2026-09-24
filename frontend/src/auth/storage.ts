/**
 * 登录态的本地持久化（契约 §8）：JWT 与用户信息各存一个 localStorage 键。
 *
 * 为什么全篇 try/catch：
 * - **隐私模式 / 禁用 Cookie 的浏览器**下访问或写入 `localStorage` 会直接抛异常
 *   （Safari 的 `setItem` 会抛 QuotaExceededError），登录态可以只活在内存里，
 *   但绝不能让页面白屏；
 * - 单元测试与 SSR 预渲染下没有 `localStorage`，此时所有读写都退化为「无持久化」。
 *
 * 存储内容不做任何加密：令牌本来就要通过请求头发给后端，加密在前端没有意义；
 * 真正降低风险的是「同源部署」（契约 §8.4）与 24 小时的短有效期。
 */
import type { AuthUser } from '@/types';

/** 登录令牌（JWT）的存储键 */
export const AUTH_TOKEN_KEY = 'psd-hub-auth-token';
/** 登录用户信息（`{ cn, isMember }`）的存储键 */
export const AUTH_USER_KEY = 'psd-hub-auth-user';

/**
 * 取 localStorage；不可用时返回 null。
 * 用 `globalThis` 而非 `window`，这样 Node 测试里注入一个假的 storage 即可覆盖。
 */
function getLocalStorage(): Storage | null {
  try {
    const candidate = (globalThis as { localStorage?: Storage | null }).localStorage;
    return candidate ?? null;
  } catch {
    // 某些浏览器在隐私模式下连读取属性都会抛异常
    return null;
  }
}

/** 读字符串；任何异常都退化为 null */
function readRaw(key: string): string | null {
  try {
    return getLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 写字符串；value 为 null 表示删除。任何异常都被吞掉 */
function writeRaw(key: string, value: string | null): void {
  try {
    const storage = getLocalStorage();
    if (!storage) return;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // 隐私模式 / 配额超限：仅影响持久化，不影响本次会话
  }
}

/** 读取登录令牌；无则返回空串 */
export function getAuthToken(): string {
  const raw = readRaw(AUTH_TOKEN_KEY);
  return raw ? raw.trim() : '';
}

/** 写入登录令牌；传空串等于清除 */
export function setAuthToken(token: string): void {
  const trimmed = token.trim();
  writeRaw(AUTH_TOKEN_KEY, trimmed ? trimmed : null);
}

/** 校验从 localStorage 里读出来的用户信息是否可用（防止手改存储导致运行时崩溃） */
export function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { cn?: unknown; isMember?: unknown };
  return typeof candidate.cn === 'string' && candidate.cn.trim().length > 0;
}

/** 读取用户信息；缺失或损坏时返回 null（并顺手清理脏数据） */
export function getStoredUser(): AuthUser | null {
  const raw = readRaw(AUTH_USER_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 存储里是半截 JSON（例如上次写入被中断），清掉避免每次启动都解析失败
    writeRaw(AUTH_USER_KEY, null);
    return null;
  }

  if (!isAuthUser(parsed)) {
    writeRaw(AUTH_USER_KEY, null);
    return null;
  }

  const user = parsed as { cn: string; isMember?: unknown };
  return { cn: user.cn, isMember: user.isMember === true };
}

/** 写入用户信息；传 null 等于清除 */
export function setStoredUser(user: AuthUser | null): void {
  if (!user) {
    writeRaw(AUTH_USER_KEY, null);
    return;
  }
  try {
    writeRaw(AUTH_USER_KEY, JSON.stringify({ cn: user.cn, isMember: user.isMember === true }));
  } catch {
    // JSON.stringify 在极端情况下也可能抛（循环引用不会出现在 AuthUser 上），保险起见
    writeRaw(AUTH_USER_KEY, null);
  }
}

/** 清空全部登录态（退出登录 / 令牌校验失败时调用；契约里没有 logout 端点） */
export function clearAuthStorage(): void {
  writeRaw(AUTH_TOKEN_KEY, null);
  writeRaw(AUTH_USER_KEY, null);
}
