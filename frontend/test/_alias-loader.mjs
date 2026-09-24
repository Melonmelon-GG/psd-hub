/**
 * 测试辅助：把 `@/xxx` 路径别名解析到 src/。
 *
 * 说明：正式测试命令是 `npm test`（`node --import tsx --test test/*.test.ts`），
 * tsx 会自行读取 tsconfig 的 paths，因此**运行正式测试时不需要本文件**。
 * 本文件仅用于在无法使用 tsx 的环境（例如禁止子进程管道的受限沙箱）下，
 * 用 Node 24 原生类型剥离直接跑测试：
 *
 *   node --import ./test/_alias-loader.mjs --test test/*.test.ts
 */
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC_DIR = path.resolve(import.meta.dirname, '..', 'src');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      let target = specifier.slice(2);
      // 无扩展名时补 .ts（Node 原生剥离只认真实文件路径）
      if (!path.extname(target)) target += '.ts';
      return {
        url: pathToFileURL(path.join(SRC_DIR, target)).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
