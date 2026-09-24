/**
 * 主站登录系统客户端（契约 §8）。
 *
 * 主站 `7thcv.cn` 是一个 Go + Echo 应用，**HS256 JWT**（载荷含 `cn` 与 `is_member`，exp 24h）：
 *   POST {base}/api/login          { cn, password } → { token, cn, is_member, message }
 *   GET  {base}{verifyPath}        成员专属且只读的接口（默认 /api/kb/tree）
 *   后续请求头：Authorization: <token>（主站中间件会自行剥掉可选的 "Bearer " 前缀）
 *
 * ⚠️ 关键安全约束：本服务**不持有主站 JWT 的签名密钥**，因此**绝不在本地验签**
 *    —— 本地验签需要密钥，持有密钥就等于能伪造任何人的身份。
 *    令牌的真伪只能由主站说了算：我们把令牌转发给主站的成员专属接口，
 *    200 → 有效；401 → 无效；403 → 不是成员。
 *
 * 日志纪律：**密码与令牌一律不进日志**（连 debug 级也不打），任何异常都只记录
 * 状态码 / 形态等非敏感信息；响应体只在内部解析，不写入日志。
 */
import type { AppConfig } from '../config.js';
import { DEFAULT_MAIN_SITE_VERIFY_PATH } from '../config.js';

/** 调用主站所需的配置（从 AppConfig 抽取，便于测试注入） */
export interface MainSiteOptions {
  /** 主站基址，空串 = 未启用登录；不带尾斜杠（config 已归一化） */
  baseUrl: string;
  /** 校验路径，默认 /api/kb/tree */
  verifyPath: string;
  /** 单次请求超时（毫秒），由 AbortSignal.timeout 实现 */
  timeoutMs: number;
}

/** 登录成功（契约 §8.1） */
export interface MainSiteLoginResult {
  token: string;
  cn: string;
  isMember: boolean;
}

/** 登录失败的原因（映射到契约 §8.1 的三种失败情形） */
export type MainSiteLoginFailureKind = 'invalid-credentials' | 'not-member' | 'unavailable';

/** 登录失败异常：调用方按 kind 映射 HTTP 状态码 */
export class MainSiteLoginError extends Error {
  readonly kind: MainSiteLoginFailureKind;

  constructor(kind: MainSiteLoginFailureKind, message: string) {
    super(message);
    this.name = 'MainSiteLoginError';
    this.kind = kind;
  }
}

/**
 * 校验结论（契约 §8.3）：200 → ok；401 → invalid；403 → not-member；
 * 网络错误 / 超时 / 5xx / 其它异常一律 unavailable（**失败关闭**，绝不因主站故障而放行）。
 */
export type MemberTokenVerdict = 'ok' | 'invalid' | 'not-member' | 'unavailable';

/** 从 AppConfig 抽取主站客户端配置 */
export function mainSiteOptions(config: AppConfig): MainSiteOptions {
  return {
    baseUrl: config.mainSiteBaseUrl,
    verifyPath: config.mainSiteVerifyPath || DEFAULT_MAIN_SITE_VERIFY_PATH,
    timeoutMs: config.upstreamTimeoutMs,
  };
}

/**
 * 令牌长度上限：合法 JWT 远小于该值；超长令牌直接判为解析失败，
 * 避免拿畸形超长串做无谓的 base64 解码。
 */
const MAX_TOKEN_LENGTH = 8192;
/** 能安全接收的超长响应体上限（超时保护之外的第二道闸） */
const MAX_UPSTREAM_BODY_BYTES = 1024 * 1024;

/** 丢弃响应体，避免连接因未消费 body 而滞留 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 已经消费/已锁定：忽略
  }
}

/**
 * 读取响应体（带上限），失败返回 null。
 * 用于解析主站 /api/login 的 JSON；非 JSON / 超长 / 读取失败都不抛给调用方。
 */
async function readJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (text.length > MAX_UPSTREAM_BODY_BYTES) return null;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 从任意 JSON 值里取非空字符串 */
function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * POST {base}/api/login —— 把凭据**转发**给主站（契约 §8.1）。
 * 本服务不保存密码、不落库、不写日志。
 *
 * 成功 → { token, cn, isMember }；
 * 失败 → 抛 MainSiteLoginError：
 *   用户名/密码错误 → kind = 'invalid-credentials'（HTTP 401）
 *   账号有效但非社团成员 → kind = 'not-member'（HTTP 403）
 *   主站不可达/超时/5xx/响应不可解析 → kind = 'unavailable'（HTTP 502）
 */
