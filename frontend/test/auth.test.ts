/**
 * 登录/鉴权单测（契约 §8 · v2.1）。
 *
 * 覆盖四块：
 * 1. `auth/storage` 的读写与容错（隐私模式下 localStorage 直接抛异常，不能连累页面）；
 * 2. 401 / 403 / 502 的语义区分（用户名密码错 / 不是社团成员 / 主站不可用）；
 * 3. `?redirect=` 的**开放重定向防护** —— 这是安全相关，必须逐条钉死；
 * 4. `api/client` 的 `Authorization` 注入（登录令牌是 v2.1 上传的前提）。
 *
 * 全部不发真实网络请求：fetch 一律打桩（做法与 test/api.client.test.ts 一致）。
 */
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

process.env.VITE_API_BASE = '';
process.env.VITE_UPLOAD_TOKEN = 'ci-token';

// 静态 import 会先于上面的赋值执行，故用动态 import 确保环境变量已就绪
const { ApiError, request, toApiError } = await import('../src/api/client.ts');
const { login: apiLogin, fetchMe } = await import('../src/api/auth.ts');
const {
  AUTH_TOKEN_KEY,
  AUTH_USER_KEY,
  clearAuthStorage,
  getAuthToken,
  getStoredUser,
  setAuthToken,
  setStoredUser,
} = await import('../src/auth/storage.ts');
const { describeAuthError, describeUploadAuthError } = await import('../src/auth/errors.ts');
const { DEFAULT_REDIRECT, buildLoginPath, readRedirectParam, sanitizeRedirect } = await import(
  '../src/auth/redirect.ts'
);
const { basenameFromBaseUrl } = await import('../src/config.ts');

/* ------------------------------ localStorage 打桩 ------------------------------ */

/** 内存版 localStorage（Node 默认没有 localStorage） */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

/** 任何操作都抛异常的 storage（模拟隐私模式 / 禁用站点数据） */
const throwingStorage = {
  get length(): number {
    throw new DOMException('访问被拒绝', 'SecurityError');
  },
  clear() {
    throw new DOMException('访问被拒绝', 'SecurityError');
  },
  getItem() {
    throw new DOMException('访问被拒绝', 'SecurityError');
  },
  key() {
    throw new DOMException('访问被拒绝', 'SecurityError');
  },
  removeItem() {
    throw new DOMException('访问被拒绝', 'SecurityError');
  },
  setItem() {
    throw new DOMException('访问被拒绝', 'SecurityError');
  },
} as unknown as Storage;

function installLocalStorage(value: Storage | undefined): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value,
    configurable: true,
    writable: true,
  });
}

let memory: Storage;

beforeEach(() => {
  memory = createMemoryStorage();
  installLocalStorage(memory);
});

afterEach(() => {
  installLocalStorage(undefined);
  globalThis.fetch = originalFetch;
});

/* ------------------------------ fetch 打桩 ------------------------------ */

const originalFetch = globalThis.fetch;

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

let captured: CapturedCall[] = [];

