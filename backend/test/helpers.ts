/**
 * 测试公共设施：临时 DATA_DIR + 随机端口 HTTP 服务 + PNG 合成夹具 + multipart 表单构造。
 * 每个测试用例都使用独立的临时目录，测完删除，互不干扰。
 *
 * v2.0：上传只需一张 PNG（image 字段）+ 网盘链接（netdiskUrl）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { ensureDir } from '../src/lib/fsx.js';
import { createLogger } from '../src/logger.js';
import { JsonProjectStore } from '../src/store/jsonStore.js';
import { createStorage } from '../src/storage/index.js';
import type { ImageInfo, NetdiskSource, Project, ProjectStats } from '../src/types.js';

/** 所有会被 loadConfig 读取的环境变量：测试前后都要精确还原 */
const CONFIG_ENV_KEYS = [
  'NODE_ENV',
  'HOST',
  'PORT',
  'DATA_DIR',
  'PUBLIC_BASE_URL',
  'CORS_ORIGIN',
  'MAX_UPLOAD_MB',
  'UPLOAD_TOKEN',
  'ADMIN_TOKEN',
  'TRUST_PROXY',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX',
  'UPLOAD_RATE_LIMIT_MAX',
  'LOGIN_RATE_LIMIT_MAX',
  'MAIN_SITE_BASE_URL',
  'MAIN_SITE_VERIFY_PATH',
  'UPSTREAM_TIMEOUT_MS',
  'MOUNT_PREFIX',
  'SERVE_STATIC',
  'STATIC_DIR',
  'STORAGE_DRIVER',
  'LOG_LEVEL',
];

const TEST_ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '0',
  PUBLIC_BASE_URL: '',
  CORS_ORIGIN: '*',
  // 与产品默认值保持一致（v2.0 起 20MB），需要验证 413 的用例自行覆盖
  MAX_UPLOAD_MB: '20',
  UPLOAD_TOKEN: '',
  ADMIN_TOKEN: '',
  TRUST_PROXY: '0',
  RATE_LIMIT_WINDOW_MS: '60000',
  // 默认把限流阈值调大，避免干扰功能测试；限流专项测试自行覆盖
  RATE_LIMIT_MAX: '100000',
  UPLOAD_RATE_LIMIT_MAX: '100000',
  // 登录限流默认同样放开，限流专项测试（test/auth.test.ts）自行覆盖
  LOGIN_RATE_LIMIT_MAX: '100000',
  // 默认不启用主站登录（与 v2.0 行为一致）：需要登录的用例自行指向本地假主站
  MAIN_SITE_BASE_URL: '',
  MAIN_SITE_VERIFY_PATH: '/api/kb/tree',
  UPSTREAM_TIMEOUT_MS: '8000',
  MOUNT_PREFIX: '',
  SERVE_STATIC: 'false',
  STATIC_DIR: '',
  STORAGE_DRIVER: 'local',
  LOG_LEVEL: 'silent',
};

/** 默认网盘链接（百度网盘，便于断言 provider = baidu） */
export const DEFAULT_NETDISK_URL = 'https://pan.baidu.com/s/1abcdef';

export async function makeTempDir(prefix = 'psdhub-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export interface TestServer {
  base: string;
  ctx: AppContext;
  dataDir: string;
  close(): Promise<void>;
}

/**
 * 启动一个真实 HTTP 服务（随机端口），环境变量在启动期间被改写，close() 时还原。
 */
