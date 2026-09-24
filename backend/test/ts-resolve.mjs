/**
 * 受限沙箱专用的模块解析钩子（**不参与生产运行**）。
 *
 * 背景：`npm test` 使用 tsx（`node --import tsx`），而 tsx 依赖 esbuild 以子进程管道方式
 * 提供转换服务。某些受限执行环境（例如禁止子进程管道/命名管道）会直接拒绝该 spawn，
 * 报 `spawn EPERM`，tsx 与 esbuild 都无法启动。
 *
 * 本文件用 Node 24 内置能力替代 tsx 的两件事：
 * 1. 解析：把源码里的 `./x.js`（NodeNext 写法）映射到真实存在的 `./x.ts`；
 * 2. 转换：Node 24 默认自带 TypeScript 类型擦除，无需第三方转换器。
 *
 * 用法（在拒绝子进程管道的环境里替代 `npm test`）：
 *   node --import ./test/ts-resolve.mjs --test-isolation=none --test test/*.test.ts
 *
 * 正常环境仍请使用 `npm test`。
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        // 只重定向 URL；format 交给 Node 依据 .ts 扩展名推断（从而启用类型擦除）
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
