/**
 * api/client 测试：
 * - 错误信封被正确转成 ApiError（含 code 与 details）
 * - 配置令牌时带上 x-upload-token 请求头，未要求时不带
 * - 契约 §5 的 url() 拼接在 VITE_API_BASE 为空 / 带尾斜杠两种情况下的结果
 *
 * 说明：为验证「带尾斜杠的 VITE_API_BASE」，这里在为不同 query 的模块实例中
 * 重新加载 config.ts（Node 把带不同 query 的同一文件视为不同模块）。
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

process.env.VITE_UPLOAD_TOKEN = 'env-token-abc123';
process.env.VITE_API_BASE = '';

// 静态 import 会先于上面的赋值执行，因此这里用动态 import 确保环境变量已就绪
const { ApiError, request, toApiError } = await import('../src/api/client.ts');
const { API_BASE, getUploadToken, joinUrl, url } = await import('../src/config.ts');
const {
  buildImageDownloadUrl,
  buildImageUrl,
  buildNetdiskGoUrl,
  listProjects,
  normalizeSort,
  updateProject,
} = await import('../src/api/projects.ts');
const { buildUploadFormData } = await import('../src/upload/uploadProject.ts');

/* ------------------------------ fetch 打桩工具 ------------------------------ */

const originalFetch = globalThis.fetch;

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

let captured: CapturedCall[] = [];

/** 用打桩替换 globalThis.fetch，记录调用并返回预设响应 */
function stubFetch(
  handler: (call: CapturedCall) => Response | Promise<Response>,
): void {
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

/** 构造一个 JSON 响应 */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/* ------------------------------ 错误信封 → ApiError ------------------------------ */

test('toApiError 解析契约 §0.2 错误信封', () => {
  const error = toApiError(400, {
    error: {
      code: 'BAD_REQUEST',
      message: '标题不能为空',
      details: { field: 'title', reason: '标题不能为空' },
    },
  });

  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'BAD_REQUEST');
  assert.equal(error.message, '标题不能为空');
  assert.equal(error.status, 400);
  assert.equal(error.details?.field, 'title');
  assert.equal(error.details?.reason, '标题不能为空');
});

test('request 在非 2xx 时抛出带 code 与 details 的 ApiError', async () => {
  stubFetch(() =>
    jsonResponse(409, {
      error: {
        code: 'DUPLICATE',
        message: '这张 PNG 已存在（内容完全相同）',
        details: { existingId: 'prj_9f2c1ab73d4e' },
      },
    }),
  );

  await assert.rejects(
    () => request('/api/projects', { method: 'POST' }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'DUPLICATE');
      assert.equal(error.message, '这张 PNG 已存在（内容完全相同）');
      assert.equal(error.status, 409);
      assert.equal(error.existingId, 'prj_9f2c1ab73d4e');
      return true;
    },
  );
});

test('409 DUPLICATE 的 existingId 便捷取值为 undefined（details 缺失时）', () => {
  const error = toApiError(409, { error: { code: 'DUPLICATE', message: '已存在' } });
  assert.equal(error.existingId, undefined);
});

test('429 会把 Retry-After 响应头透出到 details', async () => {
  stubFetch(() =>
    jsonResponse(429, { error: { code: 'RATE_LIMITED', message: '请求过于频繁' } }, {
      'Retry-After': '30',
    }),
  );

  await assert.rejects(
    () => request('/api/projects'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.details?.retryAfter, '30');
      return true;
    },
  );
});

