/**
 * JsonProjectStore 单元测试：CRUD、搜索/过滤/排序/分页、标签聚合、写队列并发一致性，
 * 以及 v2.0 的 image / source 字段在重启后的持久化。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { silentLogger } from '../src/logger.js';
import { JsonProjectStore } from '../src/store/jsonStore.js';
import type { Project } from '../src/types.js';
import { makeProject, makeTempDir } from './helpers.js';

interface StoreFixture {
  store: JsonProjectStore;
  dir: string;
  file: string;
}

async function createFixture(): Promise<StoreFixture> {
  const dir = await makeTempDir('psdhub-store-');
  const file = path.join(dir, 'db.json');
  const store = new JsonProjectStore({ file, logger: silentLogger });
  await store.init();
  return { store, dir, file };
}

async function readDb(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

describe('JsonProjectStore 基础 CRUD', () => {
  let fixture: StoreFixture;

  before(async () => {
    fixture = await createFixture();
  });

  after(async () => {
    await fs.rm(fixture.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });

  it('空库启动：count = 0，未落盘时不创建文件', async () => {
    assert.equal(await fixture.store.count(), 0);
    assert.equal(await fixture.store.find('prj_000000000000'), null);
  });

  it('create + find：字段完整并已落盘（db.json version = 2）', async () => {
    const project = makeProject('prj_000000000001', { title: '第一个项目', tags: ['UI'] });
    await fixture.store.create(project);

    const found = await fixture.store.find('prj_000000000001');
    assert.ok(found);
    assert.equal(found.title, '第一个项目');
    assert.deepEqual(found.tags, ['UI']);
    assert.equal(found.image.sha256, 'a'.repeat(64));
    assert.equal(found.source.provider, 'baidu');
    assert.equal(found.source.providerLabel, '百度网盘');

    const db = await readDb(fixture.file);
    assert.equal(db.version, 2);
    assert.equal(typeof db.updatedAt, 'string');
    assert.equal(db.projects.length, 1);
    assert.equal(db.projects[0].id, 'prj_000000000001');
    assert.equal('psd' in db.projects[0], false);
    assert.equal('preview' in db.projects[0], false);
  });

  it('find 返回副本：外部修改不影响仓库', async () => {
    const found = (await fixture.store.find('prj_000000000001')) as Project;
    found.title = '被外部改掉了';
    found.tags.push('脏数据');
    const again = await fixture.store.find('prj_000000000001');
    assert.equal(again?.title, '第一个项目');
    assert.deepEqual(again?.tags, ['UI']);
  });

  it('update：局部字段更新并刷新 updatedAt', async () => {
    const updated = await fixture.store.update('prj_000000000001', {
      title: '改后的标题',
      tags: ['UI', '科幻'],
    });
    assert.ok(updated);
    assert.equal(updated.title, '改后的标题');
    assert.deepEqual(updated.tags, ['UI', '科幻']);
    assert.equal(updated.description, '示例说明');
    assert.notEqual(updated.updatedAt, '2026-02-14T08:31:05.123Z');

    assert.equal(await fixture.store.update('prj_000000000404', { title: 'x' }), null);
  });

  it('update：整体替换 source（网盘信息）', async () => {
    const updated = await fixture.store.update('prj_000000000001', {
      source: {
        provider: 'quark',
        providerLabel: '夸克网盘',
        url: 'https://pan.quark.cn/s/xyz',
        extractCode: 'abcd',
        fileName: '源文件.psd',
        note: null,
      },
    });
    assert.ok(updated);
    assert.equal(updated.source.provider, 'quark');
    assert.equal(updated.source.providerLabel, '夸克网盘');
    assert.equal(updated.source.extractCode, 'abcd');
    assert.equal(updated.source.note, null);
    // 未提交的字段（image / title）保持不变
    assert.equal(updated.title, '改后的标题');
    assert.equal(updated.image.fileName, 'demo.png');

    // 落盘后再读，仍是新值
    const reloaded = new JsonProjectStore({ file: fixture.file, logger: silentLogger });
    await reloaded.init();
    assert.equal((await reloaded.find('prj_000000000001'))?.source.provider, 'quark');
  });

  it('incrementStats：views / downloads 累加', async () => {
    const once = await fixture.store.incrementStats('prj_000000000001', { views: 1, downloads: 2 });
    assert.equal(once?.stats.views, 1);
    assert.equal(once?.stats.downloads, 2);
    assert.equal(await fixture.store.incrementStats('prj_000000000404', { views: 1 }), null);
  });

  it('sha256Exists：按 PNG 哈希命中', async () => {
    const hash = (await fixture.store.find('prj_000000000001'))?.image.sha256 as string;
    const hit = await fixture.store.sha256Exists(hash);
    assert.equal(hit?.id, 'prj_000000000001');
    assert.equal(await fixture.store.sha256Exists('b'.repeat(64)), null);
  });

  it('remove：删除后查不到，未知 id 返回 null', async () => {
    const removed = await fixture.store.remove('prj_000000000001');
    assert.equal(removed?.id, 'prj_000000000001');
    assert.equal(await fixture.store.find('prj_000000000001'), null);
    assert.equal(await fixture.store.remove('prj_000000000001'), null);
    assert.equal(await fixture.store.count(), 0);
  });

  it('损坏的 db.json：隔离后以空库启动', async () => {
    const dir = await makeTempDir('psdhub-store-corrupt-');
    const file = path.join(dir, 'db.json');
    await fs.writeFile(file, '{ 这不是 JSON', 'utf8');
    const store = new JsonProjectStore({ file, logger: silentLogger });
    await store.init();
    assert.equal(await store.count(), 0);
    const entries = await fs.readdir(dir);
    assert.ok(entries.some((name) => name.includes('.corrupt-')), `应生成隔离文件，实际：${entries.join(',')}`);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });
});

describe('JsonProjectStore 查询能力', () => {
  let fixture: StoreFixture;

  const seed: Project[] = [
    makeProject('prj_aaaaaaaaaaa1', {
      title: 'A 封面设计',
      description: '深色科技风 Banner',
      author: '张三',
      tags: ['UI', '科幻'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      image: { ...makeProject('prj_aaaaaaaaaaa1').image, fileName: 'DarkTech.png' },
      source: {
        provider: 'baidu',
        providerLabel: '百度网盘',
        url: 'https://pan.baidu.com/s/1',
        extractCode: 'abcd',
        fileName: 'DarkTech.psd',
        note: null,
      },
      stats: { views: 10, downloads: 5 },
    }),
    makeProject('prj_aaaaaaaaaaa2', {
      title: 'B 海报',
      description: '夏季促销',
      author: '李四',
      tags: ['UI'],
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      image: { ...makeProject('prj_aaaaaaaaaaa2').image, fileName: 'SummerSale.png' },
      source: {
        provider: 'quark',
        providerLabel: '夸克网盘',
        url: 'https://pan.quark.cn/s/2',
        extractCode: null,
        fileName: null,
        note: null,
      },
      stats: { views: 30, downloads: 1 },
    }),
    makeProject('prj_aaaaaaaaaaa3', {
      title: 'C 中文稿',
      description: '国风插画',
      author: '张三',
      tags: ['UI', '海报'],
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
      image: { ...makeProject('prj_aaaaaaaaaaa3').image, fileName: 'GuoFeng.png' },
      source: {
        provider: 'aliyun',
        providerLabel: '阿里云盘',
        url: 'https://www.aliyundrive.com/s/3',
        extractCode: null,
        fileName: null,
        note: '含分层源文件',
      },
      stats: { views: 1, downloads: 9 },
    }),
    makeProject('prj_aaaaaaaaaaa4', {
      title: 'D 草图',
      description: '科幻场景探索',
      author: '王五',
      tags: ['科幻'],
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      source: {
        provider: 'other',
        providerLabel: '其它链接',
        url: 'https://example.com/share/4',
        extractCode: null,
        fileName: null,
        note: null,
      },
      stats: { views: 3, downloads: 0 },
    }),
    makeProject('prj_aaaaaaaaaaa5', {
      title: 'E 图标集',
      description: '线性图标',
      author: '匿名作者',
      tags: [],
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
      image: { ...makeProject('prj_aaaaaaaaaaa5').image, fileName: 'Icons.png' },
      source: {
        provider: 'dropbox',
        providerLabel: 'Dropbox',
        url: 'https://www.dropbox.com/s/5',
        extractCode: null,
        fileName: null,
        note: null,
      },
      stats: { views: 7, downloads: 2 },
    }),
  ];

  before(async () => {
    fixture = await createFixture();
    for (const project of seed) await fixture.store.create(project);
  });

  after(async () => {
    await fs.rm(fixture.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });

  const ids = async (query: Parameters<JsonProjectStore['list']>[0]): Promise<string[]> =>
    (await fixture.store.list(query)).items.map((item) => item.id);

  it('默认排序 newest：按 createdAt 倒序', async () => {
    assert.deepEqual(await ids({ sort: 'newest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa5',
      'prj_aaaaaaaaaaa4',
      'prj_aaaaaaaaaaa3',
      'prj_aaaaaaaaaaa2',
      'prj_aaaaaaaaaaa1',
    ]);
  });

  it('排序 oldest / title / downloads / views', async () => {
    assert.deepEqual(await ids({ sort: 'oldest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa1',
      'prj_aaaaaaaaaaa2',
      'prj_aaaaaaaaaaa3',
      'prj_aaaaaaaaaaa4',
      'prj_aaaaaaaaaaa5',
    ]);
    assert.deepEqual(await ids({ sort: 'title', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa1',
      'prj_aaaaaaaaaaa2',
      'prj_aaaaaaaaaaa3',
      'prj_aaaaaaaaaaa4',
      'prj_aaaaaaaaaaa5',
    ]);
    assert.deepEqual(await ids({ sort: 'downloads', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa3',
      'prj_aaaaaaaaaaa1',
      'prj_aaaaaaaaaaa5',
      'prj_aaaaaaaaaaa2',
      'prj_aaaaaaaaaaa4',
    ]);
    assert.deepEqual(await ids({ sort: 'views', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa2',
      'prj_aaaaaaaaaaa1',
      'prj_aaaaaaaaaaa5',
      'prj_aaaaaaaaaaa4',
      'prj_aaaaaaaaaaa3',
    ]);
  });

  it('q 模糊匹配 title / description / author / tags / image.fileName / source.fileName', async () => {
    assert.deepEqual(await ids({ q: '封面', sort: 'newest', page: 1, pageSize: 12 }), ['prj_aaaaaaaaaaa1']);
    assert.deepEqual(await ids({ q: '促销', sort: 'newest', page: 1, pageSize: 12 }), ['prj_aaaaaaaaaaa2']);
    assert.deepEqual(await ids({ q: '张三', sort: 'newest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa3',
      'prj_aaaaaaaaaaa1',
    ]);
    assert.deepEqual(await ids({ q: '科幻', sort: 'newest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa4',
      'prj_aaaaaaaaaaa1',
    ]);
    // 大小写不敏感：DARKTECH / darktech / summerSale
    assert.deepEqual(await ids({ q: 'DARKTECH', sort: 'newest', page: 1, pageSize: 12 }), ['prj_aaaaaaaaaaa1']);
    assert.deepEqual(await ids({ q: 'summersale', sort: 'newest', page: 1, pageSize: 12 }), ['prj_aaaaaaaaaaa2']);
    // 网盘里的源文件名（source.fileName）
    assert.deepEqual(await ids({ q: 'darktech.psd', sort: 'newest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa1',
    ]);
    // 备注不参与搜索，但 example.com 只出现在 source.url（也不参与）
    assert.deepEqual(await ids({ q: 'example.com', sort: 'newest', page: 1, pageSize: 12 }), []);
  });

  it('tag / author 精确匹配', async () => {
    assert.deepEqual(await ids({ tag: 'UI', sort: 'newest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa3',
      'prj_aaaaaaaaaaa2',
      'prj_aaaaaaaaaaa1',
    ]);
    assert.deepEqual(await ids({ tag: 'ui', sort: 'newest', page: 1, pageSize: 12 }), []);
    assert.deepEqual(await ids({ author: '张三', sort: 'newest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa3',
      'prj_aaaaaaaaaaa1',
    ]);
    assert.deepEqual(await ids({ author: '张', sort: 'newest', page: 1, pageSize: 12 }), []);
  });

  it('provider 按网盘类型过滤（契约 §3.3）', async () => {
    assert.deepEqual(await ids({ provider: 'baidu', sort: 'newest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa1',
    ]);
    assert.deepEqual(await ids({ provider: 'quark', sort: 'newest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa2',
    ]);
    assert.deepEqual(await ids({ provider: 'aliyun', sort: 'newest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa3',
    ]);
    assert.deepEqual(await ids({ provider: 'other', sort: 'newest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa4',
    ]);
    // 无匹配类型 → 空；provider 可与 tag 组合
    assert.deepEqual(await ids({ provider: 'mega', sort: 'newest', page: 1, pageSize: 12 }), []);
    assert.deepEqual(await ids({ provider: 'baidu', tag: '科幻', sort: 'newest', page: 1, pageSize: 12 }), [
      'prj_aaaaaaaaaaa1',
    ]);
  });

  it('分页：total / totalPages / items 正确，越界返回空', async () => {
    const first = await fixture.store.list({ sort: 'oldest', page: 1, pageSize: 2 });
    assert.equal(first.total, 5);
    assert.equal(first.page, 1);
    assert.equal(first.pageSize, 2);
    assert.equal(first.totalPages, 3);
    assert.equal(first.items.length, 2);

    const last = await fixture.store.list({ sort: 'oldest', page: 3, pageSize: 2 });
    assert.equal(last.items.length, 1);
    assert.equal(last.items[0]?.id, 'prj_aaaaaaaaaaa5');

    const beyond = await fixture.store.list({ sort: 'oldest', page: 9, pageSize: 2 });
    assert.equal(beyond.total, 5);
    assert.equal(beyond.totalPages, 3);
    assert.deepEqual(beyond.items, []);
  });

  it('allTags：按 count 降序、name 升序', async () => {
    assert.deepEqual(await fixture.store.allTags(), [
      { name: 'UI', count: 3 },
      { name: '科幻', count: 2 },
      { name: '海报', count: 1 },
    ]);
  });
});

describe('JsonProjectStore 写队列与并发', () => {
  let fixture: StoreFixture;

  before(async () => {
    fixture = await createFixture();
  });

  after(async () => {
    await fs.rm(fixture.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });

  it('并发 50 次 incrementStats 后计数精确等于 50（内存与磁盘一致）', async () => {
    await fixture.store.create(makeProject('prj_bbbbbbbbbbb1'));

    await Promise.all(
      Array.from({ length: 50 }, () => fixture.store.incrementStats('prj_bbbbbbbbbbb1', { views: 1 })),
    );
    const inMemory = await fixture.store.find('prj_bbbbbbbbbbb1');
    assert.equal(inMemory?.stats.views, 50);

    // 重新从磁盘加载，验证落盘结果同样精确
    const reloaded = new JsonProjectStore({ file: fixture.file, logger: silentLogger });
    await reloaded.init();
    const fromDisk = await reloaded.find('prj_bbbbbbbbbbb1');
    assert.equal(fromDisk?.stats.views, 50);
  });

  it('并发混合计数（views + downloads）不丢计数', async () => {
    await Promise.all([
      ...Array.from({ length: 20 }, () => fixture.store.incrementStats('prj_bbbbbbbbbbb1', { views: 2 })),
      ...Array.from({ length: 10 }, () => fixture.store.incrementStats('prj_bbbbbbbbbbb1', { downloads: 3 })),
    ]);
    const project = await fixture.store.find('prj_bbbbbbbbbbb1');
    assert.equal(project?.stats.views, 50 + 40);
    assert.equal(project?.stats.downloads, 30);
  });

  it('并发 create 30 个项目后 db.json 仍是合法 JSON 且数量正确', async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_value, index) =>
        fixture.store.create(makeProject(`prj_cccccccccc${String(index).padStart(2, '0')}`)),
      ),
    );
    const db = await readDb(fixture.file);
    assert.equal(db.version, 2);
    assert.equal(db.projects.length, 31);
    assert.equal(new Set(db.projects.map((item: Project) => item.id)).size, 31);
    assert.equal(await fixture.store.count(), 31);
  });

  it('并发 create + remove 交错后数据自洽', async () => {
    await Promise.all([
      fixture.store.remove('prj_cccccccccc00'),
      fixture.store.remove('prj_cccccccccc01'),
      fixture.store.create(makeProject('prj_ddddddddddd1')),
      fixture.store.incrementStats('prj_ddddddddddd1', { views: 5 }),
    ]);
    const removed = await fixture.store.find('prj_cccccccccc00');
    assert.equal(removed, null);
    const created = await fixture.store.find('prj_ddddddddddd1');
    // create 与 incrementStats 顺序不定，views 只能是 0 或 5，但绝不能是中间态脏值
    assert.ok(created);
    assert.ok(created.stats.views === 0 || created.stats.views === 5);

    const reloaded = new JsonProjectStore({ file: fixture.file, logger: silentLogger });
    await reloaded.init();
    assert.equal(await reloaded.count(), await fixture.store.count());
  });
});

// ---------------------------------------------------------------------------
// v2.0：image / source 的重启持久化 + provider 自洽校验
// normalizeProject 是"从 db.json 重建 Project"的唯一入口，漏字段会让新字段
// 在新上传（进程未重启）时可见、重启后静默消失——这里正反两面都钉住。
// ---------------------------------------------------------------------------

describe('JsonProjectStore：v2.0 image / source 的重启持久化', () => {
  let dir: string;
  let file: string;

  before(async () => {
    dir = await makeTempDir('psdhub-store-v2meta-');
    file = path.join(dir, 'db.json');
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });

  it('重启后 image 的全部字段（含 width/height/两个 URL）仍在', async () => {
    const store = new JsonProjectStore({ file, logger: silentLogger });
    await store.init();
    await store.create(
      makeProject('prj_eeeeeeeeeee1', {
        image: {
          fileName: '中文图 稿.png',
          size: 12345,
          sha256: 'c'.repeat(64),
          width: 1920,
          height: 1080,
          url: '/api/projects/prj_eeeeeeeeeee1/files/image',
          downloadUrl: '/api/projects/prj_eeeeeeeeeee1/files/image?download=1',
        },
      }),
    );

    const reloaded = new JsonProjectStore({ file, logger: silentLogger });
    await reloaded.init();
    const fromDisk = await reloaded.find('prj_eeeeeeeeeee1');
    assert.ok(fromDisk);
    assert.deepEqual(fromDisk.image, {
      fileName: '中文图 稿.png',
      size: 12345,
      sha256: 'c'.repeat(64),
      width: 1920,
      height: 1080,
      url: '/api/projects/prj_eeeeeeeeeee1/files/image',
      downloadUrl: '/api/projects/prj_eeeeeeeeeee1/files/image?download=1',
    });
  });

  it('重启后 source 的中文 providerLabel / 提取码 / 可空字段原样保留', async () => {
    const store = new JsonProjectStore({ file, logger: silentLogger });
    await store.init();
    await store.create(
      makeProject('prj_eeeeeeeeeee2', {
        source: {
          provider: '123pan',
          providerLabel: '123 云盘',
          url: 'https://www.123pan.com/s/abcdef',
          extractCode: 'abcd',
          fileName: '源文件 稿.psd',
          note: null,
        },
      }),
    );

    const reloaded = new JsonProjectStore({ file, logger: silentLogger });
    await reloaded.init();
    const fromDisk = await reloaded.find('prj_eeeeeeeeeee2');
    assert.ok(fromDisk);
    assert.equal(fromDisk.source.provider, '123pan');
    assert.equal(fromDisk.source.providerLabel, '123 云盘');
    assert.equal(fromDisk.source.extractCode, 'abcd');
    assert.equal(fromDisk.source.fileName, '源文件 稿.psd');
    assert.equal(fromDisk.source.note, null, 'null 不能被当成"缺字段"而变成别的值');
  });

  it('provider 与 url 不一致时以 url 为准重算（服务端才是识别权威）', async () => {
    const legacyFile = path.join(dir, 'recompute.json');
    const base = makeProject('prj_fffffffffff2');
    await fs.writeFile(
      legacyFile,
      JSON.stringify({
        version: 2,
        updatedAt: new Date().toISOString(),
        projects: [
          {
            ...base,
            source: {
              provider: 'baidu',
              providerLabel: '百度网盘',
              url: 'https://pan.quark.cn/s/whatever',
              extractCode: null,
              fileName: null,
              note: null,
            },
          },
        ],
      }),
      'utf8',
    );

    const store = new JsonProjectStore({ file: legacyFile, logger: silentLogger });
    await store.init();
    const found = await store.find('prj_fffffffffff2');
    assert.ok(found);
    assert.equal(found.source.provider, 'quark');
    assert.equal(found.source.providerLabel, '夸克网盘');
  });

  it('v1 老记录（只有 psd/preview）被跳过，不崩不猜', async () => {
    const legacyFile = path.join(dir, 'legacy-v1.json');
    const base = makeProject('prj_fffffffffff1');
    // 造一条 v1 时期的记录：没有 image / source，只有 psd / preview
    const withoutV2 = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    delete withoutV2.image;
    delete withoutV2.source;
    await fs.writeFile(
      legacyFile,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        projects: [
          {
            ...withoutV2,
            psd: { fileName: 'old.psd', size: 10, sha256: 'd'.repeat(64) },
            preview: null,
          },
        ],
      }),
      'utf8',
    );

    const store = new JsonProjectStore({ file: legacyFile, logger: silentLogger });
    await store.init();
    assert.equal(await store.count(), 0, 'v1 记录缺少必填的 image/source，只能跳过');
    assert.equal(await store.find('prj_fffffffffff1'), null);

    // 脏值（image 不是对象 / source 缺 url）同样跳过
    const dirtyFile = path.join(dir, 'dirty-v2.json');
    await fs.writeFile(
      dirtyFile,
      JSON.stringify({
        version: 2,
        updatedAt: new Date().toISOString(),
        projects: [
          { ...base, id: 'prj_fffffffffff3', image: 'not-an-object' },
          { ...base, id: 'prj_fffffffffff4', source: { provider: 'baidu' } },
        ],
      }),
      'utf8',
    );
    const dirtyStore = new JsonProjectStore({ file: dirtyFile, logger: silentLogger });
    await dirtyStore.init();
    assert.equal(await dirtyStore.count(), 0);
  });

  it('可空文本字段的脏值（空串 / 非字符串）收敛为 null', async () => {
    const dirtyFile = path.join(dir, 'nullable.json');
    const base = makeProject('prj_fffffffffff5');
    await fs.writeFile(
      dirtyFile,
      JSON.stringify({
        version: 2,
        updatedAt: new Date().toISOString(),
        projects: [
          {
            ...base,
            source: {
              provider: 'baidu',
              providerLabel: '百度网盘',
              url: 'https://pan.baidu.com/s/1',
              extractCode: '   ',
              fileName: 42,
              note: '',
            },
            stats: { views: -3, downloads: 'many' },
          },
        ],
      }),
      'utf8',
    );

    const store = new JsonProjectStore({ file: dirtyFile, logger: silentLogger });
    await store.init();
    const found = await store.find('prj_fffffffffff5');
    assert.ok(found);
    assert.equal(found.source.extractCode, null);
    assert.equal(found.source.fileName, null);
    assert.equal(found.source.note, null);
    assert.deepEqual(found.stats, { views: 0, downloads: 0 });
  });
});
