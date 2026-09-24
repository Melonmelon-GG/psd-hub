/**
 * 运行时配置：API 基址与 URL 拼接。
 * 拼接规则严格遵循契约 §5。
 *
 * 注意：本模块要能在两种环境下工作——
 * 1) Vite 构建/运行时（`import.meta.env` 存在）；
 * 2) Node（单元测试，无 `import.meta.env`，也无 `window`）。
 * 因此所有环境访问都做了存在性判断与兜底。
 */

/** 上传令牌在 localStorage 中的键名（契约 §0.3 约定由前端持有） */
export const TOKEN_STORAGE_KEY = 'psd-hub-token';

/** 读取构建期注入的环境变量；Node 下回退到 process.env */
function readEnv(key: string): string {
  const metaEnv = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const fromMeta = metaEnv?.[key];
  if (typeof fromMeta === 'string') return fromMeta;

  const fromProcess = typeof process !== 'undefined' ? process.env?.[key] : undefined;
  return typeof fromProcess === 'string' ? fromProcess : '';
}

/** 契约 §5：(p: string) => `${base.replace(/\/$/, '')}${p}` —— 抽成纯函数便于单测 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

/** 去掉尾斜杠后的基址；空串表示同源 */
export const API_BASE = readEnv('VITE_API_BASE').replace(/\/$/, '');

/**
 * Vite 会把 `base` 注入为 `import.meta.env.BASE_URL`，形如 `/` 或 `/psd/`。
 * react-router 的 `basename` 不接受尾斜杠（`/psd/` 会被拼成 `//psd//`），
 * 因此统一去掉尾部斜杠；根路径回落为 `/`。
 * 契约 §8.4：部署在 `https://7thcv.cn/psd/` 时 base 为 `/psd/`，此函数得到 `/psd`。
 */
export function basenameFromBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') || '/';
}

/** 路由 basename（构建期由 Vite 的 base 决定；本地开发为 "/"） */
export const ROUTER_BASENAME = basenameFromBaseUrl(readEnv('BASE_URL'));

/**
 * 契约 §5：`const url = (p: string) => `${base.replace(/\/$/, '')}${p}``
 * 入参 p 必须以 "/" 开头；用于所有 API 路径与图片/下载 URL。
 */
export function url(p: string): string {
  return joinUrl(API_BASE, p);
}

/** 构建期注入的上传令牌（VITE_UPLOAD_TOKEN），可为空 */
const ENV_UPLOAD_TOKEN = readEnv('VITE_UPLOAD_TOKEN').trim();

/** 安全访问 localStorage（Node / 隐私模式下可能不可用） */
function readStorage(key: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // 忽略存储失败（隐私模式/配额），仅影响令牌持久化
  }
}

/**
 * 读取上传令牌：优先浏览器本地存储（页面上填写的），其次构建期环境变量。
 * 契约 §0.3：服务端未要求令牌时不要发送空令牌头，由 client 层负责判断。
 */
export function getUploadToken(): string {
  const stored = readStorage(TOKEN_STORAGE_KEY);
  if (stored && stored.trim()) return stored.trim();
  return ENV_UPLOAD_TOKEN;
}

/** 写入上传令牌；传空字符串等于清除 */
export function setUploadToken(token: string): void {
  const trimmed = token.trim();
  writeStorage(TOKEN_STORAGE_KEY, trimmed ? trimmed : null);
}

/** 请求默认超时（毫秒）；下载 PSD 字节流的请求会单独放宽 */
export const DEFAULT_TIMEOUT_MS = 20000;

/** 流式下载 PSD 的超时（毫秒），大文件需要更长时间 */
export const STREAM_TIMEOUT_MS = 180000;

/** 大文件保护阈值：超过此体积需用户确认后再解析（150MB） */
export const LARGE_PSD_BYTES = 150 * 1024 * 1024;
