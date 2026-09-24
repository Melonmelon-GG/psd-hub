/**
 * v2.1 认证与授权端到端测试（契约 §8、§0.3、§0.2）。
 *
 * 全部对主站的调用都打到本机 `test/fakeMainSite.ts` 起的假主站（随机端口），
 * **绝不请求真实的 7thcv.cn**。
 *
 * 覆盖：登录代理（成功/密码错/空字段/非成员/主站挂掉/超时/5xx）、
 * /api/auth/me、上传鉴权（登录令牌 / 上传令牌旁路 / 降级放行）、
 * author 强制取令牌 cn、伪造与畸形令牌、MOUNT_PREFIX、登录限流、日志不泄漏凭据。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readCnFromTokenUnverified } from '../src/auth/mainSite.js';
import {
  type FakeMainSite,
  MEMBER_CN,
  MEMBER_PASSWORD,
  VISITOR_CN,
  memberToken,
  reserveDeadBaseUrl,
  signJwt,
  startFakeMainSite,
  verifyJwt,
  visitorToken,
} from './fakeMainSite.js';
import {
  type TestServer,
  assertErrorEnvelope,
  getJson,
  makeTempDir,
  readJson,
  startTestServer,
  uniquePng,
  uploadProject,
  withServer,
} from './helpers.js';

const API = '/api';

/** POST /api/auth/login */
async function loginRequest(
  base: string,
  body: unknown,
): Promise<{ status: number; body: any; response: Response }> {
  const response = await fetch(`${base}${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await readJson(response), response };
}

/** 返回一个"已过期"的成员令牌（假主站会拒绝） */
function expiredMemberToken(): string {
  return signJwt({ cn: MEMBER_CN, is_member: true, exp: Math.floor(Date.now() / 1000) - 60 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 单元：只用 base64url 解码读 cn（不验签）
// ---------------------------------------------------------------------------

describe('readCnFromTokenUnverified：只解码不验签，畸形输入一律 null', () => {
  it('正常 JWT → 取出 cn', () => {
    assert.equal(readCnFromTokenUnverified(memberToken('张三')), '张三');
  });

  it('签名被篡改也无所谓（本函数不验签，能解出 cn 就算数）', () => {
    const [h, p] = memberToken('张三').split('.');
    assert.equal(readCnFromTokenUnverified(`${h}.${p}.AAAA`), '张三');
  });

  it('段缺失 / 空载荷 / 非 base64 / 非 JSON / 非对象 → null', () => {
    assert.equal(readCnFromTokenUnverified(''), null);
    assert.equal(readCnFromTokenUnverified('onlyonepart'), null);
    assert.equal(readCnFromTokenUnverified('header.'), null);
    assert.equal(readCnFromTokenUnverified('header.@@@not-base64@@@.sig'), null);
    assert.equal(readCnFromTokenUnverified(`header.${Buffer.from('{oops').toString('base64url')}.sig`), null);
    assert.equal(readCnFromTokenUnverified(`header.${Buffer.from('"str"').toString('base64url')}.sig`), null);
    assert.equal(readCnFromTokenUnverified(`header.${Buffer.from('[1,2]').toString('base64url')}.sig`), null);
    assert.equal(readCnFromTokenUnverified(`header.${Buffer.from('123').toString('base64url')}.sig`), null);
  });

  it('cn 缺失 / 非字符串 / 空白 → null', () => {
    const seg = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    assert.equal(readCnFromTokenUnverified(`h.${seg({ is_member: true })}.s`), null);
    assert.equal(readCnFromTokenUnverified(`h.${seg({ cn: 42 })}.s`), null);
    assert.equal(readCnFromTokenUnverified(`h.${seg({ cn: null })}.s`), null);
    assert.equal(readCnFromTokenUnverified(`h.${seg({ cn: '   ' })}.s`), null);
    assert.equal(readCnFromTokenUnverified(`h.${seg({ cn: ' 张三 ' })}.s`), '张三');
  });

  it('超长字符串不再解码 → null', () => {
    assert.equal(readCnFromTokenUnverified(`h.${'a'.repeat(9000)}.s`), null);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

describe('POST /api/auth/login（凭据转发给主站）', () => {
  let server: TestServer;
  let fake: FakeMainSite;

  before(async () => {
    fake = await startFakeMainSite();
    server = await startTestServer({ MAIN_SITE_BASE_URL: fake.base });
  });

  after(async () => {
    await server.close();
    await fake.close();
  });

  it('正确凭据 → 200 { token, cn, isMember, expiresInSeconds: 86400 }', async () => {
    const { status, body } = await loginRequest(server.base, { cn: MEMBER_CN, password: MEMBER_PASSWORD });
    assert.equal(status, 200);
    assert.equal(body.cn, MEMBER_CN);
    assert.equal(body.isMember, true);
    assert.equal(body.expiresInSeconds, 86400);

    // 令牌必须是主站签发的那一个（3 段 JWT，签名可被"主站"验证）
    assert.equal(typeof body.token, 'string');
    assert.equal(body.token.split('.').length, 3);
    const payload = verifyJwt(body.token);
    assert.ok(payload, '返回的令牌必须是签名有效的 JWT');
    assert.equal(payload.cn, MEMBER_CN);
    assert.equal(payload.is_member, true);
    assert.equal(fake.loginCalls() >= 1, true, '登录必须真的转发到主站');
  });

  it('密码错误 / 未知用户 → 401 UNAUTHORIZED', async () => {
    const wrongPassword = await loginRequest(server.base, { cn: MEMBER_CN, password: 'wrong-password' });
    assert.equal(wrongPassword.status, 401);
    assertErrorEnvelope(wrongPassword.body, 'UNAUTHORIZED');

    const unknown = await loginRequest(server.base, { cn: '查无此人', password: MEMBER_PASSWORD });
    assert.equal(unknown.status, 401);
    assertErrorEnvelope(unknown.body, 'UNAUTHORIZED');
  });

  it('空字段 / 字段缺失 / 非字符串 → 400 BAD_REQUEST（且不消耗主站调用）', async () => {
    const before = fake.loginCalls();
    const cases: unknown[] = [
      {},
      { cn: MEMBER_CN },
      { password: MEMBER_PASSWORD },
      { cn: '', password: MEMBER_PASSWORD },
      { cn: MEMBER_CN, password: '' },
      { cn: '   ', password: '   ' },
      { cn: 123, password: 456 },
      { cn: null, password: null },
      { cn: [MEMBER_CN], password: [MEMBER_PASSWORD] },
    ];
    for (const body of cases) {
      const result = await loginRequest(server.base, body);
      assert.equal(result.status, 400, `期望 400，实际 ${result.status}：${JSON.stringify(body)}`);
      assertErrorEnvelope(result.body, 'BAD_REQUEST');
    }
    assert.equal(fake.loginCalls(), before, '校验失败不应把请求转发给主站');
  });

  it('非成员（is_member=false）→ 403 NOT_A_MEMBER，且不下发令牌', async () => {
    const { status, body } = await loginRequest(server.base, { cn: VISITOR_CN, password: 'whatever' });
    assert.equal(status, 403);
    assertErrorEnvelope(body, 'NOT_A_MEMBER');
    assert.equal('token' in body, false, '非成员不能拿到令牌');
  });
});

describe('POST /api/auth/login：主站异常 → 502 UPSTREAM_UNAVAILABLE', () => {
  it('主站不可达（端口已关闭）→ 502', async () => {
    const base = await reserveDeadBaseUrl();
    await withServer({ MAIN_SITE_BASE_URL: base }, async (server) => {
      const { status, body } = await loginRequest(server.base, { cn: MEMBER_CN, password: MEMBER_PASSWORD });
      assert.equal(status, 502);
      assertErrorEnvelope(body, 'UPSTREAM_UNAVAILABLE');
    });
  });

  it('主站 5xx → 502', async () => {
    const fake = await startFakeMainSite();
    fake.setMode('error-500');
    try {
      await withServer({ MAIN_SITE_BASE_URL: fake.base }, async (server) => {
        const { status, body } = await loginRequest(server.base, { cn: MEMBER_CN, password: MEMBER_PASSWORD });
        assert.equal(status, 502);
        assertErrorEnvelope(body, 'UPSTREAM_UNAVAILABLE');
      });
    } finally {
      await fake.close();
    }
  });

  it('主站超时（UPSTREAM_TIMEOUT_MS=300，主站慢 3s）→ 502', async () => {
    const fake = await startFakeMainSite();
    fake.setMode('slow');
    try {
      await withServer({ MAIN_SITE_BASE_URL: fake.base, UPSTREAM_TIMEOUT_MS: '300' }, async (server) => {
        const { status, body } = await loginRequest(server.base, { cn: MEMBER_CN, password: MEMBER_PASSWORD });
        assert.equal(status, 502);
        assertErrorEnvelope(body, 'UPSTREAM_UNAVAILABLE');
      });
    } finally {
      await fake.close();
    }
  });

  it('未配置主站地址（loginEnabled=false）→ 502（不假装登录成功）', async () => {
    await withServer({ MAIN_SITE_BASE_URL: '' }, async (server) => {
      const config = await getJson(server.base, `${API}/config`);
      assert.equal(config.body.loginEnabled, false);
      const { status, body } = await loginRequest(server.base, { cn: MEMBER_CN, password: MEMBER_PASSWORD });
      assert.equal(status, 502);
      assertErrorEnvelope(body, 'UPSTREAM_UNAVAILABLE');
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

describe('GET /api/auth/me（复用主站成员接口校验）', () => {
  let server: TestServer;
  let fake: FakeMainSite;

  before(async () => {
    fake = await startFakeMainSite();
    server = await startTestServer({ MAIN_SITE_BASE_URL: fake.base });
  });

  after(async () => {
    await server.close();
    await fake.close();
  });

  it('有效成员令牌 → 200 { cn, isMember: true }（裸令牌与 Bearer 都行）', async () => {
    const token = memberToken('张三');
    const raw = await getJson(server.base, `${API}/auth/me`, { Authorization: token });
    assert.equal(raw.status, 200);
    assert.deepEqual(raw.body, { cn: '张三', isMember: true });

    const bearer = await getJson(server.base, `${API}/auth/me`, { Authorization: `Bearer ${token}` });
    assert.equal(bearer.status, 200);
    assert.equal(bearer.body.cn, '张三');
  });

  it('缺少 Authorization → 401 UNAUTHORIZED', async () => {
    const { status, body } = await getJson(server.base, `${API}/auth/me`);
    assert.equal(status, 401);
    assertErrorEnvelope(body, 'UNAUTHORIZED');
  });

  it('伪造签名 / 改了载荷 / 改了签名 / 已过期 → 401', async () => {
    const [h, p, s] = memberToken().split('.') as [string, string, string];
    const forgedPayload = `${h}.${Buffer.from(JSON.stringify({ cn: '黑客', is_member: true, exp: 9999999999 })).toString('base64url')}.${s}`;
    const bogusSignature = `${h}.${p}.${Buffer.from('whatever-signature').toString('base64url')}`;
    const foreignKey = signJwt({ cn: '黑客', is_member: true, exp: Math.floor(Date.now() / 1000) + 3600 }, 'attacker-secret');

    for (const token of [forgedPayload, bogusSignature, foreignKey, expiredMemberToken(), 'not-a-jwt', `${h}.${p}`]) {
      const { status, body } = await getJson(server.base, `${API}/auth/me`, { Authorization: token });
      assert.equal(status, 401, `伪造令牌必须 401：${token.slice(0, 24)}…`);
      assertErrorEnvelope(body, 'UNAUTHORIZED');
    }
  });

  it('有效但非成员 → 403 NOT_A_MEMBER', async () => {
    const { status, body } = await getJson(server.base, `${API}/auth/me`, {
      Authorization: visitorToken(),
    });
    assert.equal(status, 403);
    assertErrorEnvelope(body, 'NOT_A_MEMBER');
  });

  it('主站说 OK 但令牌里没有 cn → 401（不猜作者名）', async () => {
    fake.setMode('trust-all');
    try {
      const noCn = signJwt({ is_member: true, exp: Math.floor(Date.now() / 1000) + 3600 });
      const { status, body } = await getJson(server.base, `${API}/auth/me`, { Authorization: noCn });
      assert.equal(status, 401);
      assertErrorEnvelope(body, 'UNAUTHORIZED');
    } finally {
      fake.setMode('ok');
    }
  });

  it('主站不可达 → 502（失败关闭，不当作已登录）', async () => {
    const base = await reserveDeadBaseUrl();
    await withServer({ MAIN_SITE_BASE_URL: base }, async (dead) => {
      const { status, body } = await getJson(dead.base, `${API}/auth/me`, { Authorization: memberToken() });
      assert.equal(status, 502);
      assertErrorEnvelope(body, 'UPSTREAM_UNAVAILABLE');
    });
  });
});

// ---------------------------------------------------------------------------
// 上传鉴权
// ---------------------------------------------------------------------------

describe('上传鉴权：主站登录令牌（契约 §8.3）', () => {
  let server: TestServer;
  let fake: FakeMainSite;

  before(async () => {
    fake = await startFakeMainSite();
    server = await startTestServer({ MAIN_SITE_BASE_URL: fake.base });
  });

  after(async () => {
    await server.close();
    await fake.close();
  });

  it('无凭据 → 401 UNAUTHORIZED', async () => {
    const result = await uploadProject(server.base, { image: uniquePng(701), title: '无凭据' });
    assert.equal(result.status, 401);
    assertErrorEnvelope(result.body, 'UNAUTHORIZED');
  });

  it('有效成员令牌 → 201，且 author 强制为令牌里的 cn（表单里的作者被忽略）', async () => {
    const token = memberToken('张三');
    const result = await uploadProject(
      server.base,
      {
        image: uniquePng(702),
        title: '作者归属',
        author: '李四',
        // 甚至塞重复的 author 字段，也必须被忽略
        extraFields: { author: '王五' },
      },
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.item?.author, '张三');
  });

  it('表单不传 author 时同样写入 cn；裸令牌（无 Bearer 前缀）也可用', async () => {
    const token = memberToken('张三');
    const result = await uploadProject(
      server.base,
      { image: uniquePng(703), title: '裸令牌' },
      { Authorization: token },
    );
    assert.equal(result.status, 201);
    assert.equal(result.item?.author, '张三');
  });

  it('每次上传都真的去主站校验（不会本地缓存令牌结论）', async () => {
    const token = memberToken('张三');
    const before = fake.verifyCalls();
    const first = await uploadProject(server.base, { image: uniquePng(704), title: '校验1' }, { Authorization: token });
    const second = await uploadProject(server.base, { image: uniquePng(705), title: '校验2' }, { Authorization: token });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(fake.verifyCalls() - before, 2);
  });

  it('非成员令牌 → 403 NOT_A_MEMBER', async () => {
    const result = await uploadProject(
      server.base,
      { image: uniquePng(706), title: '访客上传' },
      { Authorization: `Bearer ${visitorToken()}` },
    );
    assert.equal(result.status, 403);
    assertErrorEnvelope(result.body, 'NOT_A_MEMBER');
  });

  it('伪造/篡改/过期令牌 → 401（主站校验会拒绝）', async () => {
    const [h, p, s] = memberToken().split('.') as [string, string, string];
    const forgedPayload = `${h}.${Buffer.from(
      JSON.stringify({ cn: '黑客', is_member: true, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url')}.${s}`;
    const bogusSignature = `${h}.${p}.${Buffer.from('forged').toString('base64url')}`;

    for (const [index, token] of [forgedPayload, bogusSignature, expiredMemberToken()].entries()) {
      const result = await uploadProject(
        server.base,
        { image: uniquePng(710 + index), title: `伪造${index}` },
        { Authorization: `Bearer ${token}` },
      );
      assert.equal(result.status, 401, `伪造令牌必须 401：${token.slice(0, 24)}…`);
      assertErrorEnvelope(result.body, 'UNAUTHORIZED');
    }
  });

  it('畸形 JWT（cn 解不出）→ 401，即使主站宽松地放行', async () => {
    fake.setMode('trust-all');
    try {
      const noCn = signJwt({ is_member: true, exp: Math.floor(Date.now() / 1000) + 3600 });
      const result = await uploadProject(
        server.base,
        { image: uniquePng(720), title: '无 cn' },
        { Authorization: `Bearer ${noCn}` },
      );
      assert.equal(result.status, 401);
      assertErrorEnvelope(result.body, 'UNAUTHORIZED');
    } finally {
      fake.setMode('ok');
    }
  });

  it('主站 200 但内容是 HTML（SPA 回退页）→ 401（不放行伪造令牌）', async () => {
    fake.setMode('html-200');
    try {
      const result = await uploadProject(
        server.base,
        { image: uniquePng(721), title: 'HTML 200' },
        { Authorization: `Bearer ${memberToken()}` },
      );
      assert.equal(result.status, 401);
      assertErrorEnvelope(result.body, 'UNAUTHORIZED');
    } finally {
      fake.setMode('ok');
    }
  });

  it('主站 302 到登录页 → 401（不跟随重定向）', async () => {
    fake.setMode('redirect-302');
    try {
      const result = await uploadProject(
        server.base,
        { image: uniquePng(722), title: '302' },
        { Authorization: `Bearer ${memberToken()}` },
      );
      assert.equal(result.status, 401);
      assertErrorEnvelope(result.body, 'UNAUTHORIZED');
    } finally {
      fake.setMode('ok');
    }
  });

  it('主站不可达 → 502（不因上游故障放行）', async () => {
    const base = await reserveDeadBaseUrl();
    await withServer({ MAIN_SITE_BASE_URL: base }, async (dead) => {
      const result = await uploadProject(
        dead.base,
        { image: uniquePng(723), title: '主站挂了' },
        { Authorization: `Bearer ${memberToken()}` },
      );
      assert.equal(result.status, 502);
      assertErrorEnvelope(result.body, 'UPSTREAM_UNAVAILABLE');
    });
  });

  it('x-upload-token 未配置时该旁路关闭（带垃圾 x-upload-token 也 401）', async () => {
    const result = await uploadProject(
      server.base,
      { image: uniquePng(730), title: '旁路关闭' },
      { 'x-upload-token': 'whatever' },
    );
    assert.equal(result.status, 401);
    assertErrorEnvelope(result.body, 'UNAUTHORIZED');
  });
});

describe('上传鉴权：x-upload-token 自动化旁路', () => {
  let server: TestServer;
  let fake: FakeMainSite;

  before(async () => {
    fake = await startFakeMainSite();
    server = await startTestServer({
      MAIN_SITE_BASE_URL: fake.base,
      UPLOAD_TOKEN: 'ci-upload-secret',
    });
  });

  after(async () => {
    await server.close();
    await fake.close();
  });

  it('正确上传令牌 → 201，且 author 保留表单里的值', async () => {
    const before = fake.verifyCalls();
    const result = await uploadProject(
      server.base,
      { image: uniquePng(740), title: '旁路', author: '李四' },
      { 'x-upload-token': 'ci-upload-secret' },
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.item?.author, '李四');
    assert.equal(fake.verifyCalls(), before, '旁路不应触发主站校验');
  });

  it('表单没写 author → 落回默认「匿名作者」', async () => {
    const result = await uploadProject(
      server.base,
      { image: uniquePng(741), title: '无作者' },
      { 'x-upload-token': 'ci-upload-secret' },
    );
    assert.equal(result.status, 201);
    assert.equal(result.item?.author, '匿名作者');
  });

  it('错误的上传令牌 → 401；v2.0 的 Authorization: Bearer <上传令牌> 用法在 v2.1 已失效', async () => {
    const wrong = await uploadProject(
      server.base,
      { image: uniquePng(742), title: '错令牌' },
      { 'x-upload-token': 'wrong' },
    );
    assert.equal(wrong.status, 401);

    // v2.1 起 Authorization 专用于主站登录令牌，不再被当作上传令牌
    const legacy = await uploadProject(
      server.base,
      { image: uniquePng(743), title: 'v2.0 用法' },
      { Authorization: 'Bearer ci-upload-secret' },
    );
    assert.equal(legacy.status, 401);
    assertErrorEnvelope(legacy.body, 'UNAUTHORIZED');
  });

  it('旁路与登录令牌并存：两者都能上传成功', async () => {
    const viaBypass = await uploadProject(
      server.base,
      { image: uniquePng(744), title: '旁路2', author: '表单作者' },
      { 'x-upload-token': 'ci-upload-secret' },
    );
    assert.equal(viaBypass.status, 201);
    assert.equal(viaBypass.item?.author, '表单作者');

    const viaLogin = await uploadProject(
      server.base,
      { image: uniquePng(745), title: '登录2', author: '表单作者' },
      { Authorization: `Bearer ${memberToken('张三')}` },
    );
    assert.equal(viaLogin.status, 201);
    assert.equal(viaLogin.item?.author, '张三');
  });
});

describe('上传鉴权：只配 UPLOAD_TOKEN（未启用主站登录）', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer({ UPLOAD_TOKEN: 'only-token', MAIN_SITE_BASE_URL: '' });
  });

  after(async () => {
    await server.close();
  });

  it('上传令牌可用；Authorization 无从校验 → 401（不误判为通过）', async () => {
    const ok = await uploadProject(
      server.base,
      { image: uniquePng(750), title: '令牌可用', author: '王五' },
      { 'x-upload-token': 'only-token' },
    );
    assert.equal(ok.status, 201);
    assert.equal(ok.item?.author, '王五');

    const authorization = await uploadProject(
      server.base,
      { image: uniquePng(751), title: '登录令牌' },
      { Authorization: `Bearer ${memberToken()}` },
    );
    assert.equal(authorization.status, 401);
    assertErrorEnvelope(authorization.body, 'UNAUTHORIZED');
  });
});

