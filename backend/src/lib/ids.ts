/**
 * ID 生成：项目 id 形如 "prj_9f2c1ab73d4e"（前缀 + 12 位小写十六进制）。
 */
import { randomBytes } from 'node:crypto';

const PROJECT_ID_PREFIX = 'prj_';
const PROJECT_ID_BYTES = 6; // 6 字节 → 12 位十六进制

/** 生成项目 id（48 bit 随机，碰撞概率可忽略） */
export function newProjectId(): string {
  return `${PROJECT_ID_PREFIX}${randomBytes(PROJECT_ID_BYTES).toString('hex')}`;
}

/** 校验 id 是否符合契约格式（非法 id 直接快速失败，避免无谓 IO） */
export function isProjectId(value: string): boolean {
  return /^prj_[0-9a-f]{12}$/.test(value);
}

/** 生成请求追踪 id（16 位小写十六进制） */
export function newRequestId(): string {
  return randomBytes(8).toString('hex');
}

/** 生成安全的临时文件后缀 */
export function newTempSuffix(): string {
  return randomBytes(6).toString('hex');
}
