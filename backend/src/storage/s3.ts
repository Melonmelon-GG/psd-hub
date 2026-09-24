/**
 * S3Storage：S3 / S3 兼容对象存储驱动。
 *
 * 依赖 @aws-sdk/client-s3，但**不写进 package.json**（默认驱动是 local，避免为本地开发
 * 引入几十 MB 依赖）。采用动态 import：未安装时抛出中文可读提示，
 * 且不影响 tsc 编译与其它驱动的运行。
 */
import fsp from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { ByteRange, FileStorage, StoredFileStat } from './types.js';

/** 模块名用变量持有：让 TS 以非字面量动态导入处理，缺包时不会导致编译失败 */
const S3_MODULE_NAME: string = '@aws-sdk/client-s3';

/** 最小化的 SDK 形态（避免依赖具体版本的复杂泛型） */
interface S3CommandLike {
  readonly __command?: string;
}
interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
  destroy?(): void;
}
interface S3SdkLike {
  S3Client: new (config: Record<string, unknown>) => S3ClientLike;
  PutObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
  GetObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
  HeadObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
  DeleteObjectsCommand: new (input: Record<string, unknown>) => S3CommandLike;
  ListObjectsV2Command: new (input: Record<string, unknown>) => S3CommandLike;
}

async function loadSdk(): Promise<S3SdkLike> {
  try {
    const mod = (await import(S3_MODULE_NAME)) as unknown as Partial<S3SdkLike>;
    if (!mod.S3Client || !mod.PutObjectCommand || !mod.GetObjectCommand) {
      throw new Error('SDK 结构不完整');
    }
    return mod as S3SdkLike;
  } catch (err) {
    throw new Error(
      `STORAGE_DRIVER=s3 需要对象存储 SDK，请先安装依赖：npm install @aws-sdk/client-s3（原始错误：${
        err instanceof Error ? err.message : String(err)
      }）`,
    );
  }
}

export interface S3StorageOptions {
  bucket: string;
  region?: string | null;
  endpoint?: string | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  forcePathStyle?: boolean;
  /** 对象 key 前缀（默认 "projects"） */
  prefix?: string;
  logger?: Logger;
}

interface HeadObjectResult {
  ContentLength?: number;
  LastModified?: Date | string;
}

interface GetObjectResult {
  Body?: unknown;
}

interface ListObjectsV2Result {
  Contents?: { Key?: string }[];
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

export class S3Storage implements FileStorage {
  readonly kind = 's3' as const;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly logger: Logger;
  private readonly options: S3StorageOptions;
  private sdk: S3SdkLike | null = null;
  private client: S3ClientLike | null = null;

  constructor(options: S3StorageOptions) {
    this.options = options;
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? 'projects';
    this.logger = options.logger ?? silentLogger;
  }

  private async ensureClient(): Promise<{ sdk: S3SdkLike; client: S3ClientLike }> {
    if (this.sdk && this.client) return { sdk: this.sdk, client: this.client };
    const sdk = await loadSdk();
    const config: Record<string, unknown> = {
      region: this.options.region ?? 'us-east-1',
      forcePathStyle: this.options.forcePathStyle ?? false,
    };
    if (this.options.endpoint) config.endpoint = this.options.endpoint;
    if (this.options.accessKeyId && this.options.secretAccessKey) {
      config.credentials = {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
      };
    }
    const client = new sdk.S3Client(config);
    this.sdk = sdk;
    this.client = client;
    this.logger.info('已连接对象存储', { bucket: this.bucket, endpoint: this.options.endpoint ?? 'default' });
    return { sdk, client };
  }

  private keyOf(relPath: string): string {
    const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    return `${this.prefix}/${normalized}`;
  }

  async ensureReady(): Promise<void> {
    if (!this.bucket) throw new Error('STORAGE_DRIVER=s3 必须配置 S3_BUCKET');
    await this.ensureClient();
  }

  async save(relPath: string, src: string | Buffer): Promise<void> {
    const { sdk, client } = await this.ensureClient();
    const body = Buffer.isBuffer(src) ? src : await fsp.readFile(src);
    await client.send(
      new sdk.PutObjectCommand({ Bucket: this.bucket, Key: this.keyOf(relPath), Body: body }),
    );
    if (typeof src === 'string') await fsp.rm(src, { force: true }).catch(() => undefined);
  }

  async stat(relPath: string): Promise<StoredFileStat | null> {
    const { sdk, client } = await this.ensureClient();
    try {
      const result = (await client.send(
        new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: this.keyOf(relPath) }),
      )) as HeadObjectResult;
      const lastModified = result.LastModified instanceof Date ? result.LastModified : new Date(result.LastModified ?? 0);
      return { size: result.ContentLength ?? 0, mtimeMs: lastModified.getTime() };
    } catch {
      return null;
    }
  }

  async createReadStream(relPath: string, range?: ByteRange): Promise<Readable> {
    const { sdk, client } = await this.ensureClient();
    const input: Record<string, unknown> = { Bucket: this.bucket, Key: this.keyOf(relPath) };
    if (range) input.Range = `bytes=${range.start}-${range.end}`;
    const result = (await client.send(new sdk.GetObjectCommand(input))) as GetObjectResult;
    return result.Body as Readable;
  }

  async exists(relPath: string): Promise<boolean> {
    return (await this.stat(relPath)) !== null;
  }

  async removeDir(prefix: string): Promise<void> {
    const { sdk, client } = await this.ensureClient();
    const keyPrefix = `${this.keyOf(prefix)}/`;
    let token: string | undefined;
    do {
      const listed = (await client.send(
        new sdk.ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: keyPrefix,
          ContinuationToken: token,
        }),
      )) as ListObjectsV2Result;
      const keys = (listed.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((key): key is string => typeof key === 'string');
      if (keys.length > 0) {
        await client.send(
          new sdk.DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }
}