describe('上传鉴权：两种凭据都未配置 → 降级放行（本地开发）', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer({ UPLOAD_TOKEN: '', MAIN_SITE_BASE_URL: '' });
  });

  after(async () => {
    await server.close();
  });

  it('不带任何凭据也能上传，author 取表单值（与 v2.0 一致）', async () => {
    const result = await uploadProject(server.base, {
      image: uniquePng(760),
      title: '降级放行',
      author: '本地作者',
    });
    assert.equal(result.status, 201);
    assert.equal(result.item?.author, '本地作者');
  });

  it('此时带垃圾 Authorization 也不影响（本来就不校验）', async () => {
    const result = await uploadProject(
      server.base,
      { image: uniquePng(761), title: '降级放行2', author: '本地作者' },
      { Authorization: 'Bearer garbage' },
    );
    assert.equal(result.status, 201);
    assert.equal(result.item?.author, '本地作者');
  });
});

// ---------------------------------------------------------------------------
// MOUNT_PREFIX
// ---------------------------------------------------------------------------

describe('MOUNT_PREFIX=/psd（契约 §8.4）', () => {
  let server: TestServer;
  let staticDir: string;

  before(async () => {
    staticDir = await makeTempDir('psdhub-mount-');
    await fs.mkdir(path.join(staticDir, 'assets'), { recursive: true });
    await fs.writeFile(
      path.join(staticDir, 'index.html'),
      '<!doctype html><html><body><div id="app">MOUNTED-SPA</div></body></html>',
      'utf8',
    );
    await fs.writeFile(path.join(staticDir, 'assets', 'app.js'), 'console.log("mounted");\n', 'utf8');
    server = await startTestServer({
      MOUNT_PREFIX: '/psd',
      SERVE_STATIC: 'true',
      STATIC_DIR: staticDir,
    });
  });

  after(async () => {
    await server.close();
    await fs.rm(staticDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });

  it('/api/config 回传 mountPrefix = "/psd"', async () => {
    const { status, body } = await getJson(server.base, `${API}/config`);
    assert.equal(status, 200);
    assert.equal(body.mountPrefix, '/psd');
  });

  it('/psd/api/health → 200、/psd/api/projects → 200', async () => {
    const health = await getJson(server.base, '/psd/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const projects = await getJson(server.base, '/psd/api/projects');
    assert.equal(projects.status, 200);
    assert.equal(projects.body.total, 0);
    assert.deepEqual(projects.body.items, []);
  });

  it('/psd/api/projects 上传链路同样可用（未配置鉴权 → 201）', async () => {
    const result = await uploadProject(`${server.base}/psd`, { image: uniquePng(770), title: '前缀下上传' });
    assert.equal(result.status, 201);
    assert.equal(result.item?.title, '前缀下上传');
  });

  it('/ → 302 到 /psd/（保留查询串）；/psd → 302 到 /psd/', async () => {
    const root = await fetch(`${server.base}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/psd/');

    const rootWithQuery = await fetch(`${server.base}/?a=1`, { redirect: 'manual' });
    assert.equal(rootWithQuery.status, 302);
    assert.equal(rootWithQuery.headers.get('location'), '/psd/?a=1');

    const bare = await fetch(`${server.base}/psd`, { redirect: 'manual' });
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get('location'), '/psd/');
  });

  it('静态资源与 SPA 回退在前缀之下可用', async () => {
    const index = await fetch(`${server.base}/psd/`);
    assert.equal(index.status, 200);
    assert.ok((await index.text()).includes('MOUNTED-SPA'));

    const asset = await fetch(`${server.base}/psd/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await asset.text(), 'console.log("mounted");\n');

    const spaRoute = await fetch(`${server.base}/psd/some/spa/route`);
    assert.equal(spaRoute.status, 200);
    assert.ok((await spaRoute.text()).includes('MOUNTED-SPA'));
  });
});

describe('未设置 MOUNT_PREFIX：行为与 v2.0 一致', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer({ MOUNT_PREFIX: '', SERVE_STATIC: 'false' });
  });

  after(async () => {
    await server.close();
  });

  it('/api/config 的 mountPrefix 为空串', async () => {
    const { body } = await getJson(server.base, `${API}/config`);
    assert.equal(body.mountPrefix, '');
  });

  it('/api/health → 200；/ 不再是 302 而是走原有 404；/psd/api/health 不被剥离', async () => {
    assert.equal((await getJson(server.base, `${API}/health`)).status, 200);

    const root = await fetch(`${server.base}/`, { redirect: 'manual' });
    assert.equal(root.status, 404);
    assertErrorEnvelope(await readJson(root), 'NOT_FOUND');

    const prefixed = await fetch(`${server.base}/psd/api/health`, { redirect: 'manual' });
    assert.equal(prefixed.status, 404);
  });
});

