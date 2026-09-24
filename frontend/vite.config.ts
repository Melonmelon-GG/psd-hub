import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 构建基址（契约 §8.4）。
 *
 * 平台正式部署在 `https://7thcv.cn/psd/` 子路径下（与主站同源，才能安全地传登录密码），
 * 因此构建时需要 `VITE_BASE_PATH=/psd/`。**默认 `/` 保持本地开发完全不变。**
 *
 * 注意这里是 Node 侧的 `process.env`（Vite 配置在 Node 里执行），
 * 不是 `import.meta.env`；运行时前端读到的对应值是 Vite 注入的 `import.meta.env.BASE_URL`。
 */
const base = process.env.VITE_BASE_PATH || '/';

// Vite 配置：开发态把 /api 代理到本地后端，生产态输出到 dist/ 由后端静态托管。
export default defineConfig({
  plugins: [react()],
  base,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 500,
  },
});