test('无法解析信封时按 HTTP 状态码兜底并给出中文文案', () => {
  const error = toApiError(413, undefined, '<html>Proxy Error</html>');
  assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(error.message, '文件体积超过服务端上限。');

  const notFound = toApiError(404, undefined, '');
  assert.equal(notFound.code, 'NOT_FOUND');
  assert.equal(notFound.message, '请求的内容不存在或已被删除。');

  // v2.0：415 的兜底文案指向 PNG
  const unsupported = toApiError(415, undefined, '');
  assert.equal(unsupported.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(unsupported.message, '文件类型不受支持，请上传 .png 图片。');
});

test('未知的 error.code 归入 HTTP 状态码对应的已知错误码', () => {
  const error = toApiError(500, {
    error: { code: 'SOMETHING_NEW', message: '服务端炸了' },
  });
  assert.equal(error.code, 'INTERNAL');
  // 后端的中文 message 仍然被保留
  assert.equal(error.message, '服务端炸了');
});

test('网络故障被转成 NETWORK_ERROR 而不是抛原始异常', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  await assert.rejects(
    () => request('/api/projects'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'NETWORK_ERROR');
      return true;
    },
  );
});

/* ------------------------------ 令牌头 ------------------------------ */

test('配置了令牌且 tokenRequired 时带上 x-upload-token', async () => {
  stubFetch(() => jsonResponse(201, { item: { id: 'prj_1' } }));

  await request('/api/projects', { method: 'POST', withUploadToken: true, tokenRequired: true });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers.get('x-upload-token'), 'env-token-abc123');
});

test('tokenRequired 为 false 时不发送令牌头（契约 §0.3）', async () => {
  stubFetch(() => jsonResponse(201, { item: { id: 'prj_1' } }));

  await request('/api/projects', { method: 'POST', withUploadToken: true, tokenRequired: false });

  assert.equal(captured[0].headers.get('x-upload-token'), null);
});

test('withUploadToken 未开启时不发送令牌头（GET 等读取接口）', async () => {
  stubFetch(() => jsonResponse(200, { items: [] }));

  await request('/api/projects');

  assert.equal(captured[0].headers.get('x-upload-token'), null);
});

test('getUploadToken 在无 window 环境下回落到构建期环境变量', () => {
  assert.equal(getUploadToken(), 'env-token-abc123');
});

/* ------------------------------ 请求细节 ------------------------------ */

test('查询参数被拼接且忽略空值，路径经 url() 加前缀', async () => {
  stubFetch(() => jsonResponse(200, { items: [], total: 0, page: 1, pageSize: 12, totalPages: 0 }));

  await request('/api/projects', {
    query: { q: '深色', tag: undefined, page: 2, pageSize: 12, author: '', sort: 'newest' },
  });

  const target = captured[0].url;
  assert.ok(target.startsWith('/api/projects?'), `实际得到的 URL 是 ${target}`);
  const params = new URLSearchParams(target.split('?')[1]);
  assert.equal(params.get('q'), '深色');
  assert.equal(params.get('page'), '2');
  assert.equal(params.get('pageSize'), '12');
  assert.equal(params.get('sort'), 'newest');
  // undefined 与空串都不应出现在 query 中
  assert.equal(params.has('tag'), false);
  assert.equal(params.has('author'), false);
});

test('JSON 请求体自动设置 Content-Type 并被序列化', async () => {
  stubFetch(() => jsonResponse(200, { item: { id: 'prj_1' } }));

  await request('/api/projects/prj_1', { method: 'PATCH', json: { title: '新标题' } });

  assert.equal(captured[0].headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(captured[0].body, JSON.stringify({ title: '新标题' }));
});

test('204 响应返回 undefined 而不尝试解析 JSON', async () => {
  stubFetch(() => new Response(null, { status: 204 }));

  const result = await request('/api/projects/prj_1', { method: 'DELETE', responseType: 'void' });
  assert.equal(result, undefined);
});

test('项目 id 会被 URL 编码', async () => {
  stubFetch(() => jsonResponse(200, { item: { id: 'x' } }));

  await request(`/api/projects/${encodeURIComponent('prj_带中文')}`);

  assert.ok(captured[0].url.includes('prj_%E5%B8%A6%E4%B8%AD%E6%96%87'));
});

test('外部 AbortSignal 触发时原样抛出取消异常', async () => {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    })) as typeof fetch;

  const controller = new AbortController();
  const promise = request('/api/projects', { signal: controller.signal });
  controller.abort();

  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, 'AbortError');
    return true;
  });
});

