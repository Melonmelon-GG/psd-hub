# 部署指南 · PSD 展示台

本文覆盖三条部署路线、HTTPS、对象存储、备份、升级回滚与排障。
所有部署代码都在 `deploy/` 目录里，**可以原样用于你自己的服务器**。

---

## 0 · 先想清楚三件事

| 问题 | 建议 |
| --- | --- |
| **数据放哪？** | 默认存本地磁盘 `<DATA_DIR>`（PSD + PNG + `db.json`）。数据量大或要跑多实例时切对象存储（见 §6）。 |
| **谁来扛大文件？** | PSD 动辄几百 MB。**Nginx 的 `client_max_body_size` 必须 ≥ 后端的 `MAX_UPLOAD_MB`**，并开启 `proxy_request_buffering off`（配置文件里已经写好）。 |
| **能跑几个实例？** | **只能 1 个**。元数据库是单文件 JSON + 进程内写队列，多实例会互相覆盖。要扩容先看 `docs/ARCHITECTURE.md` 的"扩容路径"。 |

服务器最低配置：**1 核 1G / 20G 磁盘**可以跑，但处理 500MB 级 PSD 时建议 **2 核 2G** 起步，
磁盘按「工程总量 × 2」（原始 PSD + 可能的备份）估算。

---

## 路线 A · Docker Compose（推荐）

### A1 · 一键起站

```bash
# 1) 拉代码
git clone <你的仓库地址> psd-hub && cd psd-hub

# 2) 准备环境变量
cp deploy/env.example .env
vim .env        # 至少确认 MAX_UPLOAD_MB、UPLOAD_TOKEN、ADMIN_TOKEN
#   生成随机令牌：openssl rand -hex 32

# 3) 起服务（首次会构建镜像，约 1–3 分钟）
docker compose up -d --build

# 4) 验证
curl -fsS http://127.0.0.1:4000/api/health
```

打开 `http://<服务器IP>:4000` 即可。

> 默认 `PSD_HUB_BIND=127.0.0.1`，也就是**只监听回环**，从外部访问不到。
> 这是刻意的安全默认值。要么改 `.env` 里的 `PSD_HUB_BIND=0.0.0.0`，要么（推荐）用路线 A2 挂 Nginx。

### A2 · 加一层 Nginx（推荐生产这么用）

```bash
docker compose --profile edge up -d --build
curl -fsS http://127.0.0.1/nginx-health
```

Nginx 配置在 `deploy/nginx/psd-hub.conf`，已包含：

- `client_max_body_size 600m` + `client_body_timeout 600s`
- `proxy_request_buffering off` / `proxy_buffering off`（大文件流式透传，不落盘缓冲）
- `/assets/` 一年不可变缓存（配合 Vite 的内容哈希文件名）
- gzip、安全响应头、`server_tokens off`

### A3 · 上 HTTPS

```bash
# 1) .env 里写域名与邮箱
DOMAIN=psd.example.com
LETSENCRYPT_EMAIL=you@example.com

# 2) 先用 HTTP 配置把站点跑起来（Nginx 需要能响应 ACME challenge）
docker compose --profile edge up -d

# 3) 申请证书
docker compose --profile tls run --rm certbot

# 4) 换成 HTTPS 配置
cp deploy/nginx/psd-hub.https.conf.example deploy/nginx/psd-hub.conf
sed -i 's/psd.example.com/你的域名/g' deploy/nginx/psd-hub.conf
docker compose exec nginx nginx -s reload

# 5) 自动续期（每月 1 号凌晨 3 点）
( crontab -l 2>/dev/null; echo '0 3 1 * * cd /opt/psd-hub && docker compose --profile tls run --rm certbot renew && docker compose exec nginx nginx -s reload' ) | crontab -
```

> 用 Cloudflare / 阿里云 CDN 挡在前面时，把 SSL 模式设为 **Full (strict)**，
> 并确认 CDN 的单文件上传上限 ≥ `MAX_UPLOAD_MB`。
> 若走 CDN，建议把 `deploy/nginx/psd-hub.conf` 里 `/api/projects/.*/files/psd` 的
> 缓存规则显式关掉，避免 PSD 下载被 CDN 缓存导致下载计数不准。

### A4 · 常用运维命令

```bash
docker compose ps                          # 状态
docker compose logs -f psd-hub             # 应用日志
docker compose restart psd-hub             # 重启
docker compose up -d --build               # 更新代码后重建
docker compose pull psd-hub && docker compose up -d --no-build   # 用镜像更新
docker exec -it psd-hub-app sh             # 进容器
docker compose exec psd-hub node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>r.json()).then(console.log)"
```

