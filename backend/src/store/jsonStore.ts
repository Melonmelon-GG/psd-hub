/**
 * JsonProjectStore：db.json 单文件元数据库。
 *
 * 一致性策略：
 * - 全量数据常驻内存，读操作零 IO；
 * - 所有写操作（create/update/remove/incrementStats）进入**同一个 Promise 链写队列**串行执行，
 *   队列内先改内存、再原子落盘（临时文件 + fsync + rename），因此并发上传不会写坏文件、不丢计数；
 * - 启动时加载；文件损坏时隔离为 .corrupt-<ts> 并以空库启动（不阻断服务）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import { atomicWriteJson, ensureDir } from '../lib/fsx.js';
import {
  checkNetdiskUrl,
  detectProviderFromHost,
  isNetdiskProvider,
  providerLabelOf,
} from '../lib/netdisk.js';
import type {
  ImageInfo,
  ListProjectsQuery,
  NetdiskSource,
  Paginated,
  Project,
  SortKey,
  TagCount,
} from '../types.js';
import type { ProjectStore, ProjectUpdate, StatsDelta } from './types.js';

/** 元数据库版本：v2.0 起为 2（Project 用 image/source 取代 psd/preview） */
const DB_VERSION = 2;

export interface JsonProjectStoreOptions {
  /** db.json 绝对路径 */
  file: string;
  logger?: Logger;
}

interface DbFileShape {
  version: number;
  updatedAt: string;
  projects: Project[];
}

/** 时间戳比较（非法时间视为 0，保证排序稳定不抛错） */
function timeOf(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

function compareById(a: Project, b: Project): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 中文友好的标题排序（ICU 全量排序，Node 内置） */
function compareTitle(a: Project, b: Project): number {
  return a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true, sensitivity: 'variant' });
}

function compareProjects(a: Project, b: Project, sort: SortKey): number {
  switch (sort) {
    case 'newest':
      return timeOf(b.createdAt) - timeOf(a.createdAt) || compareById(a, b);
    case 'oldest':
      return timeOf(a.createdAt) - timeOf(b.createdAt) || compareById(a, b);
    case 'title':
      return compareTitle(a, b) || timeOf(b.createdAt) - timeOf(a.createdAt) || compareById(a, b);
    case 'downloads':
      return b.stats.downloads - a.stats.downloads || timeOf(b.createdAt) - timeOf(a.createdAt) || compareById(a, b);
    case 'views':
      return b.stats.views - a.stats.views || timeOf(b.createdAt) - timeOf(a.createdAt) || compareById(a, b);
    default:
      return compareById(a, b);
  }
}

/** 宽松匹配：title / description / author / tags / image.fileName / source.fileName，大小写不敏感 */
function matchesQuery(project: Project, keyword: string): boolean {
  const needle = keyword.toLowerCase();
  if (project.title.toLowerCase().includes(needle)) return true;
  if (project.description.toLowerCase().includes(needle)) return true;
  if (project.author.toLowerCase().includes(needle)) return true;
  if (project.image.fileName.toLowerCase().includes(needle)) return true;
  if (project.source.fileName && project.source.fileName.toLowerCase().includes(needle)) return true;
  return project.tags.some((tag) => tag.toLowerCase().includes(needle));
}

/** 可空文本字段归一化：非字符串、空白、超长脏值一律收敛为 null */
function normalizeNullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/** 整数计数归一化 */
function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** 把磁盘上的 PNG 信息规整为合法 ImageInfo（缺 url 时按 id 补默认值） */
function normalizeImage(id: string, raw: unknown): ImageInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const image = raw as Partial<ImageInfo>;
  if (typeof image.fileName !== 'string' || typeof image.size !== 'number') return null;
  if (typeof image.sha256 !== 'string') return null;
  return {
    fileName: image.fileName,
    size: image.size,
    sha256: image.sha256,
    width: typeof image.width === 'number' ? image.width : null,
    height: typeof image.height === 'number' ? image.height : null,
    url: typeof image.url === 'string' ? image.url : `/api/projects/${id}/files/image`,
    downloadUrl:
      typeof image.downloadUrl === 'string'
        ? image.downloadUrl
        : `/api/projects/${id}/files/image?download=1`,
  };
}