// ---------------------------------------------------------------------------
// 登录限流
// ---------------------------------------------------------------------------

describe('登录端点的独立严格限流', () => {
  let server: TestServer;
  let fake: FakeMainSite;

  before(async () => {
    fake = await startFakeMainSite();
    server = await startTestServer({
      MAIN_SITE_BASE_URL: fake.base,
      LOGIN_RATE_LIMIT_MAX: '5',
      RATE_LIMIT_MAX: '100000',
    });
  });

  after(async () => {
    await server.close();
    await fake.close();
  });

  it('超过 LOGIN_RATE_LIMIT_MAX → 429 + Retry-After', async () => {
    let limited: Response | null = null;
    for (let i = 0; i < 10; i += 1) {
      const response = await fetch(`${server.base}${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cn: MEMBER_CN, password: 'wrong-password' }),
      });
      if (response.status === 429) {
        limited = response;
        break;
      }
      assert.equal(response.status, 401);
    }
    assert.ok(limited, '超过 5 次后必须 429');
    const retryAfter = limited.headers.get('retry-after');
    assert.ok(retryAfter && Number(retryAfter) >= 1, `Retry-After 必须是正整数秒，实际：${retryAfter}`);
    assertErrorEnvelope(await readJson(limited), 'RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// 日志纪律
// ---------------------------------------------------------------------------

describe('安全：日志中绝不出现密码或令牌', () => {
  let server: TestServer;
  let fake: FakeMainSite;

  before(async () => {
    fake = await startFakeMainSite();
    // 打开 info 级日志，确保访问日志等确实在写，测试才有意义
    server = await startTestServer({ MAIN_SITE_BASE_URL: fake.base, LOG_LEVEL: 'info' });
  });

  after(async () => {
    await server.close();
    await fake.close();
  });

  it('登录 + 带令牌上传 + 失败登录之后，stdout/stderr/console 里都没有凭据', async () => {
    const captured: string[] = [];
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    const record = (chunk: unknown): void => {
      try {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk));
      } catch {
        // 忽略无法字符串化的值
      }
    };

    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      record(chunk);
      return (originalStdoutWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      record(chunk);
      return (originalStderrWrite as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
    }) as typeof process.stderr.write;
    for (const key of Object.keys(originalConsole) as Array<keyof typeof originalConsole>) {
      console[key] = ((...args: unknown[]) => {
        record(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '));
        (originalConsole[key] as (...a: unknown[]) => void)(...args);
      }) as never;
    }

    const wrongPassword = 'wrong-password-please-never-log-me';
    let token = '';
    try {
      const login = await loginRequest(server.base, { cn: MEMBER_CN, password: MEMBER_PASSWORD });
      assert.equal(login.status, 200);
      token = login.body.token;

      const upload = await uploadProject(
        server.base,
        { image: uniquePng(780), title: '日志检查', author: '李四' },
        { Authorization: `Bearer ${token}` },
      );
      assert.equal(upload.status, 201);

      const denied = await loginRequest(server.base, { cn: MEMBER_CN, password: wrongPassword });
      assert.equal(denied.status, 401);

      await sleep(120); // 等访问日志的 res.on('finish') 落地
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      Object.assign(console, originalConsole);
    }

    const text = captured.join('\n');
    assert.ok(captured.length > 0, '应当确实产生了日志（否则本测试没有意义）');
    assert.ok(!text.includes(MEMBER_PASSWORD), `日志里出现了密码：\n${text}`);
    assert.ok(!text.includes(wrongPassword), `日志里出现了密码：\n${text}`);
    assert.ok(!text.includes(token), `日志里出现了令牌：\n${text}`);
    assert.ok(!text.includes(token.split('.')[1] ?? ''), '日志里出现了令牌载荷段');
  });
});