---

## 路线 B · systemd + Nginx（裸机 / 不想用 Docker）

### B1 · 建用户与目录

```bash
sudo useradd --system --home /opt/psd-hub --shell /usr/sbin/nologin psdhub
sudo mkdir -p /opt/psd-hub /var/lib/psd-hub /var/log/psd-hub /etc/psd-hub
sudo chown -R psdhub:psdhub /opt/psd-hub /var/lib/psd-hub /var/log/psd-hub
```

### B2 · 上传构建产物

推荐**在本地或 CI 构建**，服务器只跑 `dist`（这样服务器不需要 devDependencies）：

```bash
npm run setup && npm run build      # 在本地执行
bash deploy/scripts/deploy.sh --mode pm2
```

或者手动：

```bash
rsync -az --delete \
  --exclude node_modules --exclude 'backend/data' --exclude .git \
  ./ deploy@server:/opt/psd-hub/
ssh deploy@server 'cd /opt/psd-hub/backend && npm ci --omit=dev'
```

同时把前端产物放到 `/opt/psd-hub/frontend/dist`（后端会按 `STATIC_DIR` 托管它）。

> 服务器上需要 Node 20.19+（推荐 24）。用 NodeSource 安装：
> `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs`

### B3 · 配置环境变量

```bash
sudo cp deploy/systemd/psd-hub.env.example /etc/psd-hub/psd-hub.env
sudo chmod 600 /etc/psd-hub/psd-hub.env
sudo vim /etc/psd-hub/psd-hub.env
```

至少改这几项：

```ini
DATA_DIR=/var/lib/psd-hub
STATIC_DIR=/opt/psd-hub/frontend/dist
SERVE_STATIC=true
UPLOAD_TOKEN=<openssl rand -hex 32 的结果>
ADMIN_TOKEN=<另一个随机串>
```

### B4 · 启用服务

```bash
sudo cp deploy/systemd/psd-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now psd-hub
sudo systemctl status psd-hub
journalctl -u psd-hub -f          # 跟踪日志
```

`psd-hub.service` 里已经做了比较彻底的安全加固（`ProtectSystem=strict`、`NoNewPrivileges`、
`PrivateTmp`、`SystemCallFilter` 等），并且用 `ReadWritePaths` 精确放开了数据与日志目录。

### B5 · Nginx

```bash
sudo cp deploy/nginx/psd-hub.conf /etc/nginx/conf.d/psd-hub.conf
sudo sed -i 's/server psd-hub:4000;/server 127.0.0.1:4000;/' /etc/nginx/conf.d/psd-hub.conf
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS 用 certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d psd.example.com
```

---

## 路线 C · PM2

```bash
cd /opt/psd-hub
npm --prefix backend install --omit=dev
pm2 start deploy/pm2/ecosystem.config.cjs
pm2 save
pm2 startup            # 按提示执行它输出的那条命令

pm2 logs psd-hub
pm2 reload psd-hub     # 零停机重载
```

> ⚠️ `deploy/pm2/ecosystem.config.cjs` 里刻意写死 `instances: 1` + `exec_mode: 'fork'`。
> **不要改成 cluster 多实例**——JSON 元数据库的写队列在进程内，多实例会互相覆盖导致数据丢失。
> 详见 `docs/ARCHITECTURE.md` §"扩容路径"。

---

## 4 · 环境变量速查

完整清单与逐项中文说明见 `backend/.env.example` / `deploy/env.example`。

| 变量 | 默认 | 生产建议 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` |
| `HOST` | `0.0.0.0` | 裸机 + Nginx 时用 `127.0.0.1` |
| `PORT` | `4000` | 保持 |
| `DATA_DIR` | `./data` | 绝对路径，独立分区更好 |
| `MAX_UPLOAD_MB` | `20` | v2.0 只上传 PNG 展示图，20 MB 足够；与 Nginx `client_max_body_size`（模板里是 `32m`）对齐即可 |
| `UPLOAD_TOKEN` | 空 | **必须设置** |
| `ADMIN_TOKEN` | 空 | **必须设置** |
| `CORS_ORIGIN` | `*` | 前后端分离时填前端域名 |
| `TRUST_PROXY` | `1` | 有反代时保持 1（否则拿不到真实 IP） |
| `SERVE_STATIC` | `false` | 单进程部署设 `true` |
| `STATIC_DIR` | `../frontend/dist` | 绝对路径更稳 |
| `STORAGE_DRIVER` | `local` | 见 §6 |
| `LOG_LEVEL` | `info` | 排障时 `debug` |

**改完环境变量记得同时重启**：Compose 用 `docker compose up -d`（不是 `restart`，`restart` 不会重读 `.env`）；
systemd 用 `systemctl restart psd-hub`。

---

## 5 · 反向代理要点（无论哪条路线都值得看）

```nginx
client_max_body_size    600m;    # ≥ MAX_UPLOAD_MB
client_body_timeout     600s;
client_body_buffer_size 1m;