/* ------------------------------ 契约 §5 拼接规则 ------------------------------ */

test('joinUrl 实现契约 §5：base 为空时直接返回路径', () => {
  assert.equal(joinUrl('', '/api/projects'), '/api/projects');
  assert.equal(joinUrl('', '/api/projects/prj_1/files/image'), '/api/projects/prj_1/files/image');
});

test('joinUrl 实现契约 §5：base 带尾斜杠时只保留一个斜杠', () => {
  assert.equal(joinUrl('https://api.example.com/', '/api/projects'), 'https://api.example.com/api/projects');
  assert.equal(joinUrl('https://api.example.com', '/api/projects'), 'https://api.example.com/api/projects');
  // 多个尾斜杠也应被规整（replace(/\/$/, '') 只去掉一个，这里断言实际行为）
  assert.equal(joinUrl('https://api.example.com//', '/api/x'), 'https://api.example.com//api/x');
});

test('VITE_API_BASE 为空时 url() 返回同源相对路径', () => {
  assert.equal(API_BASE, '');
  assert.equal(url('/api/projects'), '/api/projects');
  assert.equal(url('/api/projects/prj_1/files/image?download=1'), '/api/projects/prj_1/files/image?download=1');
  assert.equal(url('/api/projects/prj_1/go'), '/api/projects/prj_1/go');
});

test('VITE_API_BASE 带尾斜杠时 url() 自动去重斜杠', async () => {
  process.env.VITE_API_BASE = 'https://api.example.com/';
  // 用不同 query 得到一份新的模块实例，从而在带尾斜杠的基址下重新求值。
  // 路径写成变量是为了绕过 TS 对字面量模块说明符的静态解析（该 query 写法 Node 支持）。
  const specifier = '../src/config.ts?base=trailing-slash';
  const fresh = (await import(specifier)) as typeof import('../src/config.ts');

  assert.equal(fresh.API_BASE, 'https://api.example.com');
  assert.equal(fresh.url('/api/projects'), 'https://api.example.com/api/projects');

  process.env.VITE_API_BASE = '';
});

test('VITE_API_BASE 带子路径时同样正确拼接', async () => {
  process.env.VITE_API_BASE = 'https://example.com/psd-hub/';
  const specifier = '../src/config.ts?base=subpath';
  const fresh = (await import(specifier)) as typeof import('../src/config.ts');

  assert.equal(fresh.url('/api/projects'), 'https://example.com/psd-hub/api/projects');

  process.env.VITE_API_BASE = '';
});

/* ------------------------------ v2.0 端点与字段 ------------------------------ */

test('buildNetdiskGoUrl 按契约 §3.10 构造跳转地址（并对 id 做 URL 编码）', () => {
  // 契约 §5：base 为空时是同源相对路径；该地址必须交给普通 <a>，不能 fetch
  assert.equal(buildNetdiskGoUrl('prj_9f2c1ab73d4e'), '/api/projects/prj_9f2c1ab73d4e/go');
  assert.equal(buildNetdiskGoUrl('prj_带中文'), `/api/projects/${encodeURIComponent('prj_带中文')}/go`);
});

test('buildImageUrl / buildImageDownloadUrl 直接使用契约 §1.2 给出的相对路径', () => {
  const image = {
    url: '/api/projects/prj_1/files/image',
    downloadUrl: '/api/projects/prj_1/files/image?download=1',
  };
  assert.equal(buildImageUrl(image), '/api/projects/prj_1/files/image');
  assert.equal(buildImageDownloadUrl(image), '/api/projects/prj_1/files/image?download=1');
});