export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dataDir = await makeTempDir();
  const saved = new Map<string, string | undefined>();
  for (const key of CONFIG_ENV_KEYS) saved.set(key, process.env[key]);

  const restore = (): void => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  let server: Server | null = null;
  try {
    const merged = { ...TEST_ENV_DEFAULTS, DATA_DIR: dataDir, ...env };
    for (const [key, value] of Object.entries(merged)) process.env[key] = value;

    const config = loadConfig();
    if (config.dataDir !== dataDir) {
      throw new Error(`测试环境变量未生效：DATA_DIR=${config.dataDir}`);
    }
    await ensureDir(config.dataDir);
    await ensureDir(config.tmpDir);

    const logger = createLogger({ level: config.logLevel });
    const store = new JsonProjectStore({ file: path.join(config.dataDir, 'db.json'), logger });
    await store.init();
    const storage = createStorage(config, logger);
    await storage.ensureReady();

    const ctx: AppContext = { config, store, storage, logger, startedAt: Date.now() };
    const app = createApp(ctx);
    server = await new Promise<Server>((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1');
      instance.once('listening', () => resolve(instance));
      instance.once('error', reject);
    });

    const address = server.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${address.port}`,
      ctx,
      dataDir,
      close: async () => {
        const current = server;
        server = null;
        if (current) {
          current.closeAllConnections();
          await new Promise<void>((resolve) => current.close(() => resolve()));
        }
        restore();
        await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
      },
    };
  } catch (err) {
    if (server) {
      const current = server as Server;
      current.closeAllConnections();
      await new Promise<void>((resolve) => current.close(() => resolve()));
    }
    restore();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/** 启动服务 → 执行回调 → 必定关闭 */
export async function withServer(
  env: Record<string, string>,
  fn: (server: TestServer) => Promise<void>,
): Promise<void> {
  const server = await startTestServer(env);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// 文件夹具
// ---------------------------------------------------------------------------

export interface PsdFixtureOptions {
  width?: number;
  height?: number;
  colorMode?: number;
  bitsPerChannel?: number;
  channels?: number;
  version?: number;
  signature?: string;
  /** 覆盖保留字节（默认全 0） */
  reserved?: Buffer;
  /** 头部之后的填充字节，模拟真实文件体积 */
  padding?: number;
}

/**
 * 合成一个 26 字节头合法的 PSD/PSB 缓冲区（可指定错误签名/保留字节做反例）。
 *
 * v2.0 起生产路径不再接受 PSD，本夹具**仅供 test/psdHeader.test.ts** 守护遗留模块用。
 */
export function buildPsdBuffer(options: PsdFixtureOptions = {}): Buffer {
  const padding = options.padding ?? 486;
  const buffer = Buffer.alloc(26 + padding);
  buffer.write(options.signature ?? '8BPS', 0, 'latin1');
  buffer.writeUInt16BE(options.version ?? 1, 4);
  if (options.reserved) options.reserved.copy(buffer, 6, 0, 6);
  buffer.writeUInt16BE(options.channels ?? 4, 12);
  buffer.writeUInt32BE(options.height ?? 1080, 14);
  buffer.writeUInt32BE(options.width ?? 1920, 18);
  buffer.writeUInt16BE(options.bitsPerChannel ?? 8, 22);
  buffer.writeUInt16BE(options.colorMode ?? 3, 24);
  return buffer;
}

export interface PngFixtureOptions {
  /**
   * 像素填充字节：用来让同尺寸的 PNG 拥有**不同的 sha256**，
   * 便于在一个测试服务里连续上传多张互不重复的图（否则会命中 409 去重）。
   */
  seed?: number;
  /** 在 IEND 之后追加的填充字节数（用于制造"体积超限"用例） */
  padAfterEnd?: number;
}

/** 生成结构完整（CRC 正确）的真 PNG：RGBA 图 */
export function buildPngBuffer(width = 2, height = 3, options: PngFixtureOptions = {}): Buffer {
  const seed = options.seed ?? 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height, seed % 256);
  const idat = deflateSync(raw);

  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };

  const body = Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  if (!options.padAfterEnd) return body;
  return Buffer.concat([body, Buffer.alloc(options.padAfterEnd, 0)]);
}

/** 生成一张 sha256 唯一的小 PNG（同尺寸、不同像素填充） */
export function uniquePng(seed: number, width = 8, height = 6): Buffer {
  return buildPngBuffer(width, height, { seed });
}

// ---------------------------------------------------------------------------
// multipart 表单
// ---------------------------------------------------------------------------

export interface UploadFormOptions {
  /** null / 省略则不带文件字段（用于"缺少 image"用例） */
  image?: Buffer | null;
  imageName?: string;
  /** null 表示不发送 netdiskUrl 字段；缺省为 DEFAULT_NETDISK_URL */
  netdiskUrl?: string | null;
  /** null = 不发送 title 字段 */
  title?: string | null;
  description?: string;
  author?: string;
  /** 数组 = 同名字段重复出现；字符串 = 单字段 */
  tags?: string | string[];
  extractCode?: string;
  sourceFileName?: string;
  sourceNote?: string;
  allowDuplicate?: string;
  extraFields?: Record<string, string>;
  /** 额外的原生文件 part（例如验证已移除的 psd 字段会被拒绝） */
  extraFiles?: Array<{ field: string; fileName: string; data: Buffer }>;
}

/** 构造上传用的 multipart 表单 */
export function buildUploadForm(options: UploadFormOptions = {}): FormData {
  const form = new FormData();
  if (options.image !== null) {
    const image = options.image ?? buildPngBuffer(64, 32);
    form.append('image', new Blob([new Uint8Array(image)]), options.imageName ?? '深色UI稿.png');
  }

  for (const file of options.extraFiles ?? []) {
    form.append(file.field, new Blob([new Uint8Array(file.data)]), file.fileName);
  }

  if (options.netdiskUrl !== null) form.append('netdiskUrl', options.netdiskUrl ?? DEFAULT_NETDISK_URL);
  if (options.title !== null) form.append('title', options.title ?? '默认标题');
  if (options.description !== undefined) form.append('description', options.description);
  if (options.author !== undefined) form.append('author', options.author);

  if (typeof options.tags === 'string') form.append('tags', options.tags);
  else if (Array.isArray(options.tags)) for (const tag of options.tags) form.append('tags', tag);

  if (options.extractCode !== undefined) form.append('extractCode', options.extractCode);
  if (options.sourceFileName !== undefined) form.append('sourceFileName', options.sourceFileName);
  if (options.sourceNote !== undefined) form.append('sourceNote', options.sourceNote);
  if (options.allowDuplicate !== undefined) form.append('allowDuplicate', options.allowDuplicate);
  for (const [key, value] of Object.entries(options.extraFields ?? {})) form.append(key, value);
  return form;
}

export interface UploadResult {
  status: number;
  body: any;
  item: Project | null;
  response: Response;
}

/** 上传一个项目并返回结果（不校验状态码，便于测试失败分支） */
export async function uploadProject(
  base: string,
  options: UploadFormOptions = {},
  headers: Record<string, string> = {},
): Promise<UploadResult> {
  const response = await fetch(`${base}/api/projects`, {
    method: 'POST',
    body: buildUploadForm(options),
    headers,
  });
  const body = await readJson(response);
  return {
    status: response.status,
    body,
    item: body?.item ?? null,
    response,
  };
}

/** 上传并断言成功 */
export async function uploadProjectOk(
  base: string,
  options: UploadFormOptions = {},
  headers: Record<string, string> = {},
): Promise<Project> {
  const result = await uploadProject(base, options, headers);
  if (result.status !== 201) {
    throw new Error(`上传失败：status=${result.status} body=${JSON.stringify(result.body)}`);
  }
  return result.item as Project;
}

/** 安全读取 JSON（非 JSON 响应返回文本） */
export async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** GET 并解析 JSON */
export async function getJson(base: string, pathname: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; response: Response }> {
  const response = await fetch(`${base}${pathname}`, { headers });
  const body = await readJson(response);
  return { status: response.status, body, response };
}

/** PATCH JSON */
export async function patchProject(
  base: string,
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; response: Response }> {
  const response = await fetch(`${base}/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await readJson(response), response };
}