proxy_request_buffering off;     # 关键：不要先把整个 PSD 落到 Nginx 磁盘
proxy_buffering         off;
proxy_read_timeout      600s;
proxy_send_timeout      600s;
```

`proxy_request_buffering off` 是这里最值钱的一行：不关的话，上传一个 500MB 的 PSD，
Nginx 会先写满临时文件再转发给后端，磁盘 IO 直接翻倍，慢盘上会非常明显。

另外后端已经实现了 `Range` / `ETag` / `304`，代理层**不要**去改写或剥离这些响应头。

---

## 6 · 切到对象存储（S3 / 阿里云 OSS / MinIO）

代码里已经留好了 `FileStorage` 抽象与 S3 驱动（`backend/src/storage/s3.ts`）。

```bash
npm --prefix backend install @aws-sdk/client-s3
```

```ini
STORAGE_DRIVER=s3
S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com     # MinIO 填 http://minio:9000
S3_REGION=cn-hangzhou
S3_BUCKET=my-psd-bucket
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=false                            # MinIO 通常要 true
S3_PUBLIC_BASE_URL=                                  # 走 CDN 时填前缀
```

切之前注意：

1. **已有的本地数据不会自动迁移**，需要自己把 `<DATA_DIR>/projects/*` 上传到桶里（键名与本地相对路径一致）。
2. `S3_PUBLIC_BASE_URL` 目前仅作为配置保留；按照接口契约，下载链接仍走
   `/api/projects/:id/files/...`，这样才能继续统计下载次数并保持鉴权一致。
3. 对象存储只是解决了「文件放哪」，**元数据库仍然是单文件 JSON**，所以依然只能单实例。

---

## 7 · 备份与恢复

```bash
# Docker 卷
bash deploy/scripts/backup.sh --docker --keep 14

# 裸机目录
bash deploy/scripts/backup.sh --local --data-dir /var/lib/psd-hub --keep 14

# 顺手推一份到异地
bash deploy/scripts/backup.sh --docker --remote backup@other-host:/backups
```

脚本会打包 → **校验归档完整性**（`tar tzf`）→ 检查关键文件 `db.json` 是否在内 →
按份数清理旧归档。建议放进 crontab：

```cron
30 3 * * * cd /opt/psd-hub && bash deploy/scripts/backup.sh --docker --keep 14 >> /var/log/psd-hub/backup.log 2>&1
```

**恢复**（务必先停服务）：

```bash
# Docker
docker compose stop psd-hub
docker run --rm -v psd-hub_psd-data:/data -v /opt/psd-hub/backups:/backup alpine:3.20 \
    sh -c "rm -rf /data/* && tar xzf /backup/psd-hub-<时间戳>.tar.gz -C /data"
docker compose start psd-hub

# 裸机
sudo systemctl stop psd-hub
sudo rm -rf /var/lib/psd-hub/*
sudo tar xzf /path/to/psd-hub-<时间戳>.tar.gz -C /var/lib/psd-hub
sudo chown -R psdhub:psdhub /var/lib/psd-hub
sudo systemctl start psd-hub
```

恢复后跑一次验收：

```bash
node tools/smoke-e2e.mjs --base https://psd.example.com --no-spawn
```

---

## 8 · 升级与回滚

### 一键推送（推荐）

```bash
bash deploy/scripts/deploy.sh --mode docker     # 或 --mode pm2
```

它做完这些事，任一步失败都会明确报错并以对应退出码结束：

1. 本地预检（node / npm / ssh / tar / rsync，SSH 连通性）
2. 本地跑类型检查 + 两端测试 + 构建（`--skip-tests` / `--skip-build` 可跳过）
3. 同步代码（有 rsync 用 rsync，没有就自动降级为 tar over ssh）
4. 远端构建并滚动重启（Docker：保留 `:previous` 镜像；PM2：`releases/<时间戳>` + `current` 软链）
5. 在服务器上通过 SSH 打 `127.0.0.1/api/health` 做健康检查（默认重试 15 次）
6. **健康检查失败自动回滚**，并打印排查命令
7. 清理历史版本（PM2 保留最近 `KEEP_RELEASES` 个 release）

先干跑看看会做什么：

```bash
bash deploy/scripts/deploy.sh --dry-run
```

手动回滚：

```bash
bash deploy/scripts/deploy.sh --mode pm2 --rollback
bash deploy/scripts/deploy.sh --mode docker --rollback   # 把 :previous 重新打标签并重启
```

### 镜像方式

```bash
bash deploy/scripts/push-image.sh --registry registry.example.com/ns --tag v1.0.0
# 服务器上
PSD_HUB_IMAGE=registry.example.com/ns/psd-hub PSD_HUB_VERSION=v1.0.0 \
  docker compose pull psd-hub && docker compose up -d --no-build psd-hub
```

### GitHub Actions 自动发版

打标签即触发 `.github/workflows/deploy.yml`：校验 → 构建 amd64+arm64 镜像推 GHCR →
SSH 部署 → 健康检查失败自动回滚。需要的 Secrets：

`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、可选 `DEPLOY_PORT` / `DEPLOY_PATH` / `GHCR_TOKEN`。

---

## 9 · 排障手册

| 现象 | 原因与处理 |
| --- | --- |
| 上传 413 | Nginx `client_max_body_size` 小于后端 `MAX_UPLOAD_MB`；或 CDN 有自己的上限。两边对齐即可。 |
| 上传卡住 / 超时 | 没关 `proxy_request_buffering`；或 `proxy_read_timeout` 太小。 |
| 页面 404 / 刷新详情页白屏 | `SERVE_STATIC` 没开，或 `STATIC_DIR` 路径不对（应为**绝对路径**或相对 `backend/` 的正确相对路径）。 |
| 前端能开但接口全 404 | 前后端分离部署时 `VITE_API_BASE` 没配，或 `CORS_ORIGIN` 没放行前端域名。 |
| 中文文件名变乱码 | 反代层剥掉了 `Content-Disposition`；后端已用 `filename*=UTF-8''` 编码，检查代理有没有改写响应头。 |
| 下载计数不动 | 直接访问了 `/files/psd`（inline，按契约不计下载）。只有 `?download=1` 才计数。 |
| `db.json` 报 JSON 解析错误 | 检查是否有**多个进程**同时写同一个 `DATA_DIR`（违反单实例约束）；从最近一份备份恢复。 |
| 容器健康检查一直 unhealthy | `docker logs psd-hub-app` 看启动横幅；常见是 `DATA_DIR` 无写权限（宿主机目录属主不对）。 |
| 内存被打满 / 容器被 OOM kill | 处理大 PSD 时 http 请求体与 `db.json` 都在内存里。调大 `MemoryMax` / 容器 `mem_limit`，或切对象存储并控制并发上传。 |
| `pm2 status` 显示重启次数暴涨 | 看 `pm2 logs psd-hub`；常见是 `DATA_DIR` 不存在或不可写。 |

日志与诊断入口：

```bash
# Docker
docker compose logs --tail=200 psd-hub
docker inspect --format '{{json .State.Health}}' psd-hub-app | jq

# systemd
journalctl -u psd-hub -n 200 --no-pager
systemctl show psd-hub -p MemoryCurrent

# 通用：接口自检
curl -s http://127.0.0.1:4000/api/health
curl -s http://127.0.0.1:4000/api/config
```

每个响应都带 `x-request-id`，用它把一次用户操作与日志里的具体请求对上。

---

## 10 · 上线检查清单

- [ ] `UPLOAD_TOKEN` / `ADMIN_TOKEN` 都已设置为随机长串
- [ ] `MAX_UPLOAD_MB` ≤ Nginx `client_max_body_size` ≤ 云厂商/CDN 上限
- [ ] `DATA_DIR` 在持久卷/独立分区上，且属主正确
- [ ] HTTPS 已生效，HTTP 已 301 跳转
- [ ] 备份 crontab 已配置，并且**实际做过一次恢复演练**
- [ ] `curl /api/health` 通过，`node tools/smoke-e2e.mjs --no-spawn --base <线上地址>` 66 项全绿
- [ ] 日志轮转已生效（Docker 用 `max-size`，systemd 用 journald/logrotate）
- [ ] 磁盘与内存告警已配置
