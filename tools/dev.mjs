#!/usr/bin/env node
/**
 * 同时启动后端 API 与前端 Vite 开发服务器，带前缀与颜色的日志。
 *
 *   node tools/dev.mjs          （等价于根目录 `npm run dev`）
 *
 * 之所以自己写而不装 concurrently：根目录因此做到**零依赖**，
 * 新克隆仓库只需 `npm run setup` 装两个子项目的依赖即可。
 *
 * Ctrl+C 会同时终止两个子进程。任一子进程退出，另一个也会被收掉。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

const COLORS = {
  api: '\u001b[36m', // 青
  web: '\u001b[35m', // 品红
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
};

const TARGETS = [
  { name: 'api', cwd: join(ROOT, 'backend'), args: ['run', 'dev'], hint: 'http://127.0.0.1:4000/api/health' },
  { name: 'web', cwd: join(ROOT, 'frontend'), args: ['run', 'dev'], hint: 'http://127.0.0.1:5173' },
];

// 依赖没装时给出明确指引，而不是抛一堆 MODULE_NOT_FOUND
for (const target of TARGETS) {
  if (!existsSync(join(target.cwd, 'node_modules'))) {
    console.error(
      `${COLORS.red}[dev] ${target.name} 的依赖尚未安装${COLORS.reset}\n` +
        `      请先执行： npm run setup      （或 npm --prefix ${target.name} install）`,
    );
    process.exit(1);
  }
}

const children = [];
let shuttingDown = false;

function prefixStream(stream, name, isError = false) {
  const label = `${COLORS[name]}${name.padEnd(3)}${COLORS.reset}${COLORS.dim}│${COLORS.reset} `;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      process[isError ? 'stderr' : 'stdout'].write(`${label}${line}\n`);
    }
  });
}

console.log(`${COLORS.dim}──────────────────────────────────────────────${COLORS.reset}`);
console.log('PSD 展示台 · 开发模式');
for (const target of TARGETS) {
  console.log(`  ${COLORS[target.name]}${target.name.padEnd(3)}${COLORS.reset} → ${target.hint}`);
}
console.log(`${COLORS.dim}──────────────────────────────────────────────${COLORS.reset}\n`);

for (const target of TARGETS) {
  const child = spawn(NPM, target.args, {
    cwd: target.cwd,
    // Windows 上 npm 是 .cmd 批处理，必须经 shell 才能 spawn
    shell: IS_WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  child.stdout && prefixStream(child.stdout, target.name, false);
  child.stderr && prefixStream(child.stderr, target.name, true);

  child.on('error', (err) => {
    console.error(`${COLORS.red}[dev] ${target.name} 启动失败：${err.message}${COLORS.reset}`);
    shutdown(1);
  });

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`${COLORS.dim}[dev] ${target.name} 已退出（code=${code}），正在停止其它进程…${COLORS.reset}`);
    shutdown(code ?? 0);
  });

  children.push(child);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      // Windows 上没有真正的信号，taskkill 才能带走整棵进程树
      if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGINT');
    }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => {
  console.log(`\n${COLORS.dim}[dev] 收到 Ctrl+C，正在关闭…${COLORS.reset}`);
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