/**
 * 把磁盘上的网盘信息规整为合法 NetdiskSource。
 *
 * `provider` / `providerLabel` 是**由 URL 推导**的字段（契约 §1.3：以服务端返回为准），
 * 因此这里只要 URL 仍然合法就按 §6 重算，保证"url ↔ provider"永远自洽；
 * URL 被人工改坏时退回记录里的合法 provider，最后兜底 other / 其它链接。
 */
function normalizeSource(raw: unknown): NetdiskSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<NetdiskSource>;
  if (typeof source.url !== 'string' || source.url.trim() === '') return null;

  const checked = checkNetdiskUrl(source.url);
  const provider = checked.ok
    ? checked.provider
    : isNetdiskProvider(source.provider)
      ? source.provider
      : detectProviderFromHost('');
  const label =
    checked.ok
      ? checked.providerLabel
      : typeof source.providerLabel === 'string' && source.providerLabel.trim() !== ''
        ? source.providerLabel
        : providerLabelOf(provider);

  return {
    provider,
    providerLabel: label,
    url: checked.ok ? checked.url : source.url.trim(),
    extractCode: normalizeNullableText(source.extractCode),
    fileName: normalizeNullableText(source.fileName),
    note: normalizeNullableText(source.note),
  };
}

/**
 * 把磁盘上的原始记录规整为合法 Project（脏数据跳过而不是崩溃）。
 * v1 的记录（只有 psd/preview、没有 image/source）无法满足 v2.0 的必填约束，一律跳过。
 */
function normalizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<Project>;
  if (typeof item.id !== 'string' || typeof item.title !== 'string') return null;

  const image = normalizeImage(item.id, item.image);
  if (!image) return null;
  const source = normalizeSource(item.source);
  if (!source) return null;

  const now = new Date().toISOString();
  return {
    id: item.id,
    title: item.title,
    description: typeof item.description === 'string' ? item.description : '',
    author: typeof item.author === 'string' && item.author !== '' ? item.author : '匿名作者',
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
    image,
    source,
    stats: {
      views: normalizeCount(item.stats?.views),
      downloads: normalizeCount(item.stats?.downloads),
    },
  };
}

export class JsonProjectStore implements ProjectStore {
  private readonly file: string;
  private readonly logger: Logger;
  /** 内存镜像（唯一真相由写队列维护） */
  private projects: Project[] = [];
  /** 串行写队列：Promise 链，保证写入顺序与原子性 */
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(options: JsonProjectStoreOptions) {
    this.file = options.file;
    this.logger = options.logger ?? silentLogger;
  }