export async function deleteProject(
  base: string,
  id: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/api/projects/${id}`, { method: 'DELETE', headers });
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

/** 断言是契约规定的错误信封，返回 error 对象 */
export function assertErrorEnvelope(body: any, code: string): any {
  if (!body || typeof body !== 'object' || !body.error) {
    throw new Error(`响应不是错误信封：${JSON.stringify(body)}`);
  }
  if (body.error.code !== code) {
    throw new Error(`错误码不匹配：期望 ${code}，实际 ${body.error.code}（${body.error.message}）`);
  }
  if (typeof body.error.message !== 'string' || body.error.message.length === 0) {
    throw new Error('错误信封缺少 message');
  }
  return body.error;
}

/** 列目录（用于断言 tmp 目录已清空） */
export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 数据仓库测试用的项目构造
// ---------------------------------------------------------------------------

export function makeImageInfo(id: string, overrides: Partial<ImageInfo> = {}): ImageInfo {
  return {
    fileName: 'demo.png',
    size: 2048,
    sha256: 'a'.repeat(64),
    width: 100,
    height: 200,
    url: `/api/projects/${id}/files/image`,
    downloadUrl: `/api/projects/${id}/files/image?download=1`,
    ...overrides,
  };
}

export function makeNetdiskSource(overrides: Partial<NetdiskSource> = {}): NetdiskSource {
  return {
    provider: 'baidu',
    providerLabel: '百度网盘',
    url: DEFAULT_NETDISK_URL,
    extractCode: null,
    fileName: null,
    note: null,
    ...overrides,
  };
}

export function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  const base = new Date('2026-02-14T08:31:05.123Z').toISOString();
  const stats: ProjectStats = overrides.stats ?? { views: 0, downloads: 0 };
  return {
    id,
    title: '示例项目',
    description: '示例说明',
    author: '匿名作者',
    tags: [],
    createdAt: base,
    updatedAt: base,
    image: makeImageInfo(id),
    source: makeNetdiskSource(),
    ...overrides,
    stats,
  };
}
