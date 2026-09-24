/**
 * 本地假主站（**仅测试用**）：用 node:http 起一个随机端口的服务，模拟 7thcv.cn 的
 * `POST /api/login` 与成员专属的 `GET /api/kb/tree`，并用 node:crypto 手工
 * 拼出格式合法、签名真实的 HS256 JWT（不引入任何依赖）。
 *
 * ⚠️ 测试**绝不**请求真实的 7thcv.cn：把 MAIN_SITE_BASE_URL 指向本文件起的服务。
 * 这里的密钥只存在于测试进程，与服务端实现无关（服务端从不验签）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 假主站自己签、自己验的密钥（24h 有效期与主站一致）。
 *
 * ⚠️ 这里刻意使用一个**明显是测试用的合成值**，不要填真实主站的密钥：
 * 本仓库是公开的，而该密钥一旦泄露就能伪造主站任意成员的身份。
 * 假主站自己签自己验，用任何值功能都一样。
 */
export const FAKE_JWT_SECRET = 'fake-main-site-secret-for-tests-only';
/** 有效成员账号 */
export const MEMBER_CN = '张三';
export const MEMBER_PASSWORD = 'correct-horse';
/** 有效但非成员的账号 */
export const VISITOR_CN = '游客';

export interface JwtPayload {
  cn?: unknown;
  is_member?: unknown;
  exp?: number;
  [key: string]: unknown;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** 手工拼 header.payload.signature（HS256） */
export function signJwt(payload: JwtPayload, secret = FAKE_JWT_SECRET): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

/** 手工验签（假主站用；也用于测试里生成"签名被改坏"的令牌） */
export function verifyJwt(token: string, secret = FAKE_JWT_SECRET): JwtPayload | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const [header, body, signature] = segments as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const typed = payload as JwtPayload;
  if (typeof typed.exp === 'number' && typed.exp * 1000 <= Date.now()) return null;
  return typed;
}

/** 24h 后过期的载荷（与主站一致） */
export function memberPayload(cn: string = MEMBER_CN): JwtPayload {
  return { cn, is_member: true, exp: Math.floor(Date.now() / 1000) + 86400 };
}

/** 造一个成员令牌（测试直接用；签名真实，可被假主站接受） */
export function memberToken(cn: string = MEMBER_CN): string {
  return signJwt(memberPayload(cn));
}

/** 造一个"非成员"令牌 */
export function visitorToken(cn: string = VISITOR_CN): string {
  return signJwt({ cn, is_member: false, exp: Math.floor(Date.now() / 1000) + 86400 });
}

/**
 * 假主站的行为模式：
 * - `ok`（默认）：正常实现主站语义；
 * - `error-500`：所有接口 500（模拟主站故障 → 服务端应回 502）；
 * - `slow`：延迟 3s 再响应（配合 UPSTREAM_TIMEOUT_MS 触发超时 → 502）；
 * - `trust-all`：kb/tree 对**任何**令牌都返回 200（模拟过于宽松的上游，
 *   用来验证"上游说 OK 但令牌里解不出 cn → 401"这一分支）；
 * - `html-200`：kb/tree 返回 200 但内容是 HTML（SPA 回退页），必须被判为无效；
 * - `redirect-302`：kb/tree 302 到登录页，必须被判为无效（不跟随重定向）。
 */
export type FakeMainSiteMode = 'ok' | 'error-500' | 'slow' | 'trust-all' | 'html-200' | 'redirect-302';

export interface FakeMainSite {
  base: string;
  /** kb/tree 收到的校验次数 */
  verifyCalls(): number;
  /** login 收到的登录次数 */
  loginCalls(): number;
  setMode(mode: FakeMainSiteMode): void;
  close(): Promise<void>;
}

/** 读出请求体（上限 64KB，测试用足够） */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 64 * 1024) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** Authorization 头 → 令牌（剥掉可选的 "Bearer " 前缀） */
function headerToken(req: IncomingMessage): string {
  const raw = req.headers.authorization ?? '';
  const trimmed = raw.trim();
  const matched = /^Bearer\s+(.+)$/i.exec(trimmed);
  return (matched?.[1] ?? trimmed).trim();
}

/** 启动假主站；返回 { base, setMode, close } */
export async function startFakeMainSite(): Promise<FakeMainSite> {
  let mode: FakeMainSiteMode = 'ok';
  let verifyCount = 0;
  let loginCount = 0;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? '/';
    const pathname = url.split('?')[0] ?? '/';

    if (mode === 'slow') await sleep(3000);

    if (mode === 'error-500') {
      await readBody(req);
      sendJson(res, 500, { message: '主站内部错误' });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      loginCount += 1;
      const raw = await readBody(req);
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        sendJson(res, 400, { message: '请求体不是 JSON' });
        return;
      }

      const cn = typeof body.cn === 'string' ? body.cn : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (cn === MEMBER_CN && password === MEMBER_PASSWORD) {
        sendJson(res, 200, {
          token: signJwt(memberPayload(cn)),
          cn,
          is_member: true,
          message: '登录成功',
        });
        return;
      }
      if (cn === VISITOR_CN && password !== '') {
        // 账号有效但不是社团成员：主站仍签发令牌，靠 is_member 表达身份
        sendJson(res, 200, {
          token: visitorToken(cn),
          cn,
          is_member: false,
          message: '登录成功（访客）',
        });
        return;
      }
      sendJson(res, 401, { message: '用户名或密码错误' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/kb/tree') {
      verifyCount += 1;
      if (mode === 'trust-all') {
        sendJson(res, 200, { tree: [] });
        return;
      }
      if (mode === 'html-200') {
        const html = '<!doctype html><html><body>请先登录</body></html>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (mode === 'redirect-302') {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
      }

      const token = headerToken(req);
      const payload = token === '' ? null : verifyJwt(token);
      if (!payload) {
        sendJson(res, 401, { message: '未登录或令牌无效' });
        return;
      }
      if (payload.is_member !== true) {
        sendJson(res, 403, { message: '访客无法访问该功能' });
        return;
      }
      sendJson(res, 200, { tree: [] });
      return;
    }

    sendJson(res, 404, { message: '接口不存在' });
  };

  const server: Server = createServer((req, res) => {
    // 客户端超时/中断时不要让 socket 错误冒泡成未处理异常
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    handler(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: '假主站异常' });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${address.port}`,
    verifyCalls: () => verifyCount,
    loginCalls: () => loginCount,
    setMode: (next) => {
      mode = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * 拿一个**确定已关闭**的端口地址：用来模拟"主站挂掉"（连接被拒 → 502）。
 */
export async function reserveDeadBaseUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