function stubFetch(handler: (call: CapturedCall) => Response | Promise<Response>): void {
  captured = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: CapturedCall = {
      url: target,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    captured.push(call);
    return handler(call);
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/* ============================== 1. storage ============================== */

test('storage：令牌与用户信息按约定的键名读写', () => {
  setAuthToken('jwt-abc123');
  setStoredUser({ cn: '张三', isMember: true });

  // 键名是契约约定的，不能改（老用户升级后要能读回自己的登录态）
  assert.equal(memory.getItem(AUTH_TOKEN_KEY), 'jwt-abc123');
  assert.equal(getAuthToken(), 'jwt-abc123');
  assert.deepEqual(getStoredUser(), { cn: '张三', isMember: true });

  const rawUser = memory.getItem(AUTH_USER_KEY);
  assert.ok(rawUser);
  assert.deepEqual(JSON.parse(rawUser), { cn: '张三', isMember: true });
});

test('storage：令牌两侧空白被规整，空串等于清除', () => {
  setAuthToken('  jwt-x  ');
  assert.equal(getAuthToken(), 'jwt-x');

  setAuthToken('   ');
  assert.equal(getAuthToken(), '');
  assert.equal(memory.getItem(AUTH_TOKEN_KEY), null);
});

test('storage：损坏的用户 JSON 返回 null 并顺手清理脏数据', () => {
  memory.setItem(AUTH_USER_KEY, '{不是合法 JSON');
  assert.equal(getStoredUser(), null);
  // 脏数据被清掉，避免每次启动都解析失败
  assert.equal(memory.getItem(AUTH_USER_KEY), null);

  // 结构不对（cn 不是非空字符串）同样视为无效
  memory.setItem(AUTH_USER_KEY, JSON.stringify({ cn: 123, isMember: true }));
  assert.equal(getStoredUser(), null);

  // isMember 缺失时从严按 false 处理（后端并行开发期间可能还没返回该字段）
  memory.setItem(AUTH_USER_KEY, JSON.stringify({ cn: '李四' }));
  assert.deepEqual(getStoredUser(), { cn: '李四', isMember: false });
});

test('storage：isMember 非布尔值一律归为 false（不信任存储内容）', () => {
  memory.setItem(AUTH_USER_KEY, JSON.stringify({ cn: '王五', isMember: 'true' }));
  assert.deepEqual(getStoredUser(), { cn: '王五', isMember: false });
});

test('storage：localStorage 不存在时（Node / SSR）安静地退化为无持久化', () => {
  installLocalStorage(undefined);
  assert.equal(getAuthToken(), '');
  assert.equal(getStoredUser(), null);
  assert.doesNotThrow(() => setAuthToken('jwt-x'));
  assert.doesNotThrow(() => setStoredUser({ cn: '张三', isMember: true }));
  assert.doesNotThrow(() => clearAuthStorage());
});

test('storage：隐私模式下 localStorage 抛异常也不崩，读写都安全降级', () => {
  installLocalStorage(throwingStorage);

  assert.equal(getAuthToken(), '');
  assert.equal(getStoredUser(), null);
  assert.doesNotThrow(() => setAuthToken('jwt-x'));
  assert.doesNotThrow(() => setStoredUser({ cn: '张三', isMember: true }));
  assert.doesNotThrow(() => clearAuthStorage());
  assert.equal(getAuthToken(), '');
});

test('clearAuthStorage 清空令牌与用户两个键（契约无 logout 端点，只清本地）', () => {
  setAuthToken('jwt-abc');
  setStoredUser({ cn: '张三', isMember: true });

  clearAuthStorage();

  assert.equal(getAuthToken(), '');
  assert.equal(getStoredUser(), null);
  assert.equal(memory.getItem(AUTH_TOKEN_KEY), null);
  assert.equal(memory.getItem(AUTH_USER_KEY), null);
});

/* ============================== 2. 401 / 403 / 502 语义 ============================== */

test('describeAuthError：401 = 用户名或密码错，403 = 不是社团成员（必须区分开）', () => {
  const unauthorized = describeAuthError(new ApiError('UNAUTHORIZED', '无效凭据', 401));
  assert.equal(unauthorized.kind, 'invalid-credentials');
  assert.match(unauthorized.message, /用户名或密码错误/);

  const notMember = describeAuthError(new ApiError('NOT_A_MEMBER', '不是成员', 403));
  assert.equal(notMember.kind, 'not-a-member');
  assert.match(notMember.message, /不是社团成员/);
  assert.match(notMember.message, /无法上传/);
});

test('describeAuthError：502 主站不可用属于服务端故障，不能提示「密码错」', () => {
  const upstream = describeAuthError(new ApiError('UPSTREAM_UNAVAILABLE', '主站挂了', 502));
  assert.equal(upstream.kind, 'upstream');
  assert.match(upstream.message, /主站/);
  assert.doesNotMatch(upstream.message, /密码/);
});

test('describeUploadAuthError：登录启用时 401 提示重新登录，未启用时才是上传令牌问题', () => {
  const unauthorized = new ApiError('UNAUTHORIZED', '未登录', 401);

  assert.match(describeUploadAuthError(unauthorized, true), /重新登录/);
  assert.match(describeUploadAuthError(unauthorized, false), /上传令牌/);

  const notMember = new ApiError('NOT_A_MEMBER', '不是成员', 403);
  assert.match(describeUploadAuthError(notMember, true), /不是社团成员/);
  assert.match(describeUploadAuthError(notMember, false), /不是社团成员/);
});

test('错误信封：403 → NOT_A_MEMBER、502 → UPSTREAM_UNAVAILABLE，且带中文兜底文案', () => {
  const forbidden = toApiError(403, undefined, '');
  assert.equal(forbidden.code, 'NOT_A_MEMBER');
  assert.equal(forbidden.message, '该账号不是社团成员，无法上传。');

  const upstream = toApiError(502, undefined, '');
  assert.equal(upstream.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(upstream.message, '主站登录服务暂时不可用，请稍后重试。');
});

test('后端自己的中文 message 优先于兜底文案（403 也一样）', () => {
  const error = toApiError(403, {
    error: { code: 'NOT_A_MEMBER', message: '你还不是本社团成员哦' },
  });
  assert.equal(error.code, 'NOT_A_MEMBER');
  assert.equal(error.message, '你还不是本社团成员哦');
});

/* ============================== 3. redirect 开放重定向防护 ============================== */

test('sanitizeRedirect：站内相对路径被放行', () => {
  assert.equal(sanitizeRedirect('/upload'), '/upload');
  assert.equal(sanitizeRedirect('/p/prj_1'), '/p/prj_1');
  assert.equal(sanitizeRedirect('/p/prj_1?tab=info#x'), '/p/prj_1?tab=info#x');
  // 带空白也能规整
  assert.equal(sanitizeRedirect('  /upload  '), '/upload');
});

test('sanitizeRedirect：协议相对地址 //evil.com 被拒绝并回退首页', () => {
  assert.equal(sanitizeRedirect('//evil.com'), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect('///evil.com'), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect('//evil.com/psd'), DEFAULT_REDIRECT);
});

test('sanitizeRedirect：绝对地址（http/https）被拒绝并回退首页', () => {
  assert.equal(sanitizeRedirect('https://evil.com'), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect('http://evil.com/login'), DEFAULT_REDIRECT);
  // 没有斜杠的写法同样是绝对地址
  assert.equal(sanitizeRedirect('https:evil.com'), DEFAULT_REDIRECT);
});

test('sanitizeRedirect：javascript: / data: 等危险协议被拒绝', () => {
  assert.equal(sanitizeRedirect('javascript:alert(1)'), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect('JavaScript:alert(1)'), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect('data:text/html;base64,PHNjcmlwdD4='), DEFAULT_REDIRECT);
});

test('sanitizeRedirect：反斜杠与控制字符变体不能绕过检查', () => {
  // 部分浏览器把 /\evil.com 当作协议相对地址
  assert.equal(sanitizeRedirect('/\\evil.com'), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect('\\\\evil.com'), DEFAULT_REDIRECT);
  // 换行/制表符插入（会被去掉后仍判定为外站）
  assert.equal(sanitizeRedirect('//\nevil.com'), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect('/\t/evil.com'), DEFAULT_REDIRECT);
});

test('sanitizeRedirect：非路径形式一律回退首页', () => {
  assert.equal(sanitizeRedirect('evil.com'), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect('upload'), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect('?redirect=/upload'), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect(''), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect('   '), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect(null), DEFAULT_REDIRECT);
  assert.equal(sanitizeRedirect(undefined), DEFAULT_REDIRECT);
});

test('buildLoginPath 生成编码后的 /login?redirect=，且对危险值先做净化', () => {
  assert.equal(buildLoginPath('/upload'), '/login?redirect=%2Fupload');
  assert.equal(buildLoginPath('https://evil.com'), '/login?redirect=%2F');
});

test('readRedirectParam 从 query string 取值并校验', () => {
  assert.equal(readRedirectParam('?redirect=%2Fupload'), '/upload');
  assert.equal(readRedirectParam('redirect=/p/prj_1'), '/p/prj_1');
  assert.equal(readRedirectParam('?redirect=https%3A%2F%2Fevil.com'), DEFAULT_REDIRECT);
  assert.equal(readRedirectParam('?redirect=//evil.com'), DEFAULT_REDIRECT);
  assert.equal(readRedirectParam('?other=1'), DEFAULT_REDIRECT);
  assert.equal(readRedirectParam(''), DEFAULT_REDIRECT);
});

/* ============================== 4. Authorization 注入 ============================== */

test('request：本地有登录令牌时自动带 Authorization（契约 §8.2，不加 Bearer 前缀）', async () => {
  setAuthToken('jwt-abc123');
  stubFetch(() => jsonResponse(200, { items: [] }));

  await request('/api/projects');

  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers.get('Authorization'), 'jwt-abc123');
});

test('request：本地没有令牌时不发送空的 Authorization 头', async () => {
  stubFetch(() => jsonResponse(200, { items: [] }));

  await request('/api/projects');

  assert.equal(captured[0].headers.get('Authorization'), null);
});

test('request：withAuth=false 时不带令牌（登录请求不能被旧令牌干扰）', async () => {
  setAuthToken('jwt-stale');
  stubFetch(() => jsonResponse(200, { items: [] }));

  await request('/api/projects', { withAuth: false });

  assert.equal(captured[0].headers.get('Authorization'), null);
});

test('request：Authorization 与 x-upload-token 互不干扰，可同时出现', async () => {
  setAuthToken('jwt-abc123');
  stubFetch(() => jsonResponse(201, { item: { id: 'prj_1' } }));

  await request('/api/projects', {
    method: 'POST',
    withUploadToken: true,
    tokenRequired: true,
  });

  // 登录令牌（契约 §8.3 第 2 条）与自动化旁路令牌（契约 §0.3）是两套独立凭据
  assert.equal(captured[0].headers.get('Authorization'), 'jwt-abc123');
  assert.equal(captured[0].headers.get('x-upload-token'), 'ci-token');
});

test('apiLogin：POST /api/auth/login，请求体是 { cn, password }，且不带本地旧令牌', async () => {
  setAuthToken('jwt-stale');
  stubFetch(() =>
    jsonResponse(200, { token: 'jwt-new', cn: '张三', isMember: true, expiresInSeconds: 86400 }),
  );

  const result = await apiLogin('  张三  ', 'pw-123');

  assert.equal(captured[0].url, '/api/auth/login');
  assert.equal(captured[0].method, 'POST');
  assert.equal(captured[0].headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(captured[0].headers.get('Authorization'), null);
  assert.deepEqual(JSON.parse(String(captured[0].body)), { cn: '张三', password: 'pw-123' });
  assert.equal(result.token, 'jwt-new');
  assert.equal(result.isMember, true);
  assert.equal(result.expiresInSeconds, 86400);
});

test('apiLogin：401 原样抛出 UNAUTHORIZED，交由页面映射文案', async () => {
  stubFetch(() =>
    jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: '用户名或密码错误' } }),
  );

  await assert.rejects(
    () => apiLogin('张三', 'bad-pw'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'UNAUTHORIZED');
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test('apiLogin：403 抛出 NOT_A_MEMBER（账号有效但不是社团成员）', async () => {
  stubFetch(() =>
    jsonResponse(403, { error: { code: 'NOT_A_MEMBER', message: '不是社团成员' } }),
  );

  await assert.rejects(
    () => apiLogin('张三', 'pw'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'NOT_A_MEMBER');
      assert.equal(describeAuthError(error).kind, 'not-a-member');
      return true;
    },
  );
});

test('fetchMe：GET /api/auth/me 并带上登录令牌（契约 §8.2）', async () => {
  setAuthToken('jwt-abc123');
  stubFetch(() => jsonResponse(200, { cn: '张三', isMember: true }));

  const me = await fetchMe();

  assert.equal(captured[0].url, '/api/auth/me');
  assert.equal(captured[0].method, 'GET');
  assert.equal(captured[0].headers.get('Authorization'), 'jwt-abc123');
  assert.deepEqual(me, { cn: '张三', isMember: true });
});

test('fetchMe：401 表示令牌无效/过期，调用方可据此清空登录态', async () => {
  setAuthToken('jwt-expired');
  stubFetch(() => jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: '令牌已过期' } }));

  await assert.rejects(
    () => fetchMe(),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'UNAUTHORIZED');
      return true;
    },
  );
});

/* ============================== 5. 子路径部署（契约 §8.4） ============================== */

test('basenameFromBaseUrl：/psd/ → /psd，根路径 → /（react-router 不接受尾斜杠）', () => {
  assert.equal(basenameFromBaseUrl('/'), '/');
  assert.equal(basenameFromBaseUrl(''), '/');
  assert.equal(basenameFromBaseUrl('/psd/'), '/psd');
  assert.equal(basenameFromBaseUrl('/psd'), '/psd');
  assert.equal(basenameFromBaseUrl('/a/b//'), '/a/b');
});