export async function loginOnMainSite(
  cn: string,
  password: string,
  options: MainSiteOptions,
): Promise<MainSiteLoginResult> {
  if (options.baseUrl === '') {
    throw new MainSiteLoginError('unavailable', '服务端未配置主站地址（MAIN_SITE_BASE_URL），无法登录');
  }

  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cn, password }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    // 网络错误 / 超时（AbortError）：只报"不可达"，不回显任何凭据
    throw new MainSiteLoginError('unavailable', '主站登录服务不可达或超时');
  }

  if (response.status === 401) {
    await discardBody(response);
    throw new MainSiteLoginError('invalid-credentials', '用户名或密码错误');
  }
  if (response.status === 403) {
    await discardBody(response);
    throw new MainSiteLoginError('not-member', '该账号不是社团成员');
  }
  if (!response.ok) {
    await discardBody(response);
    throw new MainSiteLoginError('unavailable', `主站登录服务返回异常状态（${response.status}）`);
  }

  const payload = await readJsonBody(response);
  if (!payload) {
    throw new MainSiteLoginError('unavailable', '主站登录响应无法解析');
  }

  const token = readNonEmptyString(payload.token);
  if (!token) {
    throw new MainSiteLoginError('unavailable', '主站登录响应缺少令牌');
  }

  // 契约 §8.1：账号有效但不是社团成员 → 403 NOT_A_MEMBER。
  // 这里读的是主站**响应体**里的 is_member，而不是本地解令牌（我们不做本地验签）。
  // 即便攻击者伪造了响应体也无意义：上传时仍会拿令牌去主站再校验一次。
  if (payload.is_member !== true) {
    throw new MainSiteLoginError('not-member', '该账号不是社团成员，无法登录展示台');
  }

  // 展示给前端的 cn 优先取**令牌载荷里的 cn**（与后续上传时写入 author 的值严格一致）
  const cnFromToken = readCnFromTokenUnverified(token);
  const cnFromBody = readNonEmptyString(payload.cn);
  return {
    token,
    cn: cnFromToken ?? cnFromBody ?? cn,
    isMember: true,
  };
}

/**
 * GET {base}{verifyPath} —— 用主站的成员专属接口校验令牌（契约 §8.3）。
 *
 * 200 → 'ok'；401 → 'invalid'；403 → 'not-member'；
 * 网络错误 / 超时 / 5xx / 其它状态码 → 'unavailable'（失败关闭）。
 *
 * 两个防呆（都属于"宁可判无效，也不放行"的方向）：
 * - `redirect: 'manual'`：主站若把未认证请求 302 到登录页，跟随重定向可能拿到 200 HTML，
 *   那会被误判成"校验通过"；因此不跟随，3xx 一律视为未认证（invalid）。
 * - 200 但 Content-Type 是 text/html（SPA 回退页面）→ 同样视为无效。
 */
export async function verifyMemberToken(
  token: string,
  options: MainSiteOptions,
): Promise<MemberTokenVerdict> {
  if (token === '' || token.length > MAX_TOKEN_LENGTH) return 'invalid';
  if (options.baseUrl === '') return 'unavailable';

  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${options.verifyPath}`, {
      method: 'GET',
      headers: { Authorization: token },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    return 'unavailable';
  }

  const status = response.status;
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  await discardBody(response);

  if (status === 200) {
    if (contentType.includes('text/html')) return 'invalid';
    return 'ok';
  }
  if (status === 401) return 'invalid';
  if (status === 403) return 'not-member';
  // 3xx：未跟随重定向（多半是被踢到登录页）→ 未认证
  if (status >= 300 && status < 400) return 'invalid';
  return 'unavailable';
}

/**
 * 只做 base64url 解码，读取 JWT 载荷里的 `cn`，**不做任何验签**。
 *
 * 为什么这样是安全的：调用方**必须**先用 verifyMemberToken 拿主站校验通过，
 * 再调用本函数；此时令牌已由主站确认有效，其载荷里的 cn 才可信。
 * 单独调用它得到的 cn 只是"用户自报的名字"，绝不可作为身份依据。
 *
 * 容错：段缺失 / base64 解码失败 / 不是 JSON 对象 / cn 非字符串或为空 → 返回 null。
 */
export function readCnFromTokenUnverified(token: string): string | null {
  if (token === '' || token.length > MAX_TOKEN_LENGTH) return null;
  const segments = token.split('.');
  // header.payload.signature = 3 段；至少要有 header 与 payload
  if (segments.length < 2) return null;
  const payloadSegment = segments[1];
  if (!payloadSegment) return null;

  let payload: unknown;
  try {
    const json = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const cn = (payload as Record<string, unknown>).cn;
  if (typeof cn !== 'string') return null;
  const trimmed = cn.trim();
  return trimmed === '' ? null : trimmed;
}
