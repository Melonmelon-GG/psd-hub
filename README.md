# 柒世纪视频组平面工程分享平台 · psd-hub

一个用来**分享平面工程作品**的网站：上传一张 PNG 展示图 + 一条网盘分享链接，
访客即可浏览作品预览、读到作者写的说明，并一键前往网盘取源文件。

站点**不自建账号体系**，直接复用主站 [7thcv.cn](https://7thcv.cn) 的登录系统：
**只有在册成员才能发布作品，且作者名自动取自登录用户名**；浏览、搜索与下载无需登录。

> 项目最初的技术路线是「上传 PSD → 浏览器端解析 → 图层树与逐层显隐预览」，
> **v2.0 起不再接入**，源文件改由网盘托管；相关代码按要求完整保留在仓库中，
> 详见下方《关于「在线 PSD 预览」：v2.0 起不再接入》一节。

```
┌──────────────────────────────────────────────────────────────────┐
│  柒世纪视频组平面工程分享平台                        [上传作品]      │
├──────────────────────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐                            │
│  │  PNG    │ │  PNG    │ │  PNG    │   ← 卡片 = 预览图 + 标题     │
│  │ 预览图  │ │ 预览图  │ │ 预览图  │     + 说明摘要 + 作者 + 标签 │
│  └─────────┘ └─────────┘ └─────────┘                            │
│  深色科幻UI   登录页重设计  图标集 v2                              │
│  三层组件库…  玻璃拟态…    线性+面性…                             │
└──────────────────────────────────────────────────────────────────┘
```

---

## 在线地址

> **https://7thcv.cn/psd/** —— 与主站（柒世纪视频组）同源部署，复用主站证书。

---

## 登录与上传权限（v2.1）

平台**不自建账号体系**，直接复用主站 `7thcv.cn` 的登录系统：

- **只有登录且为社团成员的账号才能上传作品**；未登录时上传页会引导去登录
- **作者名强制取自登录用户名（`cn`）**，客户端无法指定 —— 表单里即便塞别的名字，后端也会以令牌里的身份覆盖
- 浏览、搜索、下载、前往网盘**都不需要登录**

**安全设计**：本服务**不持有主站的 JWT 签名密钥**，也不在本地验签。
令牌真伪一律转发给主站的「成员专属」接口裁决（200 = 有效成员 / 401 = 令牌无效 / 403 = 非成员），
主站不可达时**失败关闭（502）而不是放行**。因此即使本服务被攻破，也无法伪造任何人的主站身份。

> 保留了一条 `UPLOAD_TOKEN` 旁路，仅供 CI 与部署脚本使用；清空该环境变量即可彻底关闭。

---

## 功能一览

| 能力 | 说明 |
| --- | --- |
| **登录** | 复用主站账号体系；登录态存本地，刷新自动恢复（`GET /api/auth/me` 校验） |
| **上传通道** | 拖拽或点选 **PNG 展示图**，填写标题、说明、标签，以及**网盘分享链接 + 提取码**；**作者名自动取登录用户名且不可修改**；真实上传进度条 |
| **网盘链接** | 自动识别百度 / 阿里 / 夸克 / 123 / 蓝奏 / 微云 / 城通 / OneDrive / Google Drive / MEGA / Dropbox，显示对应图标与中文名；未识别的归为「其它链接」同样可用；提取码带一键复制 |
| **网盘跳转与计数** | 下载按钮走 `/api/projects/:id/go` 做 **302 跳转**，这样站内才能统计到点击量 —— 直接放外链就统计不到 |
| **展示** | 列表页卡片展示 PNG + 标题 + 说明摘要 + 作者 + 标签 + 网盘来源徽标；详情页大幅展示 PNG 与完整说明（保留换行），预览框按图片真实比例撑开 |
| **下载** | 一键下载 PNG（HTTP Range 断点续传、中文文件名还原），或一键前往网盘取源文件 |
| **搜索与筛选** | 关键词模糊搜索（标题/说明/作者/标签/文件名/网盘源文件名）、标签筛选、**按网盘来源筛选**、5 种排序、分页；筛选状态同步到 URL |
| **去重与鉴权** | 按 PNG 的 sha256 去重；**上传需登录**、删除需管理令牌，两者互不越权 |
| **运维友好** | 单进程即可同时提供 API 与页面；内置健康检查、限流（登录接口额外严格限流防爆破）、统一错误信封、结构化日志；对象存储接口已预留 |
| **部署** | Docker Compose / systemd / PM2 三套配置 + Nginx + HTTPS + 一键推送脚本（备份 / 健康检查 / 失败回滚）+ GitHub Actions，**已实际部署运行** |

---

## 关于「在线 PSD 预览」：v2.0 起不再接入

项目最初的技术路线是「上传 PSD → 浏览器端解析 → 图层树与逐层显隐预览」，
其中包括一套**自研的多色彩模式 PSD 解码器**（覆盖 CMYK / Lab / Multichannel / Duotone / 16 位，
逐像素回归全部 `MAE = 0.00`，用 `ag-psd` 与 `Pillow` 两套独立实现交叉验证过）。

**v2.0 起路线改为「上传 PNG + 网盘链接」**：源文件交由网盘托管，站内只做展示与跳转。
上述 PSD 相关代码**按用户要求完整保留在仓库中**：

```
frontend/src/psd/**                       # 解析、图层树、渲染、自研解码器
frontend/src/components/PsdViewer.tsx     # 交互式预览
frontend/src/components/LayerPanel.tsx    # 图层树面板
frontend/src/components/PsdInfoPanel.tsx  # PSD 元信息面板
backend/src/lib/psdHeader.ts              # 文件头解析
```

它们**仍然可编译、其测试仍然全绿，只是没有任何生产代码引用**，因此也不会被打进前端产物
（`ag-psd` 因此从产物里消失，JS 体积从 716 KB 降到约 390 KB）。

技术存档见 **[docs/COLOR-MODES.md](docs/COLOR-MODES.md)** —— 若将来要恢复在线预览，
按那份文档的结论接回即可，无需重新调研。当前路线的契约见 [docs/API.md](docs/API.md)。

---

## 技术栈

**后端**：Node.js 24 · TypeScript 5.9 · Express 5 · Multer 2 · Zod 4 · 自研 JSON 元数据库（原子写 + 串行写队列）
**前端**：Vite 7 · React 19 · React Router 7 · 手写 CSS（无 UI 框架）
（`ag-psd` 31 仍作为依赖保留给遗留预览模块，但已无生产代码引用，不会打进产物）
**存储**：本地磁盘（默认，`FileStorage` 抽象 + S3/OSS 兼容驱动已预留）

> 有意**不引入任何需要本地编译的原生依赖**（无 sharp / better-sqlite3 / node-canvas）：
> 缩略图由浏览器端生成，元数据用带原子写的 JSON 文件。这让 `npm install` 在 Windows、
> macOS、Alpine 容器里都能一次装成。

---

## 目录结构

```
psd-hub/
├─ backend/                  后端 API（Express 5 + TypeScript）
│  ├─ src/
│  │  ├─ routes/             健康检查 / 项目 CRUD / 文件下发
│  │  ├─ store/              JSON 元数据库（原子写、串行写队列、查询排序分页）
│  │  ├─ storage/            文件存储抽象（local / s3）
│  │  ├─ middleware/         鉴权、限流、上传、错误信封、安全头
│  │  ├─ lib/                PSD 文件头解析、sha256、原子写等
│  │  ├─ sendFile.ts         Range(206/416) + ETag/304 + 中文文件名
│  │  └─ static.ts           生产模式下托管前端产物 + SPA 回退
│  └─ test/                 204 个测试（node:test）
├─ frontend/                 前端 SPA（Vite + React）
│  ├─ src/
│  │  ├─ psd/                PSD 解析 / 图层树 / 混合模式映射 / 合成渲染 / 导出 PNG
│  │  ├─ pages/              图库、工程详情、上传、404
│  │  ├─ components/         PsdViewer、LayerPanel、ProjectCard、上传拖拽区…
│  │  ├─ upload/             XHR 上传（真实进度）+ 本地校验
│  │  └─ styles/             设计令牌 + 全局样式（深色优先，适配浅色）
│  └─ test/                 162 个测试（含 ag-psd 真实素材回归）
├─ deploy/                   部署与「推送服务器」相关代码
│  ├─ docker/Dockerfile      四阶段镜像（前端产物 + 后端编译 + 精简运行层）
│  ├─ nginx/                 反代配置 + HTTPS 模板
│  ├─ systemd/               裸机服务单元 + 环境变量模板
│  ├─ pm2/                   PM2 进程配置
│  ├─ scripts/               deploy.sh / push-image.sh / backup.sh
│  ├─ env.example            Docker Compose 用环境变量模板
│  └─ .env.deploy.example    推送脚本配置模板
├─ tools/                    本地工具（零依赖）
│  ├─ make-sample-psd.mjs    手写字节流生成示例 PSD/PNG 测试素材
│  ├─ verify-psd.mjs         用 ag-psd 反向校验素材结构
│  ├─ smoke-e2e.mjs          端到端冒烟（145 项断言，可直连线上站点验收）
│  ├─ dev.mjs                并行启动前后端开发服务
│  └─ clean.mjs              清理产物与依赖
├─ docs/
│  ├─ API.md                 ★ 前后端接口契约（唯一真相来源）
│  ├─ ARCHITECTURE.md        架构与关键设计决策
│  ├─ DEPLOY.md              三种部署路线 + HTTPS + 备份 + 升级回滚
│  └─ TASKS.md               前端 / 后端 / 部署 任务看板
├─ docker-compose.yml        一体化编排（应用 + 可选 Nginx + 可选 certbot）
└─ .github/workflows/        CI 与打标签自动发版
```

---

## 快速开始（本地开发）

前置：**Node.js ≥ 20.19**（推荐 24）、npm ≥ 10。

```bash
# 1) 安装三个子项目的依赖，并生成测试素材
npm run setup

# 2) 同时启动后端 (4000) 与前端 (5173)
npm run dev
```

打开 <http://127.0.0.1:5173> 即可看到图库页面；前端开发服务器会把 `/api` 代理到
`http://127.0.0.1:4000`。

想塞一份示例数据进图库（v2.0：PNG + 网盘链接）：

```bash
# 一键塞 7 条覆盖各种网盘的演示数据
node tools/seed-demo.mjs

# 或者手工调接口
curl -F "image=@tools/fixtures/sample-ui.png" \
     -F "netdiskUrl=https://pan.baidu.com/s/1dEmOxYzAbCdEfGhIjKlMn" \
     -F "extractCode=ui88" \
     -F "sourceFileName=深色科幻UI稿_分层.psd" \
     -F "title=示例：深色科幻 UI 稿" \
     -F "description=由 tools/make-sample-psd.mjs 生成的测试素材。" \
     -F "author=psd-hub" \
     -F "tags=UI,示例" \
     http://127.0.0.1:4000/api/projects
```

### 只跑其中一端

```bash
npm run dev:api      # 仅后端
npm run dev:web      # 仅前端（需要后端在 4000 上）
```

### 单进程生产模式（最简部署形态）

```bash
npm run build                       # 构建前后端
SERVE_STATIC=true STATIC_DIR=./frontend/dist npm start
# 打开 http://127.0.0.1:4000 —— 同一个端口同时提供页面与 API
```

---

## 配置

后端配置全部通过环境变量，完整清单见 [`backend/.env.example`](backend/.env.example)（每一项都有中文注释）。
最常用的几个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `4000` | 监听端口 |
| `DATA_DIR` | `./data` | PSD / PNG / `db.json` 的存放目录，**务必持久化并备份** |
| `MAX_UPLOAD_MB` | `20` | 单张展示图（PNG）上限；v2.0 起不再上传源文件，20 MB 足够 |
| `UPLOAD_TOKEN` | 空 | 设置后上传接口需要 `x-upload-token`；留空则不校验 |
| `ADMIN_TOKEN` | 空 | 设置后改信息 / 删工程需要 `x-admin-token` |
| `CORS_ORIGIN` | `*` | 前后端分离部署时填前端域名 |
| `SERVE_STATIC` | `false` | `true` 时由后端托管 `STATIC_DIR` 里的前端产物 |
| `STORAGE_DRIVER` | `local` | 改成 `s3` 即切到 S3 / 阿里云 OSS / MinIO |

> **生产环境请务必设置 `UPLOAD_TOKEN` 与 `ADMIN_TOKEN`**，生成方式：`openssl rand -hex 32`。

---

## 测试与验证

```bash
npm test                 # 后端 204 个 + 前端 162 个测试
npm run typecheck        # 两端类型检查
npm run smoke            # 端到端冒烟：起真实服务 + 上传/浏览/网盘跳转 145 项断言
npm run verify:fixtures  # 用 ag-psd 反向校验示例 PSD 结构是否合法
```

端到端冒烟也可以直接打线上环境做部署后验收：

```bash
node tools/smoke-e2e.mjs --base https://7thcv.cn/psd --no-spawn
```

覆盖的真实链路：健康检查 → 前端静态产物 → 上传 PNG（中文标题/说明/文件名/全角逗号标签）→
sha256 去重 409 → 列表/搜索/标签聚合 → 详情浏览计数 → PNG 下载（Range 206、附件头、
中文文件名、下载计数）→ 网盘 302 跳转与下载计数 → SPA 深链回退 → 404 错误信封 →
输入校验 400/415 → 删除。

---

## 部署

三种路线，完整步骤见 **[docs/DEPLOY.md](docs/DEPLOY.md)**：

| 路线 | 适合 | 一句话 |
| --- | --- | --- |
| **Docker Compose** | 绝大多数 VPS | `cp deploy/env.example .env && docker compose up -d --build` |
| **systemd + Nginx** | 不想装 Docker 的机器 | 构建产物放 `/opt/psd-hub`，`systemctl enable --now psd-hub` |
| **PM2** | 已有 PM2 体系 | `pm2 start deploy/pm2/ecosystem.config.cjs` |

一键推送（本地构建 + rsync/tar 上传 + 远端重启 + 健康检查 + 失败自动回滚）：

```bash
cp deploy/.env.deploy.example deploy/.env.deploy   # 填服务器地址等信息
bash deploy/scripts/deploy.sh --mode docker        # 或 --mode pm2
bash deploy/scripts/deploy.sh --dry-run            # 先干跑看看
```

镜像推送与数据备份：

```bash
bash deploy/scripts/push-image.sh --registry registry.example.com/ns --tag v2.1.0
bash deploy/scripts/backup.sh --docker --keep 14 --remote backup@host:/backups
```

打 `v*.*.*` 标签会自动触发 GitHub Actions：校验 → 构建多架构镜像推 GHCR → SSH 部署 → 健康检查失败自动回滚。

---

## 接口

接口契约见 **[docs/API.md](docs/API.md)**（前后端共同遵守的唯一真相来源）。

```
GET    /api/health                              健康检查
GET    /api/config                              公开运行时配置（上传上限、图片类型、字段长度上限、是否要求令牌）
GET    /api/projects                            列表（q / tag / author / provider / sort / page / pageSize）
GET    /api/projects/tags                       标签聚合
GET    /api/projects/:id                        详情（默认计一次浏览，?count=0 不计）
POST   /api/projects                            上传（multipart：image 必填，netdiskUrl 必填）
PATCH  /api/projects/:id                        改文本字段与网盘信息（改链接会重新识别网盘类型）
DELETE /api/projects/:id                        删除
GET    /api/projects/:id/files/image            PNG 字节（?download=1 强制附件）
GET    /api/projects/:id/go                     302 跳转到网盘链接，并计一次下载
```

错误统一为 `{ "error": { "code", "message", "details?" } }`，`message` 为中文可直接展示。

---

## 已知限制

这些是有意识的取舍，不是 bug：

1. **元数据库是单文件 JSON**，因此**只能单实例运行**。水平扩容需要先把元数据换成
   Postgres/SQLite，并把文件存储切到对象存储（`STORAGE_DRIVER=s3`）。PM2 配置里已明确标注。
2. **源文件由网盘托管，本站不留存 PSD 原件**，因此没有「站内下载源文件」这一能力；
   网盘分享失效时只能由作者重新编辑链接。
3. **上传严格依赖主站登录态**：主站不可达时上传会被拒绝（失败关闭），但浏览、搜索、
   网盘跳转完全不受影响。
4. **自动化旁路仍是单令牌方案**（`UPLOAD_TOKEN`）：它不区分调用者，仅供 CI / 部署脚本使用；
   日常发布请一律走主站登录，清空该环境变量即可彻底关闭这条旁路。

### 关于遗留的 PSD 预览模块（默认未启用）

以下限制**只在将来重新接回「在线 PSD 预览」时才会生效**，当前路线不受影响：

- **裁剪图层**（clipping mask）按普通图层叠加，未实现"仅作用于下一个图层"的语义。
- **部分混合模式做了近似映射**：`linear burn → color-burn`、`vivid/linear/pin light → hard-light`、
  `divide → color-dodge`、`dissolve → source-over` 等；Canvas 没有原生等价项。原生支持的
  （multiply / screen / overlay / soft-light / hue / luminosity …）为精确等价。
- **PSD 解析在主线程**（`ag-psd` 是同步 API），超大文件会有短暂卡顿；已加 >150MB 二次确认与骨架屏。
- 后端不解析 PSD 图层段，`psd.layerCount` 固定为 `null`（图层信息由前端解析后实时展示）。

---

## 许可

MIT
