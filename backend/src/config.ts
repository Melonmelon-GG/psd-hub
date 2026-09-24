/**
 * 运行时配置：只读 process.env，带默认值 + 数值/枚举校验。
 * 校验失败会抛出中文可读的启动错误，避免"半配置"状态下带病运行。
 */
import path from 'node:path';
import type { LogLevel } from './logger.js';
import { isLogLevel } from './logger.js';

/** 服务名（GET /api/health 使用） */
export const APP_NAME = 'psd-hub-api';
/** 站点名（GET /api/config 使用） */
export const SITE_NAME = 'psd-hub';
/** 契约版本号 */
export const APP_VERSION = '2.1.0';
/** 允许的图片扩展名（大小写不敏感）；v2.0 起只接受 PNG */
export const IMAGE_EXTENSIONS: readonly string[] = ['.png'];
/** 允许的图片 MIME（契约 §3.2 acceptedImageTypes） */
export const ACCEPTED_IMAGE_TYPES: readonly string[] = ['image/png'];
/** 提取码最大长度（契约 §1.3 / §3.6） */
export const EXTRACT_CODE_MAX_LENGTH = 16;
/** 网盘链接最大长度（契约 §1.3 / §3.6） */
export const NETDISK_URL_MAX_LENGTH = 500;
/** 网盘内源文件名 / 备注的最大长度（契约 §1.3 / §3.6） */
export const SOURCE_TEXT_MAX_LENGTH = 200;
/** 作者缺省值 */
export const DEFAULT_AUTHOR = '匿名作者';
/** 主站令牌校验路径的默认值（契约 §8.3：成员专属且只读的接口） */
export const DEFAULT_MAIN_SITE_VERIFY_PATH = '/api/kb/tree';
/** 主站令牌有效期（秒），契约 §8.1 固定返回 24 小时 */
export const MAIN_SITE_TOKEN_TTL_SECONDS = 86400;

export type StorageDriver = 'local' | 's3';

export interface S3Config {
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  forcePathStyle: boolean;
  publicBaseUrl: string | null;
}

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  host: string;
  port: number;
  /** 绝对路径 */
  dataDir: string;
  /** 绝对路径（<DATA_DIR>/tmp） */
  tmpDir: string;
  publicBaseUrl: string;
  /** 原始 CORS_ORIGIN 值 */
  corsOrigin: string;
  /** '*' 或白名单数组 */
  corsOrigins: '*' | string[];
  maxUploadBytes: number;
  maxUploadLabel: string;
  uploadToken: string | null;
  adminToken: string | null;
  trustProxy: boolean | number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  uploadRateLimitMax: number;
  /** 登录/校验类端点（/api/auth/*）的独立严格限流上限（每窗口每 IP） */
  loginRateLimitMax: number;
  /**
   * 主站基址（契约 §8），例 "https://7thcv.cn"，**不带尾斜杠**；
   * 空串 = 未启用主站登录（此时上传鉴权退回 v2.0 的令牌/放开语义）。
   */
  mainSiteBaseUrl: string;
  /** 校验登录令牌用的成员专属路径（默认 /api/kb/tree） */
  mainSiteVerifyPath: string;
  /** 调用主站的超时（毫秒） */
  upstreamTimeoutMs: number;
  /**
   * 挂载前缀（契约 §8.4）："" = 挂在根；否则形如 "/psd"（必有前导斜杠、无尾斜杠）。
   */
  mountPrefix: string;
  serveStatic: boolean;
  /** 绝对路径 */
  staticDir: string;
  storageDriver: StorageDriver;
  s3: S3Config;
  logLevel: LogLevel;
}

/** 读取字符串；空串视为未设置 */
function readString(env: NodeJS.ProcessEnv, name: string, fallback = ''): string {
  const value = env[name];
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

/** 读取可空字符串（空串 → null） */
function readNullable(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = readString(env, name, '');
  return value === '' ? null : value;
}

/** 读取整数并校验区间 */
function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = readString(env, name, '');
  if (value === '') return fallback;
  if (!/^[+-]?\d+$/.test(value)) {
    throw new Error(`环境变量 ${name} 必须是整数，当前值："${value}"`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < min || parsed > max) {
    throw new Error(`环境变量 ${name} 必须在 ${min}..${max} 之间，当前值：${parsed}`);
  }
  return parsed;
}

/** 读取布尔值（true/1/yes/on） */
function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = readString(env, name, '').toLowerCase();
  if (value === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`环境变量 ${name} 必须是布尔值（true/false），当前值："${value}"`);
}

/**
 * TRUST_PROXY：false / true / 正整数（代理层数）
 * 例：1 = Nginx 一跳；false = 直接暴露，避免伪造 X-Forwarded-For 绕过限流
 */
function readTrustProxy(env: NodeJS.ProcessEnv): boolean | number {
  const value = readString(env, 'TRUST_PROXY', '0').toLowerCase();
  if (['true', 'yes', 'on'].includes(value)) return true;
  if (['false', 'no', 'off'].includes(value)) return false;
  if (!/^\d+$/.test(value)) {
    throw new Error(`环境变量 TRUST_PROXY 必须是布尔值或非负整数，当前值："${value}"`);
  }
  const hops = Number.parseInt(value, 10);
  return hops === 0 ? false : hops;
}

/**
 * MAIN_SITE_BASE_URL：主站基址。
 * 空 = 未启用登录；非空必须带 http/https 协议，尾斜杠一律去掉（拼接时我们自己补 "/"）。
 */
