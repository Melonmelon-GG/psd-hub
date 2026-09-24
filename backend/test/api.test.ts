/**
 * 端到端 HTTP 测试：createApp + app.listen(0) 随机端口，用全局 fetch 发真实 multipart 请求。
 * 覆盖契约 docs/API.md v2.0 的全部端点与关键行为：
 * PNG 上传、网盘链接校验与识别、去重、Range/条件请求、跳转计数、鉴权、限流、静态托管，
 * 以及**已移除的 v1 PSD 端点必须返回 404**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { exists } from '../src/lib/fsx.js';
import { sha256Buffer } from '../src/lib/hash.js';
import {
  DEFAULT_NETDISK_URL,
  type TestServer,
  assertErrorEnvelope,
  buildPngBuffer,
  deleteProject,
  getJson,
  listDir,
  makeTempDir,
  patchProject,
  readJson,
  startTestServer,
  uniquePng,
  uploadProject,
  uploadProjectOk,
} from './helpers.js';

const API = '/api';

describe('基础端点与通用约定', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  it('GET /api/health 返回存活信息（version = 2.0.0）', async () => {
    const { status, body } = await getJson(server.base, `${API}/health`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.name, 'psd-hub-api');
    assert.equal(body.version, '2.1.0');
    assert.equal(typeof body.uptimeMs, 'number');
    assert.ok(body.uptimeMs >= 0);
    assert.ok(!Number.isNaN(Date.parse(body.time)), 'time 必须是 ISO 8601');
  });

  it('GET /api/config 逐字段符合契约 §3.2（含 v2.0 新字段）', async () => {
    const { status, body } = await getJson(server.base, `${API}/config`);
    assert.equal(status, 200);
    assert.deepEqual(body, {
      name: 'psd-hub',
      version: '2.1.0',
      maxUploadBytes: 20971520,
      maxUploadLabel: '20 MB',
      acceptedImageTypes: ['image/png'],
      acceptedImageExtensions: ['.png'],
      uploadTokenRequired: false,
      adminTokenRequired: false,
      extractCodeMaxLength: 16,
      netdiskUrlMaxLength: 500,
      // v2.1：未配置 MAIN_SITE_BASE_URL → 不启用登录；未配置 MOUNT_PREFIX → 挂在根
      loginEnabled: false,
      mountPrefix: '',
    });
    // v1 的字段必须彻底消失
    assert.equal('allowedPsdExtensions' in body, false);
    assert.equal('acceptedPreviewTypes' in body, false);
  });

  it('响应头：x-request-id 透传 / 自动生成 + 基础安全头', async () => {
    const echoed = await fetch(`${server.base}${API}/health`, {
      headers: { 'x-request-id': 'trace-abc-123' },
    });
    assert.equal(echoed.headers.get('x-request-id'), 'trace-abc-123');

    const generated = await fetch(`${server.base}${API}/health`);
    const generatedId = generated.headers.get('x-request-id');
    assert.ok(generatedId && generatedId.length >= 8, '未透传时应生成新的 request id');

    assert.equal(generated.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(generated.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(generated.headers.get('x-frame-options'), 'DENY');
    assert.equal(generated.headers.get('x-powered-by'), null);
  });

  it('CORS：通配来源 + 允许头 + 暴露头', async () => {
    const response = await fetch(`${server.base}${API}/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const exposed = response.headers.get('access-control-expose-headers') ?? '';
    for (const header of ['Content-Disposition', 'Content-Range', 'Accept-Ranges', 'ETag', 'x-request-id']) {
      assert.ok(exposed.includes(header), `应暴露 ${header}`);
    }

    const preflight = await fetch(`${server.base}${API}/projects`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-upload-token,content-type',
      },
    });
    assert.ok(preflight.status === 204 || preflight.status === 200);
    const allowed = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const header of ['content-type', 'authorization', 'x-upload-token', 'x-admin-token']) {
      assert.ok(allowed.includes(header), `应允许请求头 ${header}`);
    }
  });

  it('未匹配的 /api 路径返回 404 JSON 信封', async () => {
    const { status, body } = await getJson(server.base, `${API}/nope`);
    assert.equal(status, 404);
    assertErrorEnvelope(body, 'NOT_FOUND');
  });
});

describe('上传：成功路径（PNG + 网盘链接）', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  it('中文标题 + 中文文件名 + 全角逗号标签 + 提取码 → 201，字段齐全', async () => {
    const png = buildPngBuffer(64, 32, { seed: 1 });

    const result = await uploadProject(server.base, {
      image: png,
      imageName: '深色UI稿.png',
      title: '  深色 UI 稿  ',
      description: '第一行说明\n第二行说明',
      author: '  张三  ',
      tags: 'UI，科幻, UI ,,',
      netdiskUrl: 'https://pan.baidu.com/s/1abcdef',
      extractCode: ' abcd ',
      sourceFileName: '  深色UI稿.psd  ',
      sourceNote: '  含分层源文件  ',
    });

    assert.equal(result.status, 201);
    assert.match(result.response.headers.get('content-type') ?? '', /application\/json/);
    const item = result.item;
    assert.ok(item, '响应体应包含 item');
    assert.match(item.id, /^prj_[0-9a-f]{12}$/);
    assert.equal(item.title, '深色 UI 稿');
    assert.equal(item.description, '第一行说明\n第二行说明');
    assert.equal(item.author, '张三');
    assert.deepEqual(item.tags, ['UI', '科幻'], '应支持全角逗号分隔并去重、过滤空串');
    assert.ok(!Number.isNaN(Date.parse(item.createdAt)));
    assert.ok(!Number.isNaN(Date.parse(item.updatedAt)));

    // ImageInfo（契约 §1.2）
    assert.deepEqual(item.image, {
      fileName: '深色UI稿.png',
      size: png.length,
      sha256: sha256Buffer(png),
      width: 64,
      height: 32,
      url: `${API}/projects/${item.id}/files/image`,
      downloadUrl: `${API}/projects/${item.id}/files/image?download=1`,
    });
    assert.equal('source' in item.image, false, 'v2.0 的 ImageInfo 不再有 source 字段');

    // NetdiskSource（契约 §1.3）
    assert.deepEqual(item.source, {
      provider: 'baidu',
      providerLabel: '百度网盘',
      url: 'https://pan.baidu.com/s/1abcdef',
      extractCode: 'abcd',
      fileName: '深色UI稿.psd',
      note: '含分层源文件',
    });

    // v1 字段必须彻底消失
    assert.equal('psd' in item, false);
    assert.equal('preview' in item, false);

    assert.deepEqual(item.stats, { views: 0, downloads: 0 });

    // 落盘布局（契约 §4）：projects/<id>/{image.png,meta.json}
    const projectDir = path.join(server.dataDir, 'projects', item.id);
    assert.ok(await exists(path.join(projectDir, 'image.png')));
    assert.ok(await exists(path.join(projectDir, 'meta.json')));
    assert.equal(await exists(path.join(projectDir, 'original.psd')), false, '不应再写 PSD');
    assert.equal(await exists(path.join(projectDir, 'preview.png')), false, '不应再写 preview.png');

    const stored = await fs.readFile(path.join(projectDir, 'image.png'));
    assert.ok(stored.equals(png), '落盘字节必须与上传完全一致');

    const meta = JSON.parse(await fs.readFile(path.join(projectDir, 'meta.json'), 'utf8'));
    assert.equal(meta.id, item.id);
    assert.equal(meta.title, '深色 UI 稿');
    assert.equal(meta.source.provider, 'baidu');

    // db.json 结构：version 必须是 2
    const db = JSON.parse(await fs.readFile(path.join(server.dataDir, 'db.json'), 'utf8'));
    assert.equal(db.version, 2);
    assert.equal(db.projects.length, 1);
    assert.equal(db.projects[0].id, item.id);
    assert.equal('psd' in db.projects[0], false);
    assert.equal('preview' in db.projects[0], false);

    // tmp 目录已清空
    assert.deepEqual(await listDir(path.join(server.dataDir, 'tmp')), []);
  });

  it('各网盘主机名在上传时被服务端识别（quark / aliyun / other）', async () => {
    const quark = await uploadProjectOk(server.base, {
      image: uniquePng(2),
      title: '夸克网盘项目',
      netdiskUrl: 'https://pan.quark.cn/s/abcdef',
    });
    assert.equal(quark.source.provider, 'quark');
    assert.equal(quark.source.providerLabel, '夸克网盘');

    const aliyun = await uploadProjectOk(server.base, {
      image: uniquePng(3),
      title: '阿里云盘项目',
      netdiskUrl: 'https://www.aliyundrive.com/s/abcdef',
    });
    assert.equal(aliyun.source.provider, 'aliyun');
    assert.equal(aliyun.source.providerLabel, '阿里云盘');

    const other = await uploadProjectOk(server.base, {
      image: uniquePng(4),
      title: '其它链接项目',
      netdiskUrl: 'https://example.com/share/1',
    });
    assert.equal(other.source.provider, 'other');
    assert.equal(other.source.providerLabel, '其它链接');
  });

  it('伪装域名不会被识别成网盘（provider = other）', async () => {
    const item = await uploadProjectOk(server.base, {
      image: uniquePng(5),
      title: '伪装链接',
      netdiskUrl: 'https://pan.baidu.com.evil.com/s/1',
    });
    assert.equal(item.source.provider, 'other');
    assert.equal(item.source.providerLabel, '其它链接');
  });

  it('tags 以同名字段重复出现 → 合并去重', async () => {
    const item = await uploadProjectOk(server.base, {
      image: uniquePng(6),
      title: '重复标签写法的项目',
      tags: ['UI', '科幻', 'UI'],
    });
    assert.deepEqual(item.tags, ['UI', '科幻']);
  });

  it('author 留空 → "匿名作者"；description 缺省为空串；可空字段缺省为 null', async () => {
    const item = await uploadProjectOk(server.base, {
      image: uniquePng(7),
      title: '缺省字段',
      author: '   ',
    });
    assert.equal(item.author, '匿名作者');
    assert.equal(item.description, '');
    assert.deepEqual(item.tags, []);
    assert.equal(item.source.extractCode, null);
    assert.equal(item.source.fileName, null);
    assert.equal(item.source.note, null);
  });

  it('可空文本 trim 后为空 → 存 null（不存空字符串）', async () => {
    const item = await uploadProjectOk(server.base, {
      image: uniquePng(8),
      title: '空文本字段',
      extractCode: '    ',
      sourceFileName: '',
      sourceNote: '\t\n ',
    });
    assert.equal(item.source.extractCode, null);
    assert.equal(item.source.fileName, null);
    assert.equal(item.source.note, null);
  });

  it('PNG 宽高从 IHDR 解析（非默认尺寸）', async () => {
    const png = buildPngBuffer(300, 150, { seed: 9 });
    const item = await uploadProjectOk(server.base, {
      image: png,
      imageName: '大图.png',
      title: '尺寸解析',
    });
    assert.equal(item.image.width, 300);
    assert.equal(item.image.height, 150);
    assert.equal(item.image.size, png.length);
  });

  it('同名标题的两次上传（不同 PNG）各自成项目', async () => {
    const first = await uploadProjectOk(server.base, { image: uniquePng(10), title: '同名项目' });
    const second = await uploadProjectOk(server.base, { image: uniquePng(11), title: '同名项目' });
    assert.notEqual(first.id, second.id);
    assert.equal(first.source.url, DEFAULT_NETDISK_URL);
    assert.equal(second.source.url, DEFAULT_NETDISK_URL);
  });
});

describe('上传：sha256 去重（基于 PNG）', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  it('重复 sha256 → 409 DUPLICATE 且 details.existingId 正确', async () => {
    const png = buildPngBuffer(40, 40, { seed: 21 });
    const first = await uploadProjectOk(server.base, { image: png, title: '首次上传' });

    const again = await uploadProject(server.base, { image: png, title: '重复上传' });
    assert.equal(again.status, 409);
    const error = assertErrorEnvelope(again.body, 'DUPLICATE');
    assert.equal(error.details.existingId, first.id);
    assert.equal(error.details.sha256, sha256Buffer(png));

    const list = await getJson(server.base, `${API}/projects`);
    assert.equal(list.body.total, 1, '重复上传不应产生新项目');
  });

  it('同一张 PNG 改文件名仍然算重复（按内容而非文件名去重）', async () => {
    const png = buildPngBuffer(40, 40, { seed: 22 });
    await uploadProjectOk(server.base, { image: png, imageName: 'A.png', title: '内容去重 A' });
    const again = await uploadProject(server.base, { image: png, imageName: 'B.png', title: '内容去重 B' });
    assert.equal(again.status, 409);
    assertErrorEnvelope(again.body, 'DUPLICATE');
  });

  it('allowDuplicate=1 / true → 跳过去重，返回 201 且生成新 id', async () => {
    const png = buildPngBuffer(40, 40, { seed: 23 });
    const first = await uploadProjectOk(server.base, { image: png, title: '允许重复 A' });
    const second = await uploadProjectOk(server.base, { image: png, title: '允许重复 B', allowDuplicate: '1' });

    assert.notEqual(first.id, second.id);
    assert.equal(first.image.sha256, second.image.sha256);

    const withTrue = await uploadProjectOk(server.base, { image: png, title: '允许重复 C', allowDuplicate: 'true' });
    assert.notEqual(withTrue.id, second.id);
  });
});

describe('上传：校验失败与临时文件清理', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  it('文件头不是 PNG 魔数 → 415', async () => {
    const broken = Buffer.from('这不是一张 PNG 图片', 'utf8');
    const result = await uploadProject(server.base, {
      image: broken,
      imageName: '假装.png',
      title: '坏文件头',
    });
    assert.equal(result.status, 415);
    assertErrorEnvelope(result.body, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('扩展名不是 .png（.psd / .txt）→ 415', async () => {
    for (const name of ['源文件.psd', '伪装文件.txt', '图片.jpeg']) {
      const result = await uploadProject(server.base, {
        image: buildPngBuffer(8, 8, { seed: 31 }),
        imageName: name,
        title: '错误扩展名',
      });
      assert.equal(result.status, 415, `${name} 应被拒绝`);
      assertErrorEnvelope(result.body, 'UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('缺少 image 文件 → 400 且 details.field = image', async () => {
    const result = await uploadProject(server.base, { image: null, title: '没有图片' });
    assert.equal(result.status, 400);
    const error = assertErrorEnvelope(result.body, 'BAD_REQUEST');
    assert.equal(error.details.field, 'image');
  });

  it('v1 的 psd 字段已不再支持 → 400', async () => {
    const result = await uploadProject(server.base, {
      title: '尝试传 PSD',
      extraFiles: [{ field: 'psd', fileName: '旧稿.psd', data: Buffer.from('8BPS0123456789', 'latin1') }],
    });
    assert.equal(result.status, 400);
    const error = assertErrorEnvelope(result.body, 'BAD_REQUEST');
    assert.match(error.message, /不支持的上传字段/);
  });

  it('缺少 title → 400 且 details.field = title', async () => {
    const result = await uploadProject(server.base, { image: uniquePng(32), title: null });
    assert.equal(result.status, 400);
    const error = assertErrorEnvelope(result.body, 'BAD_REQUEST');
    assert.equal(error.details.field, 'title');
  });

  it('title 空白 / 超长 → 400', async () => {
    const blank = await uploadProject(server.base, { image: uniquePng(33), title: '    ' });
    assert.equal(blank.status, 400);
    assertErrorEnvelope(blank.body, 'BAD_REQUEST');

    const tooLong = await uploadProject(server.base, {
      image: uniquePng(34),
      title: '标'.repeat(121),
    });
    assert.equal(tooLong.status, 400);
    const error = assertErrorEnvelope(tooLong.body, 'BAD_REQUEST');
    assert.equal(error.details.field, 'title');
  });

  it('缺少 netdiskUrl → 400 且 details.field = netdiskUrl', async () => {
    const result = await uploadProject(server.base, {
      image: uniquePng(35),
      title: '没有网盘链接',
      netdiskUrl: null,
    });
    assert.equal(result.status, 400);
    const error = assertErrorEnvelope(result.body, 'BAD_REQUEST');
    assert.equal(error.details.field, 'netdiskUrl');
  });

  it('非法 netdiskUrl → 400（javascript: / ftp: / 无协议 / 超长 / 缺主机名）', async () => {
    const bad = [
      'javascript:alert(1)',
      'ftp://x',
      'pan.baidu.com/s/1abcdef',
      'https://',
      `https://pan.baidu.com/s/${'a'.repeat(480)}`,
    ];
    for (const netdiskUrl of bad) {
      const result = await uploadProject(server.base, {
        image: uniquePng(36),
        title: '非法链接',
        netdiskUrl,
      });
      assert.equal(result.status, 400, `${netdiskUrl} 应被拒绝`);
      const error = assertErrorEnvelope(result.body, 'BAD_REQUEST');
      assert.equal(error.details.field, 'netdiskUrl');
    }
  });

  it('description / author / tags 越界 → 400', async () => {
    const longDescription = await uploadProject(server.base, {
      image: uniquePng(37),
      title: '说明过长',
      description: 'a'.repeat(5001),
    });
    assert.equal(longDescription.status, 400);

    const longAuthor = await uploadProject(server.base, {
      image: uniquePng(38),
      title: '作者过长',
      author: 'a'.repeat(61),
    });
    assert.equal(longAuthor.status, 400);

    const tooManyTags = await uploadProject(server.base, {
      image: uniquePng(39),
      title: '标签过多',
      tags: 'a,b,c,d,e,f,g,h,i,j,k,l,m',
    });
    assert.equal(tooManyTags.status, 400);
    const error = assertErrorEnvelope(tooManyTags.body, 'BAD_REQUEST');
    assert.equal(error.details.field, 'tags');

    const longTag = await uploadProject(server.base, {
      image: uniquePng(40),
      title: '标签过长',
      tags: 'x'.repeat(25),
    });
    assert.equal(longTag.status, 400);
  });

  it('extractCode > 16 / sourceFileName > 200 / sourceNote > 200 → 400', async () => {
    const longCode = await uploadProject(server.base, {
      image: uniquePng(41),
      title: '提取码过长',
      extractCode: 'a'.repeat(17),
    });
    assert.equal(longCode.status, 400);
    assert.equal(assertErrorEnvelope(longCode.body, 'BAD_REQUEST').details.field, 'extractCode');

    const longName = await uploadProject(server.base, {
      image: uniquePng(42),
      title: '源文件名过长',
      sourceFileName: `${'名'.repeat(200)}.psd`,
    });
    assert.equal(longName.status, 400);
    assert.equal(assertErrorEnvelope(longName.body, 'BAD_REQUEST').details.field, 'sourceFileName');

    const longNote = await uploadProject(server.base, {
      image: uniquePng(43),
      title: '备注过长',
      sourceNote: '备'.repeat(201),
    });
    assert.equal(longNote.status, 400);
    assert.equal(assertErrorEnvelope(longNote.body, 'BAD_REQUEST').details.field, 'sourceNote');

    // 边界：恰好 16 / 200 / 200 允许
    const boundary = await uploadProjectOk(server.base, {
      image: uniquePng(44),
      title: '边界长度',
      extractCode: 'c'.repeat(16),
      sourceFileName: 'n'.repeat(200),
      sourceNote: 'b'.repeat(200),
    });
    assert.equal(boundary.source.extractCode, 'c'.repeat(16));
    assert.equal(boundary.source.fileName, 'n'.repeat(200));
    assert.equal(boundary.source.note, 'b'.repeat(200));
  });

  it('校验失败的请求不留下临时文件，也不写库', async () => {
    assert.deepEqual(await listDir(path.join(server.dataDir, 'tmp')), [], 'tmp 目录应为空');
    const list = await getJson(server.base, `${API}/projects`);
    assert.equal(list.body.total, 1, '只有"边界长度"那次成功上传');
    const projectEntries = await listDir(path.join(server.dataDir, 'projects'));
    assert.equal(projectEntries.length, 1, '不应残留失败的项目目录');
  });
});

describe('上传：超过 MAX_UPLOAD_MB → 413', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer({ MAX_UPLOAD_MB: '1' });
  });

  after(async () => {
    await server.close();
  });

  it('1.5MB 的 PNG（上限 1MB）→ 413 PAYLOAD_TOO_LARGE', async () => {
    const oversize = buildPngBuffer(64, 64, { seed: 51, padAfterEnd: Math.floor(1.5 * 1024 * 1024) });
    const result = await uploadProject(server.base, { image: oversize, title: '超大文件' });
    assert.equal(result.status, 413);
    assertErrorEnvelope(result.body, 'PAYLOAD_TOO_LARGE');
    assert.deepEqual(await listDir(path.join(server.dataDir, 'tmp')), [], '超限请求也应清理临时文件');
  });

  it('略小于上限的文件仍可上传', async () => {
    const ok = buildPngBuffer(64, 64, { seed: 52, padAfterEnd: 512 * 1024 });
    const item = await uploadProjectOk(server.base, { image: ok, title: '合法体积' });
    assert.equal(item.image.size, ok.length);
  });

  it('GET /api/config 反映自定义上限', async () => {
    const { body } = await getJson(server.base, `${API}/config`);
    assert.equal(body.maxUploadBytes, 1048576);
    assert.equal(body.maxUploadLabel, '1 MB');
  });
});

describe('列表：搜索 / 过滤 / 排序 / 分页 / 标签聚合', () => {
  let server: TestServer;
  const created: Record<string, string> = {};

  before(async () => {
    server = await startTestServer();
    created.alpha = (
      await uploadProjectOk(server.base, {
        image: buildPngBuffer(20, 10, { seed: 61 }),
        imageName: 'AlphaDark.png',
        title: 'Alpha 深色界面',
        description: '科技感 Dashboard',
        author: '张三',
        tags: 'UI,科幻',
        netdiskUrl: 'https://pan.baidu.com/s/alpha',
        sourceFileName: 'AlphaDark.psd',
      })
    ).id;
    created.beta = (
      await uploadProjectOk(server.base, {
        image: buildPngBuffer(20, 10, { seed: 62 }),
        imageName: 'BetaPoster.png',
        title: 'Beta 海报',
        description: '夏季促销视觉',
        author: '李四',
        tags: ['UI'],
        netdiskUrl: 'https://pan.quark.cn/s/beta',
      })
    ).id;
    created.gamma = (
      await uploadProjectOk(server.base, {
        image: buildPngBuffer(20, 10, { seed: 63 }),
        imageName: 'GuoFeng.png',
        title: 'Gamma 国风',
        description: '水墨风格插画',
        author: '张三',
        tags: ['UI', '海报'],
        netdiskUrl: 'https://www.aliyundrive.com/s/gamma',
      })
    ).id;
  });

  after(async () => {
    await server.close();
  });

  it('默认分页与排序：newest、page=1、pageSize=12', async () => {
    const { status, body } = await getJson(server.base, `${API}/projects`);
    assert.equal(status, 200);
    assert.equal(body.total, 3);
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 12);
    assert.equal(body.totalPages, 1);
    assert.equal(body.items.length, 3);
    assert.equal(body.items[0].id, created.gamma, '最新创建的排在最前');
    // 列表项与详情共用同一序列化路径：image / source 必须完整带出
    for (const item of body.items) {
      assert.ok(item.image.url.endsWith('/files/image'), `列表项 ${item.id} 的 image.url 不正确`);
      assert.equal(typeof item.image.sha256, 'string');
      assert.ok(['baidu', 'quark', 'aliyun'].includes(item.source.provider));
      assert.equal(typeof item.source.providerLabel, 'string');
    }
  });

  it('q 全字段模糊匹配且大小写不敏感', async () => {
    const byTitle = await getJson(server.base, `${API}/projects?q=${encodeURIComponent('深色')}`);
    assert.deepEqual(
      byTitle.body.items.map((item: any) => item.id),
      [created.alpha],
    );

    const byDescription = await getJson(server.base, `${API}/projects?q=${encodeURIComponent('促销')}`);
    assert.deepEqual(
      byDescription.body.items.map((item: any) => item.id),
      [created.beta],
    );

    const byAuthor = await getJson(server.base, `${API}/projects?q=${encodeURIComponent('张三')}`);
    assert.equal(byAuthor.body.total, 2);

    const byTag = await getJson(server.base, `${API}/projects?q=${encodeURIComponent('海报')}`);
    assert.equal(byTag.body.total, 2, '标签命中 gamma 与 beta 的 title');

    // image.fileName（大小写不敏感）
    const byImageName = await getJson(server.base, `${API}/projects?q=guofeng`);
    assert.deepEqual(
      byImageName.body.items.map((item: any) => item.id),
      [created.gamma],
    );

    // source.fileName（网盘里那个源文件名）
    const bySourceName = await getJson(server.base, `${API}/projects?q=alphadark.psd`);
    assert.deepEqual(
      bySourceName.body.items.map((item: any) => item.id),
      [created.alpha],
    );
  });

  it('tag / author 精确匹配', async () => {
    const byTag = await getJson(server.base, `${API}/projects?tag=${encodeURIComponent('科幻')}`);
    assert.deepEqual(
      byTag.body.items.map((item: any) => item.id),
      [created.alpha],
    );

    const byAuthor = await getJson(server.base, `${API}/projects?author=${encodeURIComponent('李四')}`);
    assert.deepEqual(
      byAuthor.body.items.map((item: any) => item.id),
      [created.beta],
    );

    const noMatch = await getJson(server.base, `${API}/projects?tag=nope`);
    assert.equal(noMatch.body.total, 0);
  });

  it('provider 按网盘类型精确过滤；非法值按"不过滤"宽容处理', async () => {
    const baidu = await getJson(server.base, `${API}/projects?provider=baidu`);
    assert.deepEqual(
      baidu.body.items.map((item: any) => item.id),
      [created.alpha],
    );

    const quark = await getJson(server.base, `${API}/projects?provider=quark`);
    assert.deepEqual(
      quark.body.items.map((item: any) => item.id),
      [created.beta],
    );

    const aliyun = await getJson(server.base, `${API}/projects?provider=aliyun`);
    assert.deepEqual(
      aliyun.body.items.map((item: any) => item.id),
      [created.gamma],
    );

    const other = await getJson(server.base, `${API}/projects?provider=other`);
    assert.equal(other.body.total, 0);

    const bogus = await getJson(server.base, `${API}/projects?provider=bogus`);
    assert.equal(bogus.body.total, 3, '非法 provider 回退为不过滤');

    // provider 可与 tag / sort 组合
    const combined = await getJson(server.base, `${API}/projects?provider=baidu&tag=UI&sort=oldest`);
    assert.deepEqual(
      combined.body.items.map((item: any) => item.id),
      [created.alpha],
    );
  });

  it('sort 五种取值均生效，非法 sort 回退 newest', async () => {
    const oldest = await getJson(server.base, `${API}/projects?sort=oldest`);
    assert.deepEqual(
      oldest.body.items.map((item: any) => item.id),
      [created.alpha, created.beta, created.gamma],
    );

    const newest = await getJson(server.base, `${API}/projects?sort=newest`);
    assert.deepEqual(
      newest.body.items.map((item: any) => item.id),
      [created.gamma, created.beta, created.alpha],
    );

    const byTitle = await getJson(server.base, `${API}/projects?sort=title`);
    assert.deepEqual(
      byTitle.body.items.map((item: any) => item.id),
      [created.alpha, created.beta, created.gamma],
    );

    // 制造下载/浏览差异：下载计数只由 /go 维护（契约 §3.10）
    // redirect: 'manual' 防止 fetch 真的跳到外网网盘
    await fetch(`${server.base}${API}/projects/${created.alpha}/go`, { redirect: 'manual' });
    await fetch(`${server.base}${API}/projects/${created.alpha}/go`, { redirect: 'manual' });
    await fetch(`${server.base}${API}/projects/${created.beta}/go`, { redirect: 'manual' });
    await getJson(server.base, `${API}/projects/${created.beta}`);

    const byDownloads = await getJson(server.base, `${API}/projects?sort=downloads`);
    assert.equal(byDownloads.body.items[0].id, created.alpha);
    assert.equal(byDownloads.body.items[0].stats.downloads, 2);

    const byViews = await getJson(server.base, `${API}/projects?sort=views`);
    assert.equal(byViews.body.items[0].id, created.beta);

    const bogus = await getJson(server.base, `${API}/projects?sort=bogus`);
    assert.deepEqual(
      bogus.body.items.map((item: any) => item.id),
      [created.gamma, created.beta, created.alpha],
      '非法 sort 按 newest 处理',
    );
  });

  it('分页参数与越界行为', async () => {
    const page1 = await getJson(server.base, `${API}/projects?page=1&pageSize=2&sort=oldest`);
    assert.equal(page1.body.total, 3);
    assert.equal(page1.body.totalPages, 2);
    assert.equal(page1.body.items.length, 2);

    const page2 = await getJson(server.base, `${API}/projects?page=2&pageSize=2&sort=oldest`);
    assert.equal(page2.body.items.length, 1);

    const beyond = await getJson(server.base, `${API}/projects?page=99&pageSize=2`);
    assert.deepEqual(beyond.body.items, []);
    assert.equal(beyond.body.total, 3);

    const clamped = await getJson(server.base, `${API}/projects?pageSize=999`);
    assert.equal(clamped.body.pageSize, 48, 'pageSize 上限 48');

    const tolerant = await getJson(server.base, `${API}/projects?page=abc&pageSize=-1&unknown=1`);
    assert.equal(tolerant.body.page, 1);
    assert.equal(tolerant.body.pageSize, 12, '非法参数回退默认值且对未知参数沉默');
  });

  it('GET /api/projects/tags 不被 /:id 路由吞掉，按 count 降序聚合', async () => {
    const { status, body } = await getJson(server.base, `${API}/projects/tags`);
    assert.equal(status, 200);
    assert.deepEqual(body, {
      tags: [
        { name: 'UI', count: 3 },
        { name: '海报', count: 1 },
        { name: '科幻', count: 1 },
      ],
    });
  });
});

describe('详情：浏览计数', () => {
  let server: TestServer;
  let id: string;

  before(async () => {
    server = await startTestServer();
    id = (await uploadProjectOk(server.base, { image: uniquePng(71), title: '计数测试' })).id;
  });

  after(async () => {
    await server.close();
  });

  it('默认 +1 浏览，且 image / source 完整带出', async () => {
    const first = await getJson(server.base, `${API}/projects/${id}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.item.stats.views, 1);
    assert.equal(first.body.item.image.width, 8);
    assert.equal(first.body.item.source.provider, 'baidu');

    const second = await getJson(server.base, `${API}/projects/${id}`);
    assert.equal(second.body.item.stats.views, 2);
    assert.equal(second.body.item.source.providerLabel, '百度网盘', '计浏览走的是写库后的副本，字段不能丢');
  });

  it('?count=0 不增加浏览计数', async () => {
    const before = await getJson(server.base, `${API}/projects/${id}`);
    const views = before.body.item.stats.views;

    const skipped = await getJson(server.base, `${API}/projects/${id}?count=0`);
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.item.stats.views, views);

    const after9 = await getJson(server.base, `${API}/projects/${id}?count=0`);
    assert.equal(after9.body.item.stats.views, views);
  });

  it('不存在的 id → 404 NOT_FOUND', async () => {
    const { status, body } = await getJson(server.base, `${API}/projects/prj_ffffffffffff`);
    assert.equal(status, 404);
    assertErrorEnvelope(body, 'NOT_FOUND');
  });
});

describe('PATCH：文本字段与网盘信息', () => {
  let server: TestServer;
  let id: string;

  before(async () => {
    server = await startTestServer();
    id = (
      await uploadProjectOk(server.base, {
        image: uniquePng(81),
        title: '待修改标题',
        description: '原说明',
        author: '原作者',
        tags: 'UI',
        netdiskUrl: 'https://pan.baidu.com/s/old',
        extractCode: 'old1',
      })
    ).id;
  });

  after(async () => {
    await server.close();
  });

  it('PATCH 修改标题与标签，未出现的字段保持不变', async () => {
    const { status, body } = await patchProject(server.base, id, {
      title: '新标题',
      tags: ['UI', '新标签'],
    });
    assert.equal(status, 200);
    assert.equal(body.item.title, '新标题');
    assert.deepEqual(body.item.tags, ['UI', '新标签']);
    assert.equal(body.item.description, '原说明');
    assert.equal(body.item.author, '原作者');
    assert.ok(Date.parse(body.item.updatedAt) >= Date.parse(body.item.createdAt));
    // image / source 不能被更新路径吞掉
    assert.equal(body.item.image.fileName, '深色UI稿.png');
    assert.equal(body.item.source.provider, 'baidu');
    assert.equal(body.item.source.extractCode, 'old1');
  });

  it('PATCH 支持 tags 为逗号分隔字符串，author 清空回退匿名作者', async () => {
    const { status, body } = await patchProject(server.base, id, { tags: 'A，B, C', author: '   ' });
    assert.equal(status, 200);
    assert.deepEqual(body.item.tags, ['A', 'B', 'C']);
    assert.equal(body.item.author, '匿名作者');
  });

  it('修改 netdiskUrl → provider / providerLabel 必须重新识别（契约 §3.7）', async () => {
    const { status, body } = await patchProject(server.base, id, {
      netdiskUrl: 'https://pan.quark.cn/s/new-link',
    });
    assert.equal(status, 200);
    assert.equal(body.item.source.url, 'https://pan.quark.cn/s/new-link');
    assert.equal(body.item.source.provider, 'quark', '换链接后必须重新识别网盘类型');
    assert.equal(body.item.source.providerLabel, '夸克网盘');
    assert.equal(body.item.source.extractCode, 'old1', '未出现的网盘子字段保持不变');

    const toBaidu = await patchProject(server.base, id, { netdiskUrl: 'https://yun.baidu.com/s/back' });
    assert.equal(toBaidu.status, 200);
    assert.equal(toBaidu.body.item.source.provider, 'baidu');
    assert.equal(toBaidu.body.item.source.providerLabel, '百度网盘');

    const toOther = await patchProject(server.base, id, { netdiskUrl: 'https://example.com/x' });
    assert.equal(toOther.body.item.source.provider, 'other');
    assert.equal(toOther.body.item.source.providerLabel, '其它链接');
  });

  it('只改 netdiskUrl 之外的网盘子字段时不重算 provider', async () => {
    const { status, body } = await patchProject(server.base, id, {
      extractCode: 'zz99',
      sourceFileName: '源文件.psd',
      sourceNote: '含分层源文件',
    });
    assert.equal(status, 200);
    assert.equal(body.item.source.provider, 'other', 'url 未变，provider 保持');
    assert.equal(body.item.source.extractCode, 'zz99');
    assert.equal(body.item.source.fileName, '源文件.psd');
    assert.equal(body.item.source.note, '含分层源文件');

    // 可空字段用空串/空白清空 → null
    const cleared = await patchProject(server.base, id, { extractCode: '  ', sourceFileName: '', sourceNote: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.item.source.extractCode, null);
    assert.equal(cleared.body.item.source.fileName, null);
    assert.equal(cleared.body.item.source.note, null);
  });

  it('PATCH 非法 netdiskUrl → 400；超长可空字段 → 400', async () => {
    const badUrl = await patchProject(server.base, id, { netdiskUrl: 'javascript:alert(1)' });
    assert.equal(badUrl.status, 400);
    const error = assertErrorEnvelope(badUrl.body, 'BAD_REQUEST');
    assert.equal(error.details.field, 'netdiskUrl');

    const tooLong = await patchProject(server.base, id, { extractCode: 'a'.repeat(17) });
    assert.equal(tooLong.status, 400);
    assert.equal(assertErrorEnvelope(tooLong.body, 'BAD_REQUEST').details.field, 'extractCode');

    const longNote = await patchProject(server.base, id, { sourceNote: 'b'.repeat(201) });
    assert.equal(longNote.status, 400);
  });

  it('PATCH 校验失败 → 400；不存在的 id → 404', async () => {
    const empty = await patchProject(server.base, id, { title: '   ' });
    assert.equal(empty.status, 400);
    assertErrorEnvelope(empty.body, 'BAD_REQUEST');

    const wrongType = await patchProject(server.base, id, { title: 123 });
    assert.equal(wrongType.status, 400);
    assertErrorEnvelope(wrongType.body, 'BAD_REQUEST');

    const missing = await patchProject(server.base, 'prj_ffffffffffff', { title: 'x' });
    assert.equal(missing.status, 404);
    assertErrorEnvelope(missing.body, 'NOT_FOUND');
  });

  it('PATCH 后重新读库仍然一致（重启不丢字段）', async () => {
    const before = await getJson(server.base, `${API}/projects/${id}?count=0`);
    const db = JSON.parse(await fs.readFile(path.join(server.dataDir, 'db.json'), 'utf8'));
    assert.equal(db.version, 2);
    const stored = db.projects.find((item: any) => item.id === id);
    assert.equal(stored.source.url, before.body.item.source.url);
    assert.equal(stored.source.provider, before.body.item.source.provider);
    assert.equal(stored.image.sha256, before.body.item.image.sha256);
  });
});

describe('DELETE：幂等删除', () => {
  let server: TestServer;
  let id: string;

  before(async () => {
    server = await startTestServer();
    id = (await uploadProjectOk(server.base, { image: uniquePng(91), title: '待删除' })).id;
  });

  after(async () => {
    await server.close();
  });

  it('返回 204 且幂等，删除后详情 404 并移除文件', async () => {
    const projectDir = path.join(server.dataDir, 'projects', id);
    assert.ok(await exists(projectDir));

    const first = await deleteProject(server.base, id);
    assert.equal(first.status, 204);
    assert.equal(await first.text(), '');

    assert.equal((await getJson(server.base, `${API}/projects/${id}`)).status, 404);
    assert.equal(await exists(projectDir), false, '项目目录应被删除');

    const again = await deleteProject(server.base, id);
    assert.equal(again.status, 204, '重复删除同样返回 204');

    const never = await deleteProject(server.base, 'prj_ffffffffffff');
    assert.equal(never.status, 204, '对不存在的 id 也是 204');
  });
});

describe('图片下发：200 / Range / 条件请求 / 附件', () => {
  let server: TestServer;
  let id: string;
  let pngBytes: Buffer;

  before(async () => {
    server = await startTestServer();
    pngBytes = buildPngBuffer(48, 24, { seed: 101 });
    id = (
      await uploadProjectOk(server.base, {
        image: pngBytes,
        imageName: '深色 稿.png',
        title: '图片下发测试',
        netdiskUrl: 'https://pan.baidu.com/s/1abcdef',
      })
    ).id;
  });

  after(async () => {
    await server.close();
  });

  it('200：字节完全一致 + 必备响应头（契约 §3.9）', async () => {
    const response = await fetch(`${server.base}${API}/projects/${id}/files/image`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-length'), String(pngBytes.length));
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.ok(response.headers.get('etag'), '必须带 ETag');
    assert.ok(response.headers.get('last-modified'), '必须带 Last-Modified');
    assert.match(response.headers.get('content-disposition') ?? '', /^inline;/);

    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, pngBytes.length);
    assert.ok(body.equals(pngBytes), '下载内容必须与上传字节完全一致');
  });

  it('Range: bytes=0-9 → 206 + Content-Range，长度 10', async () => {
    const response = await fetch(`${server.base}${API}/projects/${id}/files/image`, {
      headers: { Range: 'bytes=0-9' },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 0-9/${pngBytes.length}`);
    assert.equal(response.headers.get('content-length'), '10');
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, 10);
    assert.ok(body.equals(pngBytes.subarray(0, 10)));
  });

  it('Range: bytes=0- → 206 全量；bytes=-16 → 末尾 16 字节', async () => {
    const full = await fetch(`${server.base}${API}/projects/${id}/files/image`, {
      headers: { Range: 'bytes=0-' },
    });
    assert.equal(full.status, 206);
    assert.equal(full.headers.get('content-range'), `bytes 0-${pngBytes.length - 1}/${pngBytes.length}`);
    assert.equal((await full.arrayBuffer()).byteLength, pngBytes.length);

    const suffix = await fetch(`${server.base}${API}/projects/${id}/files/image`, {
      headers: { Range: 'bytes=-16' },
    });
    assert.equal(suffix.status, 206);
    const suffixBody = Buffer.from(await suffix.arrayBuffer());
    assert.ok(suffixBody.equals(pngBytes.subarray(pngBytes.length - 16)));
  });

  it('越界 Range → 416 + Content-Range: bytes */size', async () => {
    const response = await fetch(`${server.base}${API}/projects/${id}/files/image`, {
      headers: { Range: `bytes=${pngBytes.length + 100}-` },
    });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${pngBytes.length}`);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assertErrorEnvelope(await readJson(response), 'BAD_REQUEST');
  });

  it('If-None-Match 命中 ETag → 304', async () => {
    const first = await fetch(`${server.base}${API}/projects/${id}/files/image`);
    const etag = first.headers.get('etag') as string;
    assert.ok(etag);

    const cached = await fetch(`${server.base}${API}/projects/${id}/files/image`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(cached.status, 304);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);

    const weak = await fetch(`${server.base}${API}/projects/${id}/files/image`, {
      headers: { 'If-None-Match': `W/${etag}` },
    });
    assert.equal(weak.status, 304);

    const stale = await fetch(`${server.base}${API}/projects/${id}/files/image`, {
      headers: { 'If-None-Match': '"deadbeef"' },
    });
    assert.equal(stale.status, 200);
  });

  it('?download=1 → 附件下载 + 中文文件名 RFC 5987 编码', async () => {
    const response = await fetch(`${server.base}${API}/projects/${id}/files/image?download=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const disposition = response.headers.get('content-disposition') ?? '';
    assert.match(disposition, /^attachment;/);
    assert.ok(disposition.includes("filename*=UTF-8''"), '中文文件名需要 filename* 形式');
    assert.ok(disposition.includes(encodeURIComponent('深色 稿.png')), `实际：${disposition}`);
    const body = Buffer.from(await response.arrayBuffer());
    assert.ok(body.equals(pngBytes));
  });

  it('图片下发不计下载数（下载计数只由 /go 维护）', async () => {
    const before = (await getJson(server.base, `${API}/projects/${id}?count=0`)).body.item.stats.downloads;
    await fetch(`${server.base}${API}/projects/${id}/files/image?download=1`);
    await fetch(`${server.base}${API}/projects/${id}/files/image`);
    const after1 = (await getJson(server.base, `${API}/projects/${id}?count=0`)).body.item.stats.downloads;
    assert.equal(after1, before);
  });

  it('不存在的项目 → 404', async () => {
    const response = await fetch(`${server.base}${API}/projects/prj_ffffffffffff/files/image`);
    assert.equal(response.status, 404);
    assertErrorEnvelope(await readJson(response), 'NOT_FOUND');
  });
});

