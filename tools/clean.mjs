#!/usr/bin/env node
/**
 * 清理构建产物、依赖与运行时数据。
 *   node tools/clean.mjs            # 清理 dist / data / 覆盖率
 *   node tools/clean.mjs --deps     # 连 node_modules 一起删
 *   node tools/clean.mjs --cache    # 连 .npm-cache 一起删（谨慎：下次安装会重新下载）
 */

import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tools$/, '');
const args = new Set(process.argv.slice(2));

const targets = [
  'backend/dist',
  'frontend/dist',
  'backend/data',
  'frontend/.vite',
  'backend/tsconfig.tsbuildinfo',
  'frontend/tsconfig.tsbuildinfo',
  'backend/coverage',
  'frontend/coverage',
  'backend/.tsbuildinfo',
  'frontend/.tsbuildinfo',
];

if (args.has('--deps')) {
  targets.push('node_modules', 'backend/node_modules', 'frontend/node_modules', 'tools/node_modules');
}
if (args.has('--cache')) {
  targets.push('.npm-cache');
}
if (args.has('--fixtures')) {
  targets.push('tools/fixtures');
}

let removed = 0;
for (const rel of targets) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  rmSync(abs, { recursive: true, force: true });
  console.log(`  已删除 ${rel}`);
  removed++;
}
console.log(removed === 0 ? '没有需要清理的内容。' : `清理完成，共删除 ${removed} 项。`);
