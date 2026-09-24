/**
 * 极简结构化日志（零依赖）。
 * - 非 development：单行 JSON，便于采集（ELK / Loki / CloudWatch）
 * - development：彩色可读格式
 * 令牌等敏感值绝不写入日志。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const LEVEL_COLOR: Record<'debug' | 'info' | 'warn' | 'error', string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** 派生带固定字段的 logger */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 彩色可读输出（本地开发） */
  pretty?: boolean;
  bindings?: LogFields;
}

/** 把 Error / 特殊值规整成可 JSON 序列化的字段 */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeValue(v);
    return out;
  }
  return value;
}

function normalizeFields(fields: LogFields | undefined): LogFields | undefined {
  if (!fields) return undefined;
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) out[k] = normalizeValue(v);
  return out;
}

function formatTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  return JSON.stringify(value);
}

/** 创建 logger 实例 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level: LogLevel = options.level ?? 'info';
  const pretty = options.pretty ?? false;
  const baseBindings = options.bindings ?? {};
  const threshold = LEVEL_WEIGHT[level];

  const emit = (lvl: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[lvl] < threshold) return;
    const now = new Date();
    const merged: LogFields = { ...baseBindings, ...(normalizeFields(fields) ?? {}) };
    let line: string;
    if (pretty) {
      const extras = Object.entries(merged)
        .map(([k, v]) => `${DIM}${k}=${RESET}${formatPrettyValue(v)}`)
        .join(' ');
      line = `${DIM}${formatTime(now)}${RESET} ${LEVEL_COLOR[lvl]}${lvl.toUpperCase().padEnd(5)}${RESET} ${message}${extras ? ' ' + extras : ''}\n`;
    } else {
      line = `${JSON.stringify({ ts: now.toISOString(), level: lvl, msg: message, ...merged })}\n`;
    }
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(line);
    else process.stdout.write(line);
  };

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (bindings) => createLogger({ level, pretty, bindings: { ...baseBindings, ...bindings } }),
  };
}

/** 判断字符串是否为合法日志级别 */
export function isLogLevel(value: string): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' || value === 'silent';
}

/** 无副作用 logger（测试与默认值用） */
export const silentLogger: Logger = createLogger({ level: 'silent' });