describe('GET /api/projects/:id/go：302 跳转 + 下载计数（契约 §3.10）', () => {
  let server: TestServer;
  let id: string;

  before(async () => {
    server = await startTestServer();
    id = (
      await uploadProjectOk(server.base, {
        image: uniquePng(111),
        title: '跳转计数测试',
        netdiskUrl: 'https://pan.quark.cn/s/go-test',
      })
    ).id;
  });

  after(async () => {
    await server.close();
  });

  it('302 + Location 指向 source.url + Cache-Control: no-store，且 downloads +1 落库', async () => {
    const before = (await getJson(server.base, `${API}/projects/${id}?count=0`)).body.item;
    assert.equal(before.stats.downloads, 0);

    const response = await fetch(`${server.base}${API}/projects/${id}/go`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://pan.quark.cn/s/go-test');
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const after1 = (await getJson(server.base, `${API}/projects/${id}?count=0`)).body.item;
    assert.equal(after1.stats.downloads, 1, 'downloads 必须 +1 并持久化');
    assert.equal(after1.stats.views, before.stats.views, '跳转不应改变浏览数');
  });

  it('再跳一次 → downloads +1（累加）；落盘可重读', async () => {
    await fetch(`${server.base}${API}/projects/${id}/go`, { redirect: 'manual' });
    const item = (await getJson(server.base, `${API}/projects/${id}?count=0`)).body.item;
    assert.equal(item.stats.downloads, 2);

    const db = JSON.parse(await fs.readFile(path.join(server.dataDir, 'db.json'), 'utf8'));
    const stored = db.projects.find((entry: any) => entry.id === id);
    assert.equal(stored.stats.downloads, 2, '计数必须落库而不是只改内存');
  });

  it('PATCH 换成其它网盘后 /go 跳到新链接', async () => {
    await patchProject(server.base, id, { netdiskUrl: 'https://mega.nz/file/abc' });
    const response = await fetch(`${server.base}${API}/projects/${id}/go`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://mega.nz/file/abc');
  });

  it('不存在的 id → 404 NOT_FOUND（且不产生跳转）', async () => {
    const response = await fetch(`${server.base}${API}/projects/prj_ffffffffffff/go`, { redirect: 'manual' });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('location'), null);
    assertErrorEnvelope(await readJson(response), 'NOT_FOUND');
  });
});

describe('v1 的 PSD 端点已移除 → 必须落到 404 JSON 信封', () => {
  let server: TestServer;
  let id: string;

  before(async () => {
    server = await startTestServer();
    id = (await uploadProjectOk(server.base, { image: uniquePng(121), title: '已移除端点测试' })).id;
  });

  after(async () => {
    await server.close();
  });

  it('GET /files/psd → 404（存在与不存在的 id 都一样）', async () => {
    for (const projectId of [id, 'prj_ffffffffffff']) {
      const { status, body } = await getJson(server.base, `${API}/projects/${projectId}/files/psd`);
      assert.equal(status, 404, `/files/psd 必须已移除`);
      assertErrorEnvelope(body, 'NOT_FOUND');
    }
  });

  it('GET /files/preview → 404', async () => {
    const { status, body } = await getJson(server.base, `${API}/projects/${id}/files/preview`);
    assert.equal(status, 404);
    assertErrorEnvelope(body, 'NOT_FOUND');
  });

  it('POST /:id/preview → 404（不再是 200/401/415）', async () => {
    const form = new FormData();
    form.append('preview', new Blob([new Uint8Array(uniquePng(122))]), '新预览.png');
    const response = await fetch(`${server.base}${API}/projects/${id}/preview`, {
      method: 'POST',
      body: form,
    });
    assert.equal(response.status, 404);
    assertErrorEnvelope(await readJson(response), 'NOT_FOUND');
  });

  it('同一路由前缀下的 /files/image 仍然正常（不是把整段路由砍掉）', async () => {
    const response = await fetch(`${server.base}${API}/projects/${id}/files/image`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
  });
});

describe('鉴权：上传令牌与管理令牌分开', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer({ UPLOAD_TOKEN: 'upload-secret', ADMIN_TOKEN: 'admin-secret' });
  });

  after(async () => {
    await server.close();
  });

  it('GET /api/config 反映令牌已启用', async () => {
    const { body } = await getJson(server.base, `${API}/config`);
    assert.equal(body.uploadTokenRequired, true);
    assert.equal(body.adminTokenRequired, true);
  });

  it('无令牌 / 错误令牌上传 → 401', async () => {
    const none = await uploadProject(server.base, { image: uniquePng(131), title: '无令牌' });
    assert.equal(none.status, 401);
    assertErrorEnvelope(none.body, 'UNAUTHORIZED');

    const wrong = await uploadProject(
      server.base,
      { image: uniquePng(132), title: '错误令牌' },
      { 'x-upload-token': 'wrong-token' },
    );
    assert.equal(wrong.status, 401);
    assertErrorEnvelope(wrong.body, 'UNAUTHORIZED');

    // 用管理令牌冒充上传令牌也不行
    const crossed = await uploadProject(
      server.base,
      { image: uniquePng(133), title: '令牌串用' },
      { 'x-admin-token': 'admin-secret' },
    );
    assert.equal(crossed.status, 401);
  });

  it('正确令牌（x-upload-token）→ 201', async () => {
    const viaHeader = await uploadProject(
      server.base,
      { image: uniquePng(134), title: '头部令牌' },
      { 'x-upload-token': 'upload-secret' },
    );
    assert.equal(viaHeader.status, 201);

    // v2.1（契约 §0.3）：Authorization 头专用于**主站登录令牌**，
    // 不再接受 Authorization: Bearer <上传令牌>；未启用主站登录时无从校验 → 401
    const viaBearer = await uploadProject(
      server.base,
      { image: uniquePng(135), title: 'Bearer 令牌' },
      { Authorization: 'Bearer upload-secret' },
    );
    assert.equal(viaBearer.status, 401);
    assertErrorEnvelope(viaBearer.body, 'UNAUTHORIZED');
  });

  it('PATCH / DELETE 需要管理令牌：无 admin 令牌 → 401', async () => {
    const id = (
      await uploadProjectOk(
        server.base,
        { image: uniquePng(136), title: '受保护项目' },
        { 'x-upload-token': 'upload-secret' },
      )
    ).id;

    const patchNoToken = await patchProject(server.base, id, { title: '越权修改' });
    assert.equal(patchNoToken.status, 401);
    assertErrorEnvelope(patchNoToken.body, 'UNAUTHORIZED');

    // 只有上传令牌也改不动（两类令牌不通用）
    const patchUploadToken = await patchProject(
      server.base,
      id,
      { title: '越权修改' },
      { 'x-upload-token': 'upload-secret' },
    );
    assert.equal(patchUploadToken.status, 401);

    const patchWithToken = await patchProject(
      server.base,
      id,
      { title: '合法修改' },
      { 'x-admin-token': 'admin-secret' },
    );
    assert.equal(patchWithToken.status, 200);
    assert.equal(patchWithToken.body.item.title, '合法修改');

    const patchViaBearer = await patchProject(
      server.base,
      id,
      { title: 'Bearer 修改' },
      { Authorization: 'Bearer admin-secret' },
    );
    assert.equal(patchViaBearer.status, 200);

    const deleteNoToken = await deleteProject(server.base, id);
    assert.equal(deleteNoToken.status, 401);
    assertErrorEnvelope(await readJson(deleteNoToken), 'UNAUTHORIZED');

    const deleteWithToken = await deleteProject(server.base, id, { 'x-admin-token': 'admin-secret' });
    assert.equal(deleteWithToken.status, 204);
  });

  it('读取类接口与 /go 不要求令牌', async () => {
    const list = await getJson(server.base, `${API}/projects`);
    assert.equal(list.status, 200);
    const tags = await getJson(server.base, `${API}/projects/tags`);
    assert.equal(tags.status, 200);

    const id = list.body.items[0].id;
    const image = await fetch(`${server.base}${API}/projects/${id}/files/image`);
    assert.equal(image.status, 200);
    const go = await fetch(`${server.base}${API}/projects/${id}/go`, { redirect: 'manual' });
    assert.equal(go.status, 302);
  });
});

