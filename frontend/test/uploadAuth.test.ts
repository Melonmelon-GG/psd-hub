/**
 * 上传页登录门禁单测（契约 §8.3 / §8.4 · v2.1）。
 *
 * 上传页的判定被抽成了纯函数 `src/auth/uploadGate.ts`，因此这里不需要 DOM 环境
 * （项目没有 jsdom / testing-library，也不打算为此加依赖）。
 * 断言的是三条业务规则：
 * 1. 未登录（或登录态校验中）→ 判定为「需登录」，整页替换为引导卡片；
 * 2. 已登录的社团成员 → `author` 使用登录用户名 `cn`，且锁定只读；
 * 3. `loginEnabled === false` / 字段缺失（后端未落地）→ **退回 v2.0 旧行为**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { resolveUploadAccess, resolveUploadAuthor } = await import('../src/auth/uploadGate.ts');
const { buildUploadFormData } = await import('../src/upload/uploadProject.ts');
const { sanitizeRedirect } = await import('../src/auth/redirect.ts');

const MEMBER = { cn: '张三', isMember: true };
const NON_MEMBER = { cn: '李四', isMember: false };

/* ------------------------------ 1. 需要登录 ------------------------------ */

test('未登录 + loginEnabled=true → 判定为需要登录，不给出任何作者名', () => {
  const access = resolveUploadAccess({ loginEnabled: true, status: 'anonymous', user: null });

  assert.equal(access.requiresLogin, true);
  assert.equal(access.gateReason, 'anonymous');
  assert.equal(access.pending, false);
  assert.equal(access.authorLocked, false);
  assert.equal(access.author, '');
});

test('登录态校验中（启动时带令牌调 /api/auth/me）→ pending，先不渲染表单也不误判为未登录', () => {
  const access = resolveUploadAccess({ loginEnabled: true, status: 'loading', user: null });

  assert.equal(access.pending, true);
  assert.equal(access.requiresLogin, false);
  assert.equal(access.authorLocked, false);
});

test('status 已是 authenticated 但没有用户对象 → 仍按未登录处理（从严）', () => {
  const access = resolveUploadAccess({ loginEnabled: true, status: 'authenticated', user: null });

  assert.equal(access.requiresLogin, true);
  assert.equal(access.gateReason, 'anonymous');
});

test('已登录但不是社团成员 → 门禁原因为 not-member（提示「该账号不是社团成员，无法上传」）', () => {
  const access = resolveUploadAccess({
    loginEnabled: true,
    status: 'authenticated',
    user: NON_MEMBER,
  });

  assert.equal(access.requiresLogin, true);
  assert.equal(access.gateReason, 'not-member');
  assert.equal(access.authorLocked, false);
  assert.equal(access.author, '');
});

/* ------------------------------ 2. 已登录：author 取 cn ------------------------------ */

test('已登录的社团成员 → author 使用登录用户名且锁定，不允许自行指定', () => {
  const access = resolveUploadAccess({ loginEnabled: true, status: 'authenticated', user: MEMBER });

  assert.equal(access.requiresLogin, false);
  assert.equal(access.pending, false);
  assert.equal(access.authorLocked, true);
  assert.equal(access.author, '张三');
  // 用户在（只读）输入框里塞什么都无效，作者名永远来自登录用户名
  assert.equal(resolveUploadAuthor(access, '我想冒充别人'), '张三');
  assert.equal(resolveUploadAuthor(access, ''), '张三');
});

test('登录用户名原样使用（不做 trim/改写，服务端才是最终真相）', () => {
  const access = resolveUploadAccess({
    loginEnabled: true,
    status: 'authenticated',
    user: { cn: '柒世纪·美工组', isMember: true },
  });

  assert.equal(access.author, '柒世纪·美工组');
});

/* ------------------------------ 3. loginEnabled=false 的降级 ------------------------------ */

test('loginEnabled=false + 未登录 → 退回 v2.0 旧行为：不强制登录，author 可自由填写', () => {
  const access = resolveUploadAccess({ loginEnabled: false, status: 'anonymous', user: null });

  assert.equal(access.requiresLogin, false);
  assert.equal(access.gateReason, null);
  assert.equal(access.pending, false);
  assert.equal(access.authorLocked, false);
  assert.equal(access.author, '');
  assert.equal(resolveUploadAuthor(access, '匿名路人'), '匿名路人');
});

test('loginEnabled=false + 已登录 → 同样不锁定 author（服务端没启用登录，不接管作者名）', () => {
  const access = resolveUploadAccess({ loginEnabled: false, status: 'authenticated', user: MEMBER });

  assert.equal(access.requiresLogin, false);
  assert.equal(access.authorLocked, false);
  assert.equal(resolveUploadAuthor(access, '我自己起的名字'), '我自己起的名字');
});

test('loginEnabled=false + 校验中 → 直接按旧行为渲染，不出现 pending 占位', () => {
  const access = resolveUploadAccess({ loginEnabled: false, status: 'loading', user: null });
  assert.equal(access.pending, false);
  assert.equal(access.requiresLogin, false);
});

test('GET /api/config 暂缺 loginEnabled 字段 → 按 false 处理（后端未落地时不卡住本地开发）', () => {
  // 模拟后端尚未返回 v2.1 新字段的旧响应
  const legacyConfig: { name: string; loginEnabled?: boolean } = { name: 'psd-hub' };
  const loginEnabled = legacyConfig.loginEnabled === true;
  assert.equal(loginEnabled, false);

  const access = resolveUploadAccess({ loginEnabled, status: 'anonymous', user: null });
  assert.equal(access.requiresLogin, false);
  assert.equal(access.authorLocked, false);
});

/* ------------------------------ 4. 提交时的字段 ------------------------------ */

test('锁定态提交：表单里的 author 就是登录用户名（后端仍会用令牌覆盖，前端照契约发送）', () => {
  const access = resolveUploadAccess({ loginEnabled: true, status: 'authenticated', user: MEMBER });
  const author = resolveUploadAuthor(access, '无视输入框的内容');

  const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], '深色UI稿.png', {
    type: 'image/png',
  });
  const form = buildUploadFormData({
    image,
    netdiskUrl: 'https://pan.baidu.com/s/1abcd',
    title: '深色风格 App 首页 UI 稿',
    author,
  });

  assert.equal(form.get('author'), '张三');
  assert.equal(form.get('image') instanceof File, true);
});

/* ------------------------------ 5. 去登录链接 ------------------------------ */

test('引导卡片上的 redirect 指回 /upload，且经净化后仍是站内路径', () => {
  const target = sanitizeRedirect('/upload');
  assert.equal(target, '/upload');
  // 门禁卡片用它拼 `/login?redirect=%2Fupload`
  assert.equal(`/login?redirect=${encodeURIComponent(target)}`, '/login?redirect=%2Fupload');
});
