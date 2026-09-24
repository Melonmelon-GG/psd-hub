/**
 * 内存滑动窗口限流（零依赖）。
 * - 每个 key（默认客户端 IP）保留窗口内的命中时间戳数组；
 * - 超限返回 429 + Retry-After（秒），错误信封由统一错误中间件生成；
 * - 定期清理过期 key，避免长期运行内存泄漏。
 */
import type { Request, RequestHandler } from 'express';
import { rateLimited } from '../lib/errors.js';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** 用于日志与响应头标识 */
  name?: string;
  /** 自定义 key 提取（默认 req.ip） */
  keyGenerator?: (req: Request) => string;
}

/** 每处理多少次请求做一次全量清扫 */
const SWEEP_INTERVAL = 512;
/** Map 体积超过该值时立即清扫 */
const MAX_TRACKED_KEYS = 5000;

function defaultKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const { windowMs, max } = options;
  const keyGenerator = options.keyGenerator ?? defaultKey;
  const buckets = new Map<string, number[]>();
  let counter = 0;

  const sweep = (now: number): void => {
    const threshold = now - windowMs;
    for (const [key, hits] of buckets) {
      const alive = hits.filter((ts) => ts > threshold);
      if (alive.length === 0) buckets.delete(key);
      else if (alive.length !== hits.length) buckets.set(key, alive);
    }
  };

  return (req, res, next) => {
    if (max <= 0 || req.method === 'OPTIONS') {
      next();
      return;
    }
    const now = Date.now();
    const key = keyGenerator(req);
    let hits = buckets.get(key);
    if (!hits) {
      hits = [];
      buckets.set(key, hits);
    }
    const threshold = now - windowMs;
    let expired = 0;
    while (expired < hits.length && hits[expired] <= threshold) expired += 1;
    if (expired > 0) hits.splice(0, expired);

    if (hits.length >= max) {
      const oldest = hits[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', '0');
      next(
        rateLimited('请求过于频繁，请稍后再试', {
          limit: max,
          windowMs,
          retryAfterSeconds,
        }),
      );
      return;
    }

    hits.push(now);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - hits.length)));

    counter += 1;
    if (counter % SWEEP_INTERVAL === 0 || buckets.size > MAX_TRACKED_KEYS) sweep(now);
    next();
  };
}
