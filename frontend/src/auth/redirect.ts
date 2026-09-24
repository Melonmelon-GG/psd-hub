/**
 * `?redirect=` 参数的安全处理（防开放重定向）。
 *
 * 登录成功后要跳回用户原本想去的页面，但 `redirect` 是**用户可控的输入**：
 * 如果不加校验直接 `navigate(raw)`，攻击者可以构造
 *   /login?redirect=https://evil.com
 * 让用户在「本站登录成功」的表象下被送到钓鱼站。
 *
 * 因此只接受**站内相对路径**，其余一律回退首页：
 * - 必须以单个 `/` 开头（`//evil.com` 是协议相对地址，会跳到外站，必须拒绝）
 * - 不允许出现协议头（`http:` / `https:` / `javascript:` / `data:` …）
 * - 不允许以 `/` 后接反斜杠（部分浏览器把 `/\evil.com` 当作 `//evil.com`）
 */

/** 校验失败时的兜底落地页 */
export const DEFAULT_REDIRECT = '/';

/** 形如 `scheme:` 的绝对地址（含 `javascript:` / `data:` 这类危险协议） */
const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** 把任意来源的 redirect 参数规整成安全的站内路径 */
export function sanitizeRedirect(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return DEFAULT_REDIRECT;

  // 去掉首尾空白与所有控制字符（`\n`、`\t` 常被用来绕过简单的字符串前缀检查）
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!value) return DEFAULT_REDIRECT;

  // 协议相对地址：`//evil.com`
  if (value.startsWith('//')) return DEFAULT_REDIRECT;
  // 反斜杠变体：`/\evil.com`、`\\evil.com`
  if (value.startsWith('/\\') || value.startsWith('\\\\')) return DEFAULT_REDIRECT;
  // 绝对地址（含各种协议）
  if (ABSOLUTE_URL_PATTERN.test(value)) return DEFAULT_REDIRECT;
  // 必须是站内路径（以单个 `/` 开头）；其余如 `upload`、`?x=1`、`#hash` 都不接受
  if (!value.startsWith('/')) return DEFAULT_REDIRECT;

  return value;
}

/** 生成 `/login?redirect=<path>` 的地址，供「去登录」按钮使用 */
export function buildLoginPath(redirect: string): string {
  const target = sanitizeRedirect(redirect);
  return `/login?redirect=${encodeURIComponent(target)}`;
}

/** 从 `window.location.search` 形式的字符串里取出并校验 `redirect` 参数 */
export function readRedirectParam(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return sanitizeRedirect(params.get('redirect'));
}