test('listProjects 把 provider 作为契约 §3.3 的查询参数发出', async () => {
  stubFetch(() => jsonResponse(200, { items: [], total: 0, page: 1, pageSize: 12, totalPages: 0 }));

  await listProjects({ provider: 'baidu', q: '深色', page: 2 });

  const target = captured[0].url;
  const params = new URLSearchParams(target.split('?')[1]);
  assert.ok(target.startsWith('/api/projects?'));
  assert.equal(params.get('provider'), 'baidu');
  assert.equal(params.get('q'), '深色');
  assert.equal(params.get('page'), '2');
});

test('listProjects 未指定 provider 时不发送该参数', async () => {
  stubFetch(() => jsonResponse(200, { items: [], total: 0, page: 1, pageSize: 12, totalPages: 0 }));

  await listProjects({ sort: 'newest' });

  const params = new URLSearchParams(captured[0].url.split('?')[1]);
  assert.equal(params.has('provider'), false);
});

test('updateProject 可提交 v2.0 的网盘字段（契约 §3.7）', async () => {
  stubFetch(() => jsonResponse(200, { item: { id: 'prj_1' } }));

  await updateProject('prj_1', {
    title: '新标题',
    netdiskUrl: 'https://pan.baidu.com/s/1abcd',
    extractCode: 'abcd',
    sourceFileName: '深色UI稿.psd',
    sourceNote: '含分层源文件',
  });

  assert.equal(captured[0].method, 'PATCH');
  assert.equal(captured[0].headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(String(captured[0].body)), {
    title: '新标题',
    netdiskUrl: 'https://pan.baidu.com/s/1abcd',
    extractCode: 'abcd',
    sourceFileName: '深色UI稿.psd',
    sourceNote: '含分层源文件',
  });
});

/** 排序参数：非法值回落到 newest（契约 §3.3 宽容解析） */
test('normalizeSort 非法值回落到 newest（契约 §3.3 宽容解析）', () => {
  assert.equal(normalizeSort('downloads'), 'downloads');
  assert.equal(normalizeSort('bogus'), 'newest');
  assert.equal(normalizeSort(null), 'newest');
});

test('buildUploadFormData 使用 v2.0 的 multipart 字段名', () => {
  const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], '深色UI稿.png', {
    type: 'image/png',
  });

  const form = buildUploadFormData({
    image,
    netdiskUrl: '  https://pan.baidu.com/s/1abcd  ',
    title: '  深色风格 App 首页 UI 稿  ',
    description: '说明',
    author: '  张三  ',
    tags: ['UI', '深色'],
    extractCode: ' abcd ',
    sourceFileName: ' 深色UI稿.psd ',
    sourceNote: ' 含分层源文件 ',
    allowDuplicate: true,
  });

  // 必填的图片字段名是 image，不再是 v1 的 psd / preview
  assert.equal(form.has('psd'), false);
  assert.equal(form.has('preview'), false);
  assert.ok(form.get('image') instanceof File);
  assert.equal((form.get('image') as File).name, '深色UI稿.png');

  assert.equal(form.get('netdiskUrl'), 'https://pan.baidu.com/s/1abcd');
  assert.equal(form.get('title'), '深色风格 App 首页 UI 稿');
  assert.equal(form.get('author'), '张三');
  assert.equal(form.get('tags'), 'UI,深色');
  assert.equal(form.get('extractCode'), 'abcd');
  assert.equal(form.get('sourceFileName'), '深色UI稿.psd');
  assert.equal(form.get('sourceNote'), '含分层源文件');
  assert.equal(form.get('allowDuplicate'), '1');
});

test('buildUploadFormData 未填的可选网盘字段发送空串，由后端存 null', () => {
  const image = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });

  const form = buildUploadFormData({
    image,
    netdiskUrl: 'https://pan.quark.cn/s/xyz',
    title: '标题',
  });

  assert.equal(form.get('description'), '');
  assert.equal(form.get('author'), '');
  assert.equal(form.get('extractCode'), '');
  assert.equal(form.get('sourceFileName'), '');
  assert.equal(form.get('sourceNote'), '');
  assert.equal(form.get('allowDuplicate'), null);
  assert.equal(form.get('tags'), null);
});
