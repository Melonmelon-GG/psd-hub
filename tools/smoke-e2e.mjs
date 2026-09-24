#!/usr/bin/env node
/**
 * PSD 展示台 · 端到端冒烟测试 v2.0（可直接用于部署后的线上验收）
 *
 *   node tools/smoke-e2e.mjs                        # 本地：临时目录 + 随机端口 + 直接起后端
 *   node tools/smoke-e2e.mjs --base http://7thcv.cn:4100 --no-spawn \
 *        --upload-token <t> --admin-token <t>       # 线上：只打已有站点，不起进程
 *
 * v2.0 路线：上传 **PNG + 网盘分享链接**，不再上传/托管 PSD。
 * 因此本脚本验证的是：图片上传与下发、网盘链接识别、302 跳转与下载计数、以及 PSD 端点确已下线。
 *
 * 退出码 0 = 全部通过；1 = 有断言失败。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ────────────────────────────── 参数 ────────────────────────────── */

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const hasFlag = (name) => args.includes(`--${name}`);

const NO_SPAWN = hasFlag('no-spawn');
const PORT = Number(getArg('port', String(4100 + Math.floor(Math.random() * 400))));
const BASE = getArg('base', `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const UPLOAD_TOKEN = getArg('upload-token', process.env.UPLOAD_TOKEN ?? '');
/** 管理令牌：PATCH / DELETE 用的是 admin 令牌，与上传令牌是两把不同的钥匙（契约 §0.3） */
const ADMIN_TOKEN = getArg('admin-token', process.env.ADMIN_TOKEN || UPLOAD_TOKEN);

/* ────────────────────────────── 断言框架 ────────────────────────────── */

let passed = 0;
const failures = [];
let currentSection = '';

function section(title) {
  currentSection = title;
  console.log(`\n── ${title} ──`);
}
function ok(label, extra = '') {
  passed++;
  console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`);
}
function fail(label, detail) {
  failures.push(`[${currentSection}] ${label} —— ${detail}`);
  console.log(`  ✗ ${label}\n      ${detail}`);
}
function assert(label, condition, detail = '') {
  if (condition) ok(label, typeof detail === 'string' ? detail : '');
  else fail(label, detail || '断言为假');
  return Boolean(condition);
}
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(label, a);
  else fail(label, `期望 ${e}，实际 ${a}`);
}

/* ────────────────────────────── 服务生命周期 ────────────────────────────── */

let child = null;
let dataDir = null;
let stopping = false;

function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'psd-hub-smoke-'));
  const entry = join(ROOT, 'backend', 'dist', 'index.js');
  if (!existsSync(entry)) {
    console.error(`未找到 ${entry}\n请先执行：npm --prefix backend run build`);
    process.exit(1);
  }
  console.log(`启动后端： node backend/dist/index.js  (PORT=${PORT}, DATA_DIR=${dataDir})`);
  child = spawn(process.execPath, [entry], {
    cwd: join(ROOT, 'backend'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATA_DIR: dataDir,
      SERVE_STATIC: 'true',
      STATIC_DIR: join(ROOT, 'frontend', 'dist'),
      RATE_LIMIT_MAX: '10000',
      UPLOAD_RATE_LIMIT_MAX: '1000',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(String(d)));
  child.stderr.on('data', (d) => lines.push(String(d)));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null && !stopping) {
      console.error(`\n后端进程意外退出（code=${code}）：\n${lines.join('')}`);
    }
  });
}

function stopServer() {
  stopping = true;
  if (child && child.exitCode === null) child.kill('SIGTERM');
  if (dataDir && existsSync(dataDir)) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发占用，忽略 */
    }
  }
}

