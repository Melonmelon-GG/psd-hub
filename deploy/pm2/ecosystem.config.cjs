// =============================================================================
// PSD 展示台 · PM2 进程配置
//
// 用法（服务器上，代码位于 /opt/psd-hub）：
//     cd /opt/psd-hub
//     pm2 start deploy/pm2/ecosystem.config.cjs
//     pm2 save && pm2 startup        # 开机自启
//     pm2 logs psd-hub
//     pm2 reload psd-hub             # 零停机重载（配合后端的 SIGTERM 优雅关闭）
//
// ⚠️ 重要：请保持 instances = 1 且 exec_mode = 'fork'
//   本项目的元数据库是「单文件 JSON + 进程内串行写队列」，文件存储默认是本地磁盘。
//   一旦用 cluster 模式多实例，多个进程会各自持有内存中的 db.json 副本并互相覆盖，
//   造成数据丢失。多实例/水平扩容的前提是：
//     · STORAGE_DRIVER 换成 s3（对象存储）
//     · 元数据库换成 Postgres / SQLite(WAL 单写) 等真正的外部数据库
//   在这两步完成之前，靠 Nginx + max_memory_restart 与单实例重启来扛量即可。
// =============================================================================

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

module.exports = {
  apps: [
    {
      name: 'psd-hub',
      cwd: ROOT,
      script: path.join(ROOT, 'backend', 'dist', 'index.js'),

      // —— 单实例（原因见文件头注释）——
      instances: 1,
      exec_mode: 'fork',

      // —— 环境变量：生产环境请改用 /etc/psd-hub/psd-hub.env + systemd，
      //    或在下面 env 里补齐。这里只放与路径相关的安全默认值。——
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 4000,
        TRUST_PROXY: '1',
        DATA_DIR: '/var/lib/psd-hub',
        SERVE_STATIC: 'true',
        STATIC_DIR: path.join(ROOT, 'frontend', 'dist'),
        LOG_LEVEL: 'info',
      },

      // —— 稳定性 ——
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      restart_delay: 3000,
      max_memory_restart: '1500M',

      // —— 优雅关闭：给后端留出处理完在途请求（大文件上传/下载）的时间 ——
      kill_timeout: 20000,
      listen_timeout: 10000,
      wait_ready: false,
      shutdown_with_message: false,

      // —— 日志 ——
      merge_logs: true,
      time: true,
      out_file: '/var/log/psd-hub/pm2-out.log',
      error_file: '/var/log/psd-hub/pm2-err.log',
      // 单文件超过 10M 就切分，保留 5 份
      max_size: '10M',
      retain: 5,

      // —— 部署钩子：发版前后各跑一次健康检查 ——
      post_update: ['npm --prefix backend install --omit=dev'],
    },
  ],
};