describe('限流：全局', () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer({
      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMIT_MAX: '5',
      UPLOAD_RATE_LIMIT_MAX: '2',
    });
  });

  after(async () => {
    await server.close();
  });

  it('全局超限 → 429 + Retry-After', async () => {
    let limited: Response | null = null;
    for (let i = 0; i < 8; i += 1) {
      const response = await fetch(`${server.base}${API}/health`);
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    assert.ok(limited, '超过 RATE_LIMIT_MAX 后应返回 429');
    const retryAfter = limited.headers.get('retry-after');
    assert.ok(retryAfter && Number(retryAfter) >= 1, `Retry-After 必须是正整数秒，实际：${retryAfter}`);
    assertErrorEnvelope(await readJson(limited), 'RATE_LIMITED');
  });
});

describe('静态托管：SERVE_STATIC=true', () => {
  let server: TestServer;
  let staticDir: string;

  before(async () => {
    staticDir = await makeTempDir('psdhub-static-');
    await fs.mkdir(path.join(staticDir, 'assets'), { recursive: true });
    await fs.writeFile(
      path.join(staticDir, 'index.html'),
      '<!doctype html><html><head><title>PNG 展示台</title></head><body><div id="app">SPA-INDEX-MARKER</div></body></html>',
      'utf8',
    );
    await fs.writeFile(path.join(staticDir, 'assets', 'app.js'), 'console.log("app");\n', 'utf8');
    server = await startTestServer({ SERVE_STATIC: 'true', STATIC_DIR: staticDir });
  });

  after(async () => {
    await server.close();
    await fs.rm(staticDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });

  it('非 /api 的未知路径回退 index.html（SPA history 路由）', async () => {
    const response = await fetch(`${server.base}/some/spa/route`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const html = await response.text();
    assert.ok(html.includes('SPA-INDEX-MARKER'), '应返回 index.html 内容');
    assert.equal(response.headers.get('cache-control'), 'no-cache', 'index.html 不能长缓存');
  });

  it('/assets/* 长缓存且返回真实文件', async () => {
    const response = await fetch(`${server.base}/assets/app.js`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await response.text(), 'console.log("app");\n');
  });

  it('/ 返回 index.html；/api/* 未被吞掉且未匹配时返回 404 JSON', async () => {
    const root = await fetch(`${server.base}/`);
    assert.equal(root.status, 200);
    assert.ok((await root.text()).includes('SPA-INDEX-MARKER'));

    const api = await fetch(`${server.base}${API}/nope`);
    assert.equal(api.status, 404);
    assert.match(api.headers.get('content-type') ?? '', /application\/json/);
    assertErrorEnvelope(await readJson(api), 'NOT_FOUND');

    const health = await getJson(server.base, `${API}/health`);
    assert.equal(health.status, 200);

    const missingAsset = await fetch(`${server.base}/assets/nope.js`);
    assert.equal(missingAsset.status, 404);
  });
});