async function waitForHealth(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等待 ${BASE}/api/health 超时（${timeoutMs}ms）`);
}

/* ────────────────────────────── 工具 ────────────────────────────── */

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const authHeaders = () => (UPLOAD_TOKEN ? { 'x-upload-token': UPLOAD_TOKEN } : {});
const adminHeaders = () => (ADMIN_TOKEN ? { 'x-admin-token': ADMIN_TOKEN } : {});

/** 组装一次上传用的 FormData */
function buildForm(opts) {
  const form = new FormData();
  form.append('image', new Blob([opts.png], { type: 'image/png' }), opts.pngName ?? 'image.png');
  if (opts.title !== undefined) form.append('title', opts.title);
  if (opts.netdiskUrl !== undefined) form.append('netdiskUrl', opts.netdiskUrl);
  if (opts.extractCode) form.append('extractCode', opts.extractCode);
  if (opts.sourceFileName) form.append('sourceFileName', opts.sourceFileName);
  if (opts.sourceNote) form.append('sourceNote', opts.sourceNote);
  if (opts.tags) form.append('tags', opts.tags);
  if (opts.description) form.append('description', opts.description);
  if (opts.author) form.append('author', opts.author);
  if (opts.allowDuplicate) form.append('allowDuplicate', '1');
  return form;
}

const PNG = () => readFileSync(join(ROOT, 'tools', 'fixtures', 'sample-ui.png'));
const PNG_MINI = () => readFileSync(join(ROOT, 'tools', 'fixtures', 'sample-mini.png'));
const PNG_PORTRAIT = () => readFileSync(join(ROOT, 'tools', 'fixtures', 'sample-portrait.png'));

/**
 * 给 PNG 尾部追加一段唯一注释字节，让**每次运行的图片内容都不同**。
 *
 * 为什么需要：本脚本要能对「已经有数据的线上站点」跑（例如站点上留着演示数据）。
 * 若直接用素材原图，它的 sha256 会与站点已有记录相同 → 上传返回 409 去重，
 * 后续所有断言都会连锁失败。而 PNG 解码器在 IEND 之后会忽略多余字节，
 * 追加内容既不影响图片有效性，又能让哈希唯一。
 *
 * 副作用是好的：这样第 4 节的「重复上传应当 409」才是在测**本次运行**自己造出来的重复，
 * 而不会撞上站点里的历史数据。
 */
const uniquePng = (base) =>
  Buffer.concat([base, Buffer.from(`\n#psd-hub-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}\n`)]);

/**
 * 等一个完整的限流窗口。
 *
 * 线上站点按 `UPLOAD_RATE_LIMIT_MAX`（默认 30 次/分钟/IP）限制上传，
 * 而本脚本在第 11、12 节会连续上传二十多次。若不主动等窗口，
 * 会把「限流正常工作」误报成功能失败 —— 那是**测试脚本的问题**，不是站点的问题。
 * 等到一个干净窗口后再跑批量的上传用例。
 */
async function waitForRateLimitWindow(reason) {
  const seconds = 62;
  console.log(`  · 为避开上传限流窗口，等待 ${seconds}s 后继续（${reason}）…`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < seconds * 1000) {
    await new Promise((r) => setTimeout(r, 5000));
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (elapsed % 20 === 0) console.log(`    已等待 ${elapsed}s / ${seconds}s…`);
  }
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

async function main() {
  for (const f of ['sample-ui.png', 'sample-mini.png', 'sample-portrait.png']) {
    if (!existsSync(join(ROOT, 'tools', 'fixtures', f))) {
      console.error(`缺少测试素材 tools/fixtures/${f}\n请先执行：node tools/make-sample-psd.mjs`);
      process.exit(1);
    }
  }

  if (!NO_SPAWN) startServer();
  const health = await waitForHealth();
  console.log(`\n站点： ${BASE}`);

  /*
   * 本次运行的唯一标识。
   *
   * 为什么需要：本脚本要能对**已经有数据的线上站点**跑（例如站点上留着演示数据）。
   * 若断言里写死 total === 1、标签计数 === 1 这类绝对值，一遇到非空库就会全线失败。
   * 因此所有「计数类」断言都改成相对基线，所有「搜索类」断言都改用本次运行的唯一串
   * —— 这样无论站点里已有多少数据，结果都是确定的。
   */
  const RUN_ID = `smoke${Date.now().toString(36)}`;
  const UNIQUE_TAG = `冒烟-${RUN_ID}`;
  const baselineTotal = (await (await fetch(`${BASE}/api/projects?pageSize=1`)).json()).total;
  console.log(`本次运行标识： ${RUN_ID}（站点现有 ${baselineTotal} 条工程，断言将以此为基线）`);

  /* ---------- 1 · 健康检查与公开配置 ---------- */
  section('1 · 健康检查与公开配置');
  assert('GET /api/health → ok', health.ok === true, JSON.stringify(health));
  const cfgRes = await fetch(`${BASE}/api/config`);
  const cfg = await cfgRes.json();
  assert('GET /api/config → 200', cfgRes.status === 200);
  assert('maxUploadBytes 为正整数', Number.isInteger(cfg.maxUploadBytes) && cfg.maxUploadBytes > 0, `${cfg.maxUploadBytes} (${cfg.maxUploadLabel})`);
  assertEq('仅接受 PNG', cfg.acceptedImageTypes, ['image/png']);
  assertEq('仅接受 .png 扩展名', cfg.acceptedImageExtensions, ['.png']);
  assert('提供了提取码长度上限', Number.isInteger(cfg.extractCodeMaxLength) && cfg.extractCodeMaxLength > 0, String(cfg.extractCodeMaxLength));
  assert('提供了网盘链接长度上限', Number.isInteger(cfg.netdiskUrlMaxLength) && cfg.netdiskUrlMaxLength > 0, String(cfg.netdiskUrlMaxLength));

  /* ---------- 2 · 前端静态站点 ---------- */
  section('2 · 前端静态站点（单进程托管）');
  const indexRes = await fetch(`${BASE}/`);
  const indexHtml = await indexRes.text();
  assert('GET / → 200 text/html', indexRes.status === 200 && (indexRes.headers.get('content-type') ?? '').includes('text/html'), `status=${indexRes.status}`);
  assert('index.html 含挂载点 #root', indexHtml.includes('id="root"'), `长度 ${indexHtml.length} 字节`);
  // index.html 里的资源路径会**带上挂载前缀**（挂在 /psd/ 下时是 /psd/assets/...），
  // 而 BASE 本身也已经带了该前缀，所以必须按「相对域名根」解析，不能再直接拼 BASE
  // （否则会拼成 /psd/psd/assets/...）。
  const assetPath = indexHtml.match(/src="([^"]*\/assets\/[^"]+\.js)"/)?.[1];
  if (assetPath) {
    const assetUrl = new URL(assetPath, `${new URL(BASE).origin}/`).href;
    const assetRes = await fetch(assetUrl);
    const assetBody = await assetRes.arrayBuffer();
    assert(`GET ${assetPath} → 200 JS`, assetRes.status === 200 && assetBody.byteLength > 10000, `${(assetBody.byteLength / 1024).toFixed(0)} KB`);
  } else {
    fail('index.html 引用 /assets/*.js', '没有在 HTML 里找到 <script src=".../assets/....js">');
  }

  /* ---------- 3 · 上传（PNG + 网盘链接） ---------- */
  section('3 · 上传（PNG + 网盘链接，含中文标题/文件名/提取码）');
  const pngBuf = uniquePng(PNG());
  const title = `深色科幻 UI 稿（端到端冒烟 ${RUN_ID}）`;
  const description = `第一行说明\n第二行说明：含中文、标点，与换行。run=${RUN_ID}`;
  const author = `shirohae-${RUN_ID}`;
  const sourceFileName = `深色UI稿_分层-${RUN_ID}.psd`;
  const upRes = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    body: buildForm({
      png: pngBuf,
      pngName: '深色UI稿.png',
      title,
      netdiskUrl: 'https://pan.baidu.com/s/1aBcDeFgHiJkLmNoPqRsTu',
      extractCode: 'ui88',
      sourceFileName,
      sourceNote: '含分层源文件',
      tags: `UI，科幻, 深色, ${UNIQUE_TAG}`,
      description,
      author,
    }),
    headers: authHeaders(),
  });
  const upText = await upRes.text();
  if (!assert('POST /api/projects → 201', upRes.status === 201, `status=${upRes.status} body=${upText.slice(0, 300)}`)) {
    throw new Error('上传失败，后续断言无法继续');
  }
  const item = JSON.parse(upText).item;
  const id = item.id;

  assertEq('title 往返一致', item.title, title);
  assertEq('description 往返一致（换行统一为 \\n）', item.description, description);
  assertEq('author 往返一致', item.author, author);
  assertEq('PNG 文件名未乱码', item.image?.fileName, '深色UI稿.png');
  assertEq('tags 按全角/半角逗号拆分并去重', item.tags.sort(), ['UI', '科幻', '深色', UNIQUE_TAG].sort());
  assertEq('image.width（后端解析 PNG IHDR）', item.image.width, 1200);
  assertEq('image.height', item.image.height, 800);
  assertEq('image.size 与本地文件一致', item.image.size, pngBuf.length);
  assertEq('image.sha256 与本地计算一致', item.image.sha256, sha256(pngBuf));
  assertEq('image.url 是 /api 相对路径', item.image.url, `/api/projects/${id}/files/image`);
  assertEq('image.downloadUrl 带 download=1', item.image.downloadUrl, `/api/projects/${id}/files/image?download=1`);

  assertEq('source.provider 识别为 baidu', item.source?.provider, 'baidu');
  assertEq('source.providerLabel 为中文名', item.source?.providerLabel, '百度网盘');
  assertEq('source.url 往返一致', item.source?.url, 'https://pan.baidu.com/s/1aBcDeFgHiJkLmNoPqRsTu');
  assertEq('source.extractCode 往返一致', item.source?.extractCode, 'ui88');
  assertEq('source.fileName 往返一致', item.source?.fileName, sourceFileName);
  assertEq('source.note 往返一致', item.source?.note, '含分层源文件');
  assert('返回体不含已废弃的 psd 字段', !('psd' in item), Object.keys(item).join(','));
  assert('返回体不含已废弃的 preview 字段', !('preview' in item), Object.keys(item).join(','));

  /* ---------- 4 · 去重 ---------- */
  section('4 · PNG sha256 去重');
  const dupRes = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    body: buildForm({ png: pngBuf, pngName: '深色UI稿.png', title: '重复上传', netdiskUrl: 'https://pan.quark.cn/s/zzz' }),
    headers: authHeaders(),
  });
  const dup = await dupRes.json();
  assertEq('重复 PNG → 409', dupRes.status, 409);
  assertEq('错误信封 code = DUPLICATE', dup?.error?.code, 'DUPLICATE');
  assertEq('details.existingId 指向已有工程', dup?.error?.details?.existingId, id);

  /* ---------- 5 · 列表 / 搜索 / 标签 / 网盘过滤 ---------- */
  section('5 · 列表 / 搜索 / 标签 / 网盘过滤');
  const list = await (await fetch(`${BASE}/api/projects?page=1&pageSize=12`)).json();
  assert('分页信封字段齐全', ['items', 'total', 'page', 'pageSize', 'totalPages'].every((k) => k in list), JSON.stringify(Object.keys(list)));
  assertEq('total 相对基线 +1', list.total, baselineTotal + 1);
  assertEq('items[0].id 命中（最新排在最前）', list.items[0]?.id, id);
  assertEq('按本次运行唯一串搜索命中且唯一', (await (await fetch(`${BASE}/api/projects?q=${RUN_ID}`)).json()).total, 1);
  assertEq('无关关键词不命中', (await (await fetch(`${BASE}/api/projects?q=${encodeURIComponent('不存在的关键词xyzq')}`)).json()).total, 0);
  const baiduList = await (await fetch(`${BASE}/api/projects?provider=baidu&pageSize=48`)).json();
  assert('provider=baidu 的筛选结果里包含本次上传的项目', baiduList.items.some((it) => it.id === id), `共 ${baiduList.total} 条`);
  const quarkList = await (await fetch(`${BASE}/api/projects?provider=quark&pageSize=48`)).json();
  assert('provider=quark 的筛选结果里不含本次上传的项目', !quarkList.items.some((it) => it.id === id), `共 ${quarkList.total} 条`);
  const tags = await (await fetch(`${BASE}/api/projects/tags`)).json();
  assert('GET /api/projects/tags 未被 :id 路由吞掉', Array.isArray(tags.tags), JSON.stringify(tags).slice(0, 160));
  assertEq('标签聚合计数正确（本次运行的唯一标签）', tags.tags.find((t) => t.name === UNIQUE_TAG)?.count, 1);

  /* ---------- 6 · 详情与浏览计数 ---------- */
  section('6 · 详情与浏览计数');
  const d1 = await (await fetch(`${BASE}/api/projects/${id}`)).json();
  assert('默认浏览计数 +1', d1.item.stats.views >= 1, `views=${d1.item.stats.views}`);
  const d2 = await (await fetch(`${BASE}/api/projects/${id}?count=0`)).json();
  assertEq('?count=0 不增加浏览计数', d2.item.stats.views, d1.item.stats.views);

  /* ---------- 7 · 图片下发 ---------- */
  section('7 · 图片下发（Range / 附件头 / 缓存）');
  const streamRes = await fetch(`${BASE}${item.image.url}`);
  const streamBuf = Buffer.from(await streamRes.arrayBuffer());
  assertEq('GET image.url → 200', streamRes.status, 200);
  assert('Content-Type 为 image/png', (streamRes.headers.get('content-type') ?? '').includes('image/png'), streamRes.headers.get('content-type') ?? '');
  assertEq('字节内容与本地 PNG 完全一致', sha256(streamBuf), sha256(pngBuf));
  assertEq('Accept-Ranges: bytes', streamRes.headers.get('accept-ranges'), 'bytes');
  assert('带 ETag', Boolean(streamRes.headers.get('etag')), streamRes.headers.get('etag') ?? '');
  assert('长缓存头', (streamRes.headers.get('cache-control') ?? '').includes('immutable'), streamRes.headers.get('cache-control') ?? '');

  const rangeRes = await fetch(`${BASE}${item.image.url}`, { headers: { Range: 'bytes=0-9' } });
  assertEq('Range 请求 → 206', rangeRes.status, 206);
  assertEq('Range 返回 10 字节', Buffer.from(await rangeRes.arrayBuffer()).length, 10);
  assert('带 Content-Range 头', (rangeRes.headers.get('content-range') ?? '').startsWith('bytes 0-9/'), rangeRes.headers.get('content-range') ?? '');

  const dlRes = await fetch(`${BASE}${item.image.downloadUrl}`);
  const disposition = dlRes.headers.get('content-disposition') ?? '';
  assertEq('下载接口 → 200', dlRes.status, 200);
  assert('Content-Disposition 为 attachment', disposition.startsWith('attachment'), disposition);
  assert("中文文件名用 filename*=UTF-8''", disposition.includes("filename*=UTF-8''"), disposition);

  /* ---------- 8 · 网盘跳转与下载计数（v2.0 核心） ---------- */
  section('8 · 网盘跳转 GET /api/projects/:id/go');
  const goRes = await fetch(`${BASE}/api/projects/${id}/go`, { redirect: 'manual' });
  assertEq('/go → 302', goRes.status, 302);
  assertEq('/go 的 Location 指向网盘链接', goRes.headers.get('location'), 'https://pan.baidu.com/s/1aBcDeFgHiJkLmNoPqRsTu');
  assert('/go 带 Cache-Control: no-store', (goRes.headers.get('cache-control') ?? '').includes('no-store'), goRes.headers.get('cache-control') ?? '');
  const afterGo = await (await fetch(`${BASE}/api/projects/${id}?count=0`)).json();
  assertEq('下载计数 +1', afterGo.item.stats.downloads, 1);
  await fetch(`${BASE}/api/projects/${id}/go`, { redirect: 'manual' });
  const afterGo2 = await (await fetch(`${BASE}/api/projects/${id}?count=0`)).json();
  assertEq('再次点击累加到 2', afterGo2.item.stats.downloads, 2);
  assertEq('/go 对不存在的 id → 404', (await fetch(`${BASE}/api/projects/prj_不存在/go`, { redirect: 'manual' })).status, 404);

  /* ---------- 9 · SPA 回退与 404 信封 ---------- */
  section('9 · SPA 回退与 404 信封');
  const spaRes = await fetch(`${BASE}/p/${id}`);
  assertEq('GET /p/:id → 200', spaRes.status, 200);
  assert('深链回退到 index.html', (await spaRes.text()).includes('id="root"'));
  const nf = await (await fetch(`${BASE}/api/projects/prj_不存在`)).json();
  assertEq('未知项目 → 404', nf ? 404 : 0, 404);
  assertEq('404 使用统一错误信封', nf?.error?.code, 'NOT_FOUND');
  assertEq('未知 /api 路由 → 404 JSON', (await fetch(`${BASE}/api/definitely-not-a-route`)).status, 404);

  /* ---------- 10 · v1 的 PSD 端点必须已下线 ---------- */
  section('10 · v1 的 PSD 端点确已移除');
  assertEq('GET /files/psd → 404', (await fetch(`${BASE}/api/projects/${id}/files/psd`)).status, 404);
  assertEq('GET /files/preview → 404', (await fetch(`${BASE}/api/projects/${id}/files/preview`)).status, 404);
  assertEq('POST /:id/preview → 404', (await fetch(`${BASE}/api/projects/${id}/preview`, { method: 'POST', headers: authHeaders() })).status, 404);

  /* ---------- 11 · 输入校验 ---------- */
  section('11 · 输入校验');
  // 第 11、12 节会连续上传二十多次；先等一个干净的上传限流窗口，
  // 否则线上 30 次/分钟的限流会让断言拿到 429 而误报。
  await waitForRateLimitWindow('第 11、12 节有连续上传用例');
  const badPng = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    body: buildForm({ png: Buffer.from('not a png at all'), pngName: 'fake.png', title: '伪造图片', netdiskUrl: 'https://pan.baidu.com/s/1x' }),
    headers: authHeaders(),
  });
  assertEq('非 PNG 文件头 → 415', badPng.status, 415);

  const noTitle = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    body: buildForm({ png: PNG_MINI(), pngName: 'a.png', netdiskUrl: 'https://pan.baidu.com/s/1x' }),
    headers: authHeaders(),
  });
  assertEq('缺少 title → 400', noTitle.status, 400);

  const noLink = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    body: buildForm({ png: PNG_MINI(), pngName: 'a.png', title: '缺链接' }),
    headers: authHeaders(),
  });
  assertEq('缺少 netdiskUrl → 400', noLink.status, 400);

  for (const badUrl of ['javascript:alert(1)', 'ftp://example.com/x', 'not-a-url', `https://example.com/${'a'.repeat(600)}`]) {
    const r = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      body: buildForm({ png: PNG_MINI(), pngName: 'a.png', title: '非法链接', netdiskUrl: badUrl }),
      headers: authHeaders(),
    });
    assertEq(`非法 netdiskUrl 被拒（${badUrl.slice(0, 22)}…）→ 400`, r.status, 400);
  }

  /* ---------- 12 · 网盘识别表 ---------- */
  section('12 · 网盘识别（契约 §6）');
  const providerCases = [
    ['https://pan.baidu.com/s/1aaa', 'baidu', '百度网盘'],
    ['https://yun.baidu.com/s/1aaa', 'baidu', '百度网盘'],
    ['https://www.aliyundrive.com/s/abc', 'aliyun', '阿里云盘'],
    ['https://www.alipan.com/s/abc', 'aliyun', '阿里云盘'],
    ['https://pan.quark.cn/s/abc123', 'quark', '夸克网盘'],
    ['https://www.123pan.com/s/abc-def', '123pan', '123 云盘'],
    ['https://wwa.lanzouo.com/iAbCdEf', 'lanzou', '蓝奏云'],
    ['https://lanzoui.com/iAbCdEf', 'lanzou', '蓝奏云'],
    ['https://share.weiyun.com/abc', 'weiyun', '腾讯微云'],
    ['https://545c.com/file/12345', 'ctfile', '城通网盘'],
    ['https://1drv.ms/u/s!AbCd', 'onedrive', 'OneDrive'],
    ['https://drive.google.com/file/d/abc', 'googledrive', 'Google Drive'],
    ['https://mega.nz/file/abc', 'mega', 'MEGA'],
    ['https://www.dropbox.com/s/abc/x', 'dropbox', 'Dropbox'],
    ['https://files.example.com/share/x', 'other', '其它链接'],
    ['https://pan.baidu.com.evil.com/s/1x', 'other', '其它链接'],
  ];
  const probePng = PNG_PORTRAIT();
  const probeIds = [];
  for (const [url, expectProvider, expectLabel] of providerCases) {
    const res = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      body: buildForm({ png: probePng, pngName: 'probe.png', title: `识别：${url.slice(0, 40)}`, netdiskUrl: url, allowDuplicate: true }),
      headers: authHeaders(),
    });
    const body = await res.json().catch(() => ({}));
    if (!assert(`上传 ${url.slice(0, 42)} → 201`, res.status === 201, `status=${res.status}`)) continue;
    probeIds.push(body.item.id);
    assertEq(`  → provider = ${expectProvider}`, body.item.source.provider, expectProvider);
    assertEq(`  → providerLabel = ${expectLabel}`, body.item.source.providerLabel, expectLabel);
  }
  for (const pid of probeIds) {
    await fetch(`${BASE}/api/projects/${pid}`, { method: 'DELETE', headers: adminHeaders() });
  }
  assertEq('识别用例已清理干净（回到基线 +1）', (await (await fetch(`${BASE}/api/projects?pageSize=1`)).json()).total, baselineTotal + 1);

  /* ---------- 13 · PATCH 重新识别 provider ---------- */
  section('13 · PATCH 改网盘链接后重新识别');
  const patchRes = await fetch(`${BASE}/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...adminHeaders() },
    body: JSON.stringify({ netdiskUrl: 'https://pan.quark.cn/s/newlink', extractCode: 'new1' }),
  });
  const patched = await patchRes.json();
  assertEq('PATCH → 200', patchRes.status, 200);
  assertEq('provider 重新识别为 quark', patched.item?.source?.provider, 'quark');
  assertEq('providerLabel 同步更新', patched.item?.source?.providerLabel, '夸克网盘');
  assertEq('extractCode 已更新', patched.item?.source?.extractCode, 'new1');

  /* ---------- 14 · 删除 ---------- */
  section('14 · 删除');
  assertEq('DELETE → 204', (await fetch(`${BASE}/api/projects/${id}`, { method: 'DELETE', headers: adminHeaders() })).status, 204);
  assertEq('删除后详情 → 404', (await fetch(`${BASE}/api/projects/${id}`)).status, 404);
  assertEq('删除幂等（再次 DELETE → 204）', (await fetch(`${BASE}/api/projects/${id}`, { method: 'DELETE', headers: adminHeaders() })).status, 204);
  assertEq('清理后工程总数回到基线', (await (await fetch(`${BASE}/api/projects?pageSize=1`)).json()).total, baselineTotal);

  /* ---------- 15 · 登录与授权（v2.1） ---------- */
  section('15 · 登录与授权（v2.1）');
  assert('config.loginEnabled 为布尔值', typeof cfg.loginEnabled === 'boolean', String(cfg.loginEnabled));
  assert('config.mountPrefix 为字符串', typeof cfg.mountPrefix === 'string', JSON.stringify(cfg.mountPrefix));

  // 无凭据上传：配了登录或上传令牌 → 必须 401；两者都没配 → 契约 §8.3 第 3 条降级放行
  const anonRes = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    body: buildForm({ png: PNG_MINI(), pngName: 'anon.png', title: '匿名上传探测', netdiskUrl: 'https://pan.baidu.com/s/1anon' }),
  });
  if (cfg.loginEnabled || cfg.uploadTokenRequired) {
    assertEq('无凭据上传 → 401（必须登录或带令牌）', anonRes.status, 401);
  } else {
    assertEq('未启用任何鉴权时上传放行 → 201（本地开发降级）', anonRes.status, 201);
    if (anonRes.status === 201) {
      const created = (await anonRes.json()).item;
      await fetch(`${BASE}/api/projects/${created.id}`, { method: 'DELETE', headers: adminHeaders() });
    }
  }

  // /api/auth/me：无令牌一律 401（不需要联系主站就能判定）
  assertEq('GET /api/auth/me 无令牌 → 401', (await fetch(`${BASE}/api/auth/me`)).status, 401);

  const forgedToken =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbiI6ImhhY2tlciIsImlzX21lbWJlciI6dHJ1ZX0.fakesignature';

  if (cfg.loginEnabled) {
    // 配了主站：令牌真伪由主站裁决，本地没有任何旁路
    assertEq(
      'GET /api/auth/me 畸形令牌 → 401',
      (await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: 'not-a-jwt-at-all' } })).status,
      401,
    );
    assertEq(
      'GET /api/auth/me 伪造签名令牌 → 401（由主站裁决）',
      (await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: forgedToken } })).status,
      401,
    );
  } else {
    // 没配主站 → 无法校验令牌。此时必须**失败关闭**（502），
    // 既不能放行，也不能谎称"令牌无效"（401 会误导用户以为是自己凭据的问题）。
    assertEq(
      '未配置主站时 /me 失败关闭 → 502（不是 401，也不是放行）',
      (await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: forgedToken } })).status,
      502,
    );
  }

  // 登录接口的输入校验（不需要真实账号）
  const emptyLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cn: '', password: '' }),
  });
  assertEq('登录空字段 → 400', emptyLogin.status, 400);

  if (cfg.loginEnabled) {
    // 用错误口令验证「本服务 → 主站 /api/login」整条链路确实打通（无需真实账号）
    const wrongLogin = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cn: '__smoke_probe__', password: `definitely-wrong-${Date.now()}` }),
    });
    const wrongBody = await wrongLogin.json().catch(() => ({}));
    assertEq('错误口令 → 401（证明到主站的链路是通的）', wrongLogin.status, 401);
    assertEq('错误信封 code = UNAUTHORIZED', wrongBody?.error?.code, 'UNAUTHORIZED');
    assert('错误信息为中文', typeof wrongBody?.error?.message === 'string' && wrongBody.error.message.length > 0, wrongBody?.error?.message);
  } else {
    console.log('  · 本环境未配置 MAIN_SITE_BASE_URL，跳过真实登录链路验证');
  }

  assertEq('本节点未残留数据（总数回到基线）', (await (await fetch(`${BASE}/api/projects?pageSize=1`)).json()).total, baselineTotal);
}

/* ────────────────────────────── 收尾 ────────────────────────────── */

main()
  .catch((err) => {
    failures.push(`[运行异常] ${err instanceof Error ? err.message : String(err)}`);
    console.log(`\n✗ 运行异常：${err instanceof Error ? err.stack : String(err)}`);
  })
  .finally(() => {
    stopServer();
    console.log('\n' + '═'.repeat(64));
    if (failures.length === 0) {
      console.log(`✓ 端到端冒烟全部通过：${passed} 项断言`);
    } else {
      console.log(`✗ 端到端冒烟失败：${passed} 项通过，${failures.length} 项失败`);
      for (const f of failures) console.log(`  · ${f}`);
    }
    console.log('═'.repeat(64));
    setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 300);
  });