function readMainSiteBaseUrl(env: NodeJS.ProcessEnv): string {
  const value = readString(env, 'MAIN_SITE_BASE_URL', '');
  if (value === '') return '';
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`环境变量 MAIN_SITE_BASE_URL 必须以 http:// 或 https:// 开头，当前值："${value}"`);
  }
  return value.replace(/\/+$/, '');
}

/** MAIN_SITE_VERIFY_PATH：成员专属校验路径，默认 /api/kb/tree；保证有前导斜杠、无尾斜杠 */
function readMainSiteVerifyPath(env: NodeJS.ProcessEnv): string {
  const value = readString(env, 'MAIN_SITE_VERIFY_PATH', DEFAULT_MAIN_SITE_VERIFY_PATH);
  const withLeading = value.startsWith('/') ? value : `/${value}`;
  const trimmed = withLeading.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * MOUNT_PREFIX（契约 §8.4）："" = 挂在根；否则归一化为 "/psd" 形态
 * （补前导斜杠、去尾斜杠），并拒绝含查询串/片段/空白等会破坏前缀匹配的值。
 */
function readMountPrefix(env: NodeJS.ProcessEnv): string {
  const value = readString(env, 'MOUNT_PREFIX', '');
  if (value === '' || value === '/') return '';
  if (/[?#\s]/.test(value)) {
    throw new Error(`环境变量 MOUNT_PREFIX 不能包含空白、? 或 #，当前值："${value}"`);
  }
  const withLeading = value.startsWith('/') ? value : `/${value}`;
  return withLeading.replace(/\/+$/, '');
}

/** 人类可读体积标签，例：536870912 → "512 MB" */
export function formatBytesLabel(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

/** 读取并校验全部环境变量 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = readString(env, 'NODE_ENV', 'development');
  // v2.0 起只上传 PNG（不再是几百 MB 的 PSD），默认上限从 512MB 降到 20MB
  const maxUploadMb = readInt(env, 'MAX_UPLOAD_MB', 20, 1, 10240);
  const storageDriverRaw = readString(env, 'STORAGE_DRIVER', 'local').toLowerCase();
  if (storageDriverRaw !== 'local' && storageDriverRaw !== 's3') {
    throw new Error(`环境变量 STORAGE_DRIVER 只能是 local 或 s3，当前值："${storageDriverRaw}"`);
  }
  const logLevelRaw = readString(env, 'LOG_LEVEL', 'info').toLowerCase();
  if (!isLogLevel(logLevelRaw)) {
    throw new Error(`环境变量 LOG_LEVEL 只能是 debug/info/warn/error/silent，当前值："${logLevelRaw}"`);
  }

  const cwd = process.cwd();
  const dataDir = path.resolve(cwd, readString(env, 'DATA_DIR', './data'));
  const staticDir = path.resolve(cwd, readString(env, 'STATIC_DIR', '../frontend/dist'));
  const corsOrigin = readString(env, 'CORS_ORIGIN', '*');
  const corsOrigins: '*' | string[] =
    corsOrigin === '*'
      ? '*'
      : corsOrigin
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '');

  const maxUploadBytes = maxUploadMb * 1024 * 1024;

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    host: readString(env, 'HOST', '0.0.0.0'),
    port: readInt(env, 'PORT', 4000, 0, 65535),
    dataDir,
    tmpDir: path.join(dataDir, 'tmp'),
    publicBaseUrl: readString(env, 'PUBLIC_BASE_URL', ''),
    corsOrigin,
    corsOrigins: corsOrigins === '*' || corsOrigins.length > 0 ? corsOrigins : '*',
    maxUploadBytes,
    maxUploadLabel: formatBytesLabel(maxUploadBytes),
    uploadToken: readNullable(env, 'UPLOAD_TOKEN'),
    adminToken: readNullable(env, 'ADMIN_TOKEN'),
    trustProxy: readTrustProxy(env),
    rateLimitWindowMs: readInt(env, 'RATE_LIMIT_WINDOW_MS', 60000, 100, 3600000),
    rateLimitMax: readInt(env, 'RATE_LIMIT_MAX', 300, 1, 1000000),
    uploadRateLimitMax: readInt(env, 'UPLOAD_RATE_LIMIT_MAX', 30, 1, 1000000),
    // 登录接口容易被爆破，默认比全局限流严格得多（10 次/分钟/IP）
    loginRateLimitMax: readInt(env, 'LOGIN_RATE_LIMIT_MAX', 10, 1, 1000000),
    mainSiteBaseUrl: readMainSiteBaseUrl(env),
    mainSiteVerifyPath: readMainSiteVerifyPath(env),
    upstreamTimeoutMs: readInt(env, 'UPSTREAM_TIMEOUT_MS', 8000, 100, 120000),
    mountPrefix: readMountPrefix(env),
    serveStatic: readBool(env, 'SERVE_STATIC', false),
    staticDir,
    storageDriver: storageDriverRaw,
    s3: {
      endpoint: readNullable(env, 'S3_ENDPOINT'),
      region: readNullable(env, 'S3_REGION'),
      bucket: readNullable(env, 'S3_BUCKET'),
      accessKeyId: readNullable(env, 'S3_ACCESS_KEY_ID'),
      secretAccessKey: readNullable(env, 'S3_SECRET_ACCESS_KEY'),
      forcePathStyle: readBool(env, 'S3_FORCE_PATH_STYLE', false),
      publicBaseUrl: readNullable(env, 'S3_PUBLIC_BASE_URL'),
    },
    logLevel: logLevelRaw,
  };
}