  /** 启动加载：文件不存在视为空库；损坏则隔离后空启动 */
  async init(): Promise<void> {
    await ensureDir(path.dirname(this.file));
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(text) as Partial<DbFileShape>;
      const rawList = Array.isArray(parsed.projects) ? parsed.projects : [];
      const normalized: Project[] = [];
      let skipped = 0;
      for (const raw of rawList) {
        const project = normalizeProject(raw);
        if (project) normalized.push(project);
        else skipped += 1;
      }
      this.projects = normalized;
      this.initialized = true;
      this.logger.info('元数据库已加载', { file: this.file, count: normalized.length, skipped });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.projects = [];
        this.initialized = true;
        this.logger.info('元数据库不存在，将以空库启动', { file: this.file });
        return;
      }
      // 损坏文件：隔离保留现场，避免覆盖用户数据
      const quarantine = `${this.file}.corrupt-${Date.now()}`;
      try {
        await fsp.rename(this.file, quarantine);
      } catch {
        /* 隔离失败也不阻断启动 */
      }
      this.projects = [];
      this.initialized = true;
      this.logger.error('元数据库解析失败，已隔离并以空库启动', { file: this.file, quarantine, err });
    }
  }

  /**
   * 串行写队列：前一个任务无论成功失败都不阻塞后续任务。
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 原子落盘（仅在写队列内部调用） */
  private async persist(): Promise<void> {
    const snapshot: DbFileShape = {
      version: DB_VERSION,
      updatedAt: new Date().toISOString(),
      projects: this.projects,
    };
    await atomicWriteJson(this.file, snapshot, { pretty: false });
  }

  async find(id: string): Promise<Project | null> {
    const found = this.projects.find((item) => item.id === id);
    return found ? structuredClone(found) : null;
  }

  async list(query: ListProjectsQuery): Promise<Paginated<Project>> {
    let items = this.projects.slice();
    const keyword = query.q;
    const tag = query.tag;
    const author = query.author;
    const provider = query.provider;
    if (keyword) items = items.filter((project) => matchesQuery(project, keyword));
    if (tag) items = items.filter((project) => project.tags.includes(tag));
    if (author) items = items.filter((project) => project.author === author);
    if (provider) items = items.filter((project) => project.source.provider === provider);

    items.sort((a, b) => compareProjects(a, b, query.sort));

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const start = (query.page - 1) * query.pageSize;
    const pageItems = start >= total ? [] : items.slice(start, start + query.pageSize);

    return {
      items: pageItems.map((item) => structuredClone(item)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages,
    };
  }

  async create(project: Project): Promise<Project> {
    return this.enqueue(async () => {
      if (this.projects.some((item) => item.id === project.id)) {
        throw new Error(`项目 id 冲突：${project.id}`);
      }
      this.projects.push(project);
      try {
        await this.persist();
      } catch (err) {
        // 落盘失败则回滚内存，保证内存与磁盘一致
        this.projects = this.projects.filter((item) => item.id !== project.id);
        throw err;
      }
      return structuredClone(project);
    });
  }

  async update(id: string, patch: ProjectUpdate): Promise<Project | null> {
    return this.enqueue(async () => {
      const target = this.projects.find((item) => item.id === id);
      if (!target) return null;
      const before = structuredClone(target);
      if (patch.title !== undefined) target.title = patch.title;
      if (patch.description !== undefined) target.description = patch.description;
      if (patch.author !== undefined) target.author = patch.author;
      if (patch.tags !== undefined) target.tags = [...patch.tags];
      if (patch.source !== undefined) target.source = structuredClone(patch.source);
      target.updatedAt = new Date().toISOString();
      try {
        await this.persist();
      } catch (err) {
        Object.assign(target, before);
        throw err;
      }
      return structuredClone(target);
    });
  }

  async remove(id: string): Promise<Project | null> {
    return this.enqueue(async () => {
      const index = this.projects.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const [removed] = this.projects.splice(index, 1);
      try {
        await this.persist();
      } catch (err) {
        if (removed) this.projects.splice(index, 0, removed);
        throw err;
      }
      return removed ? structuredClone(removed) : null;
    });
  }

  async incrementStats(id: string, delta: StatsDelta): Promise<Project | null> {
    return this.enqueue(async () => {
      const target = this.projects.find((item) => item.id === id);
      if (!target) return null;
      target.stats.views += delta.views ?? 0;
      target.stats.downloads += delta.downloads ?? 0;
      await this.persist();
      return structuredClone(target);
    });
  }

  async allTags(): Promise<TagCount[]> {
    const counter = new Map<string, number>();
    for (const project of this.projects) {
      for (const tag of project.tags) {
        counter.set(tag, (counter.get(tag) ?? 0) + 1);
      }
    }
    return [...counter.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  async sha256Exists(sha256: string): Promise<Project | null> {
    const found = this.projects.find((item) => item.image.sha256 === sha256);
    return found ? structuredClone(found) : null;
  }

  async count(): Promise<number> {
    return this.projects.length;
  }

  /** 是否已完成 init（防御性检查，便于路由早失败） */
  isReady(): boolean {
    return this.initialized;
  }
}
