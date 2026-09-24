# 任务看板 · PSD 展示台

> 本项目按「前端 / 后端」两条泳道拆分任务，接口以 [`API.md`](./API.md) 为唯一契约（先改契约，再改代码）。
> 状态图例：`[x]` 已完成并已验证 · `[~]` 进行中 · `[ ]` 待办
> 负责人代号：`BE` 后端泳道 · `FE` 前端泳道 · `OPS` 部署泳道

## 验证记录（全部命令均按原样执行，无替代路径）

| 命令 | 结果 |
| --- | --- |
| `npm --prefix backend run typecheck` | 退出码 0，零错误 |
| `npm --prefix backend run build` | 退出码 0，产出 `backend/dist/index.js` |
| `npm --prefix backend test` | **86 passed / 0 failed**（19 个 suite，2.3s） |
| `npm --prefix frontend run typecheck` | 退出码 0，零错误 |
| `npm --prefix frontend run build` | 退出码 0，139 modules；`index.html` 0.90 kB、CSS 40.00 kB、JS 695.64 kB（gzip 217.08 kB） |
| `npm --prefix frontend test` | **75 passed / 0 failed**（含 ag-psd 真实素材回归） |
| `npm run smoke`（`tools/smoke-e2e.mjs`） | **66 项断言全部通过**：真实起服务 → 上传 18.3MB 中文名 PSD → 去重 409 → 列表/搜索/标签 → 详情计数 → Range 206 → 中文名附件下载 → PNG 预览 → SPA 深链回退 → 400/415 → 删除 |
| `npm run verify:fixtures` | 示例 PSD 经 ag-psd 反向解析全部断言通过（含图层组、screen 混合模式、中文图层名） |
| `npm run dev` | 后端 4000 与前端 5173 同时起来，`/api/health` 直连与 Vite 代理均返回 `ok:true` |
| `bash deploy/scripts/deploy.sh --dry-run` | 六阶段流程跑通，退出码 0 |
| `bash deploy/scripts/backup.sh --local` | 归档生成 + 完整性校验通过，保留策略按预期清理（保留 2 份） |
| `bash -n` 三个部署脚本 | 语法检查全部退出码 0 |

> 说明：`tools/` 下的示例素材不进版本库（单个 PSD 19MB），`npm run setup` 会自动生成；
> 素材缺失时相关测试自动 skip 而非失败，保证新克隆的仓库 `npm test` 依然全绿。

---

## 泳道 A · 后端（backend/）

### A0 · 架构与基础
- [x] A0-1 冻结接口契约 `docs/API.md`（路径、字段、状态码、错误信封、鉴权头）
- [x] A0-2 确定技术栈与依赖版本（Express 5 + Multer 2 + Zod 4 + TypeScript 5.9，无原生编译依赖）
- [x] A0-3 确定运行时目录布局 `<DATA_DIR>/projects/<id>/{original.psd,preview.png,meta.json}` + `db.json`
- [x] A0-4 配置加载 `config.ts`（env → 类型化配置，含数值校验与中文默认值）

### A1 · 领域逻辑
- [x] A1-1 `lib/psdHeader.ts`：26 字节 PSD 头解析（宽/高/通道/位深/色彩模式）+ PSD/PNG 魔数校验
- [x] A1-2 `lib/hash.ts`：PSD 流式 sha256（去重键）
- [x] A1-3 `lib/ids.ts`：`prj_` + 12 位 hex 短 id
- [x] A1-4 `lib/fsx.ts`：目录创建、原子 JSON 写、目录安全删除、字节数人类可读化
- [x] A1-5 `lib/errors.ts`：`ApiError` 与错误码联合类型（与契约 §0.2 对齐）

### A2 · 存储层
- [x] A2-1 `store/jsonStore.ts`：`db.json` 原子写 + 进程内串行写队列（并发安全）
- [x] A2-2 `store/jsonStore.ts`：列表查询（`q` 模糊 / `tag` / `author` / 5 种排序 / 分页）
- [x] A2-3 `store/jsonStore.ts`：标签聚合 `allTags()`
- [x] A2-4 `store/jsonStore.ts`：`incrementStats` 走写队列，保证计数不丢
- [x] A2-5 `storage/types.ts`：`FileStorage` 抽象接口（为对象存储留口）
- [x] A2-6 `storage/local.ts`：本地磁盘驱动
- [x] A2-7 `storage/s3.ts`：S3/OSS 兼容驱动（动态 import，未装 SDK 时给中文提示）→ **推送服务器后换对象存储的接口预留**

### A3 · HTTP 层
- [x] A3-1 `middleware/upload.ts`：Multer 磁盘存储到 `<DATA_DIR>/tmp`，扩展名白名单 + 体积上限
- [x] A3-2 `middleware/auth.ts`：`x-upload-token` / `x-admin-token`（常量时间比较，未配置即放开）
- [x] A3-3 `middleware/rateLimit.ts`：内存滑动窗口限流 + `Retry-After`
- [x] A3-4 `middleware/errors.ts`：统一错误信封（Multer 413/415、Zod 400 映射）
- [x] A3-5 `middleware/security.ts` + `requestId.ts`：基础安全头与 `x-request-id` 链路追踪
- [x] A3-6 `sendFile.ts`：Range(206/416) + ETag/304 + 中文文件名 `filename*=UTF-8''`
- [x] A3-7 `routes/health.ts`：`GET /api/health`、`GET /api/config`
- [x] A3-8 `routes/projects.ts`：`GET /api/projects`（搜索/排序/分页）
- [x] A3-9 `routes/projects.ts`：`GET /api/projects/tags`（注册顺序在 `:id` 之前）
- [x] A3-10 `routes/projects.ts`：`GET /api/projects/:id`（浏览计数，`?count=0` 不加）
- [x] A3-11 `routes/projects.ts`：`POST /api/projects`（multipart 上传 + sha256 去重 409）
- [x] A3-12 `routes/projects.ts`：`PATCH` / `DELETE` / `POST /:id/preview`
- [x] A3-13 `routes/files.ts`：`GET /api/projects/:id/files/psd`（`?download=1` 计下载）
- [x] A3-14 `routes/files.ts`：`GET /api/projects/:id/files/preview`
- [x] A3-15 `static.ts`：`SERVE_STATIC=true` 时托管前端产物 + SPA 回退（单进程部署）
- [x] A3-16 `index.ts`：优雅关闭（SIGINT/SIGTERM，10s 强制退出）+ 启动横幅

### A4 · 后端测试与验收
- [x] A4-1 `test/psdHeader.test.ts`：合成头部解析与魔数校验
- [x] A4-2 `test/jsonStore.test.ts`：CRUD / 过滤 / 排序 / 分页 / 标签聚合 / 并发计数
- [x] A4-3 `test/api.test.ts`：真实 HTTP multipart 端到端（成功、去重、415/400/413、列表、计数、Range、304、令牌、预览替换、SPA 回退）
- [x] A4-4 `npm run typecheck` 零错误
- [x] A4-5 `npm run build` 产出 `dist/index.js`
- [x] A4-6 真机冒烟：`GET /api/health` 返回 `ok: true`

---

## 泳道 B · 前端（frontend/）

### B0 · 工程与设计系统
- [x] B0-1 确定技术栈（Vite 7 + React 19 + react-router 7 + ag-psd 31，手写 CSS）
- [x] B0-2 `vite.config.ts`：`/api` 开发代理 → `127.0.0.1:4000`、`@` 别名、产物告警阈值
- [x] B0-3 `styles/tokens.css`：设计令牌（颜色/间距/圆角/阴影/字体/动效）
- [x] B0-4 `styles/global.css`：reset、排版、`focus-visible`、透明棋盘格
- [x] B0-5 深色主题 + `prefers-color-scheme: light` 适配 + 三档响应式断点
- [x] B0-6 `config.ts`：`VITE_API_BASE` 拼接与上传令牌读取（契约 §5）

### B1 · 数据访问
- [x] B1-1 `types.ts`：与契约逐字对齐的 TS 类型
- [x] B1-2 `api/client.ts`：fetch 封装、错误信封 → `ApiError`、超时与 `AbortSignal`
- [x] B1-3 `api/projects.ts`：list / get / config / tags / create / update / delete / replacePreview
- [x] B1-4 `upload/uploadProject.ts`：`XMLHttpRequest` 实现真实上传进度
- [x] B1-5 `upload/fieldRules.ts`：与服务端一致的本地校验 + 中文提示

### B2 · PSD 预览引擎（核心）
- [x] B2-1 `psd/loadPsd.ts`：`initializeCanvas` + `readPsd` 封装，产出图层树与合成画布
- [x] B2-2 `psd/layerTree.ts`：递归规整图层树（纯函数，可单测）
- [x] B2-3 `psd/blendModes.ts`：PSD 混合模式 → canvas `globalCompositeOperation` 映射（含未知值兜底）
- [x] B2-4 `psd/render.ts`：按可见性自底向上合成，组图层离屏递归，透明度/偏移/混合模式
- [x] B2-5 客户端缩略图生成：解析 PSD → 合成 → `toBlob('image/png')` → 随表单一起上传
- [x] B2-6 大文件保护（>150MB 二次确认）与解析失败回退到 PNG（不白屏）
- [x] B2-7 `components/PsdViewer.tsx`：适应窗口/100%/缩放/平移/棋盘格/全开全关
- [x] B2-8 `components/LayerPanel.tsx`：图层树显隐切换、透明度与混合模式展示

### B3 · 页面与交互
- [x] B3-1 `/` 图库：卡片网格（PNG 预览 + 标题 + 说明摘要 + 作者 + 标签）、搜索防抖、标签筛选、排序、分页
- [x] B3-2 列表筛选状态同步到 URL query（刷新/前进后退不丢状态）
- [x] B3-3 `/p/:id` 详情：PNG 大图 + 完整说明 + 元信息 + 下载 PSD / 下载 PNG
- [x] B3-4 `/p/:id` 详情：PSD 交互式预览 tab 与图层面板
- [x] B3-5 `/upload` 上传页：拖拽选择、字段表单、自动生成预览图、提交前确认、上传进度
- [x] B3-6 错误处理：409 重复跳转已有工程 / 413 展示上限 / 401 令牌输入 / 429 稍后重试 / 网络错误可重试
- [x] B3-7 `*` 404 页
- [x] B3-8 无障碍：图标按钮 `aria-label`、模态焦点陷阱、对比度达标
- [x] B3-9 `document.title` 随路由变化

### B4 · 前端测试与验收
- [x] B4-1 `test/layerTree.test.ts`
- [x] B4-2 `test/blendModes.test.ts`
- [x] B4-3 `test/fieldRules.test.ts`
- [x] B4-4 `test/api.client.test.ts`（打桩 fetch）
- [x] B4-5 `test/ag-psd.integration.test.ts`（`writePsd` → `readPsd` 回环，证明解析链路可用）
- [x] B4-6 `npm run typecheck` 零错误
- [x] B4-7 `npm run build` 产出 `dist/`
- [x] B4-8 dev server 冒烟：`GET http://127.0.0.1:5173/` 返回 HTML

---

## 泳道 C · 部署 / 推送服务器（deploy/）
- [x] C-1 `.env.example`（后端全部环境变量 + 中文注释）
- [x] C-2 `deploy/docker/Dockerfile`：四阶段构建（前端产物 → 后端编译 → 生产依赖 → 精简运行镜像，非 root 用户 + tini + HEALTHCHECK）
- [x] C-3 `deploy/docker/docker-compose.yml`：应用 + Nginx + 健康检查 + 数据卷
- [x] C-4 `deploy/nginx/psd-hub.conf`：反代、`client_max_body_size 512m`、静态缓存、gzip、HTTPS 模板
- [x] C-5 `deploy/systemd/psd-hub.service`：裸机部署单元（`Restart=always` + 安全加固）
- [x] C-6 `deploy/pm2/ecosystem.config.cjs`：PM2 集群模式配置
- [x] C-7 `deploy/scripts/deploy.sh`：rsync 推送 + 远端重启（docker / pm2 双模式）
- [x] C-8 `deploy/scripts/push-image.sh`：构建并推送镜像到镜像仓库
- [x] C-9 `deploy/scripts/backup.sh`：数据目录打包备份与保留策略
- [x] C-10 `.dockerignore` / `deploy/.env.deploy.example`
- [x] C-11 `docs/DEPLOY.md`：三条部署路线（Docker Compose / PM2+Nginx / 前后端分离）+ HTTPS + 对象存储 + 备份 + 升级回滚
- [x] C-12 `.github/workflows/ci.yml` + `deploy.yml`：CI 校验与打标签自动部署

---

## 泳道 D · 联调验收
- [x] D-1 生成示例 PSD 工具 `tools/make-sample-psd.mjs`
- [x] D-2 后端 `/api/config` 与前端 `config.ts` 字段一致性核对
- [x] D-3 真实 HTTP 冒烟：上传示例 PSD（含中文标题/说明）→ 列表 → 详情 → 下载 PSD → 下载 PNG
- [x] D-4 前端产物由后端 `SERVE_STATIC=true` 托管时可正常访问（单进程部署路径验证）
- [x] D-5 根目录脚本 `setup` / `dev` / `build` / `typecheck` / `test` / `fixture` 可用

---

## 泳道 E · 迭代：色彩模式与通道支持（v1.1）
- [x] E-1 调研 ag-psd 的真实能力边界（结论：仅支持 Bitmap/Grayscale/RGB/Indexed，且 16 位 RLE 会错位）
- [x] E-2 用 Pillow 建立**独立实现**的交叉验证通道（自研代码不能自己证明自己）
- [x] E-3 修正素材生成器的真实缺陷：**CMYK 存的是反相墨量**（255 = 无墨），换算 `R = S_C × S_K / 255`
- [x] E-4 修正素材生成器的真实缺陷：**Indexed 调色板是平面存放**（256R + 256G + 256B），不是 RGB 交错
- [x] E-5 Lab 换算改用 **D50** 白点（ICC PCS / Photoshop 基准），替换原先的 D65
- [x] E-6 素材生成器支持 7 种色彩模式 × 8/16 位 × raw/RLE，并导出裸 RGBA 参考数据（测试零依赖可比对）
- [x] E-7 固化校验工具 `tools/verify-fixtures.mjs`（结构 + ag-psd 交叉比对，零依赖）与 `tools/pillow-crosscheck.py`（Pillow 独立交叉验证）
- [x] E-8 前端自研兜底解码器 `frontend/src/psd/decode/**`（CMYK / Lab / Multichannel / Duotone / 16 位，含图层树）
- [x] E-9 后端暴露通道级元数据：`version` / `channels` / `hasAlpha`，并修正模式 7 名称 `Multicolor` → `Multichannel`
- [x] E-10 前端双引擎：8 位 RGB/Grayscale/Indexed 走 ag-psd，其余走自研解码器
- [x] E-11 保真度分级（精确 / 色彩换算 / 近似预览）与界面标注 `frontend/src/psd/colorModes.ts`
- [x] E-12 端到端验证：上传 CMYK 工程 → 列表 → 详情 → 在线预览 → 下载

### 迭代收尾（补完与验证）
- [x] E-13 补齐解码器入口 `decodePsd` 与 `index.ts` 汇总导出（子代理只交付了 reader/packbits/color/layers/samples 等积木，缺编排层）
- [x] E-14 解码器逐像素回归：**15 份素材全部 MAE=0.00 / max=0**（含 CMYK 8/16bit × raw/RLE × 扁平/带图层、Lab、Multichannel、Duotone、Indexed、Grayscale、RGB 16bit、竖版画布）
- [x] E-15 双引擎路由测试：`loadPsd` 按色彩模式与位深选择引擎（11 组断言）
- [x] E-16 容错测试：空输入 / 签名错 / 截断 / 版本非法 / 位深非法 / 色彩模式非法 / 保留字段非 0 / 尺寸为 0 全部抛 `PsdDecodeError` 且不返回半截数据
- [x] E-17 修复：Duotone 的近似提示原先只在「存在双色调曲线数据」时才发出，逻辑反了，已改为无条件提示
- [x] E-18 端到端冒烟扩展到 8 种色彩模式：**131 项断言全通过**（元数据 + 字节级下载一致性）

---

## 泳道 F · 缺陷修复：预览渲染

- [x] F-1 **搭出真实 Canvas2D 渲染测试台**：用 `@napi-rs/canvas`(Skia) 注入 `document` / `ImageData`，
      让 `loadPsd → normalizeLayerTree → renderLayers` 整条链路能在 Node 里原样执行并逐像素比对。
      此前图层合成只被单元测试覆盖到「树结构/边界」层面，真正把像素画到画布上的那段从未被执行过 ——
      而这正是缺陷藏身之处。
- [x] F-2 新增 `frontend/test/render-pipeline.test.ts`（6 个用例）：合成图路径逐像素一致、
      逐层合成误差可接受、单层可见性、组内子层显隐生效、隐藏图层语义、切换显隐后退化渲染
- [x] F-3 素材生成器支持**隐藏图层**（flags bit1），新增素材 `sample-ui-hidden.psd`；
      合成图按 Photoshop 语义**排除隐藏图层**
- [x] F-4 修复真实缺陷：`renderLayers` / `canUseComposite` 原先用「所有图层都可见」判断能否走合成图，
      导致**任何含隐藏图层的 PSD 都被降级为逐层合成**，画面可能大面积丢失。
      改用新增的 `matchesOriginalVisibility`（判断用户是否改动过显隐）——
      PSD 自带合成图本就是 Photoshop 按可见图层烘焙的结果，天然满足
      「显示所有已显示的图层、忽略被隐藏的图层」

---

## 泳道 G · v2.0 技术路线调整：上传 PNG + 网盘链接

> **决策**：不再上传/托管 PSD，改为「上传 PNG 展示图 + 网盘分享链接」。
> 浏览与下载压力从"几百 MB 的源文件"降到"几百 KB 的图片"；源文件交给网盘，站内只做展示与跳转。

- [x] G-1 冻结 v2.0 契约：`Project.preview` → **`image`（必填）**、`Project.psd` → **`source`**（网盘信息）
- [x] G-2 新增 `GET /api/projects/:id/go` 做 302 跳转并计下载 —— 直接放外链就统计不到点击量
- [x] G-3 契约 §6 定义网盘识别表（百度/阿里/夸克/123/蓝奏/微云/城通/OneDrive/Google Drive/MEGA/Dropbox + 其它）
- [x] G-4 移除 v1 的 PSD 端点（`/files/psd`、`/files/preview`、`POST /:id/preview`），并断言其返回 404
- [x] G-5 后端：PNG 校验（魔数）、图片下发、网盘识别模块、`provider` 过滤、上传上限降到 20 MB
- [x] G-6 前端：上传页改为 PNG + 网盘表单；详情页去掉 PSD 预览 tab，新增网盘卡片（提取码一键复制）
- [x] G-7 图库卡片增加网盘来源徽标；`image` 必填后取消"无预览图"占位分支
- [x] G-8 重写演示数据与冒烟脚本为 v2.0（`tools/seed-demo.mjs`、`tools/smoke-e2e.mjs`）
- [x] G-9 **PSD 相关代码保留在仓库但不接入**（`frontend/src/psd/**`、`PsdViewer`/`LayerPanel`/`PsdInfoPanel`、
      `backend/src/lib/psdHeader.ts`），文档注明为技术存档
- [x] G-10 重新部署到 7thcv.cn:4100 并完成线上端到端验证

### v2.0 验证记录

| 项 | 结果 |
| --- | --- |
| 后端 `typecheck` / `build` | 退出码 0 |
| 后端 `test` | **158 / 158 通过**（`api` 73 + `jsonStore` 25 + `netdisk` 38 + 保留的 `psdHeader` 22） |
| 前端 `typecheck` / `build` | 退出码 0 |
| 前端 `test` | **120 / 120 通过**（含未改动的 `decode` / `render-pipeline` 保留了 PSD 模块的回归） |
| 前端产物体积 | JS **716 KB → 372 KB（−46.8%）**，`ag-psd` / `8BPS` 已从产物消失 |
| `npm run smoke`（本地） | **135 项断言全通过** |
| 线上 `7thcv.cn:4100` | **135 项断言全通过**；`/go` 302 跳转 + 计数、PSD 端点 404、网盘识别 16 例全对 |
| 现有站点 | `7thcv.cn`、`christmaslink.7thcv.cn` **未受影响** |

> 部署过程中灌演示数据时**真的触发了限流（429）**——这恰好反证了限流在工作；等一个窗口期后重跑即补齐。

---

## 泳道 H · v2.1 接入主站登录系统

> **需求**：只有主站（柒世纪视频组，`7thcv.cn`）**在册的登录用户**才能上传作品，且**作者名取用户名**。
> **决策**：① 挂到 `https://7thcv.cn/psd/`（同源 HTTPS，复用主站证书，不改 DNS）；② **不共享主站 JWT 密钥**，改为把令牌转发给主站的成员专属接口校验；③ 保留 `UPLOAD_TOKEN` 作为自动化旁路。

- [x] H-1 侦察主站认证实现（Go + Echo + JWT/HS256；`cn` = 用户名，`is_member` = 成员标记；无「查当前用户」接口）
- [x] H-2 冻结契约 v2.1：新增 §8 认证与授权，扩充错误码（`NOT_A_MEMBER` / `UPSTREAM_UNAVAILABLE`）
- [x] H-3 后端：`mainSite.ts`（代登录 + 令牌校验 + 未验签读 `cn`）、`/api/auth/login`、`/api/auth/me`
- [x] H-4 后端：上传中间件 —— 令牌旁路 → 登录校验 → **author 强制取 `cn`**
- [x] H-5 后端：`MOUNT_PREFIX` 支持（挂子路径，根路径 302 到前缀）
- [x] H-6 前端：登录页、登录态管理（`localStorage` + 启动时 `/api/auth/me` 恢复）、页头登录状态
- [x] H-7 前端：上传页未登录时引导登录；已登录时作者名只读且预填 `cn`
- [x] H-8 前端：支持 `VITE_BASE_PATH=/psd/` 构建与路由 `basename`
- [x] H-9 Dockerfile 构建参数 `VITE_BASE_PATH` / `VITE_API_BASE` + compose 透传
- [x] H-10 服务器 `.env` 写入 v2.1 配置（含备份）
- [x] H-11 幂等的 nginx 挂载脚本 `deploy/scripts/install-nginx-psd-route.sh`（备份 + `nginx -t` + 失败回滚 + 主站自检）
- [x] H-12 部署并端到端验证：登录 → 上传（author = 用户名）→ 未登录被拒 → 令牌旁路仍可用 → 主站未受影响

### v2.1 验证记录

| 项 | 结果 |
| --- | --- |
| 后端 `typecheck` / `build` | 退出码 0 |
| 后端 `test` | **204 / 204 通过**（新增 46 条登录/授权用例，全程只打本地假主站，不碰真实站点） |
| 前端 `typecheck` / `build` | 退出码 0；两种基路径（`/` 与 `/psd/`）构建均验证资源前缀正确切换 |
| 前端 `test` | **162 / 162 通过** |
| 线上 `https://7thcv.cn/psd/` | **145 项断言全通过**（且是对**已有 7 条数据**的站点、在**生产限流配置**下跑通） |
| 关键语义（线上实测） | 无凭据上传 401 · 错误口令 401「用户名或密码错误」（链路通） · 伪造签名令牌 401（主站裁决） · 未配置主站时失败关闭 502 · 令牌旁路 author 取表单值 |
| 主站 | `https://7thcv.cn/`、`christmaslink.7thcv.cn` 均正常，**现有站点功能未受影响** |

### 过程中修复的缺陷
1. **`static.ts` 用 `req.originalUrl` 取路径** → 在 `MOUNT_PREFIX` 下 `/psd/assets/*`、`/psd/`、SPA 回退全都会误落 index.html。改用剥离后的 `req.url`（子代理实测发现）。
2. **`/api/auth/me` 与登录共用 10 次/分钟的严格限流桶** → `/me` 每次刷新页面都会调用，NAT 出口或多标签页会被误伤。已改为只给 `/auth/login` 挂严格限流（我复核时发现并修正）。
3. **冒烟脚本无法对非空站点运行** → 原先硬编码 `total === 1`、`标签计数 === 1`，遇到线上已有演示数据就全线失败；已改为「本次运行唯一标识 + 基线相对计数」。
4. **冒烟脚本忽略上传限流** → 连续上传 20+ 次会撞 30 次/分钟的上限，把「限流正常工作」误报成功能失败；已加入限流窗口等待。

### ⚠️ 顺带发现的安全问题（未擅自修改主站代码）
主站的 JWT 签名密钥**硬编码在源码里**（`controllers/auth_controller.go` 里的 `var jwtSecret = []byte("...")`，
本文档不复制该值）。任何拿到源码或二进制的人都能伪造**任意成员**的令牌（含 `is_member: true`）。
建议改为从环境变量读取。本项目按 v2.1 决策**不共享该密钥**，因此我们的服务即使被攻破也无法伪造主站身份。

---

## 尚未纳入本次范围（后续可扩展）
- [x] ~~用户账号体系与权限（当前用 `UPLOAD_TOKEN` / `ADMIN_TOKEN` 单令牌方案）~~ → 已由泳道 H 接入主站账号体系
- [ ] PSD 图层回填 `layerCount` 到后端（当前后端固定 `null`，前端解析后仅本地展示）
- [ ] 服务端渲染缩略图（当前由浏览器端合成，避免引入原生 canvas 依赖）
- [ ] 对象存储直传（前端签名直传 S3/OSS，跳过应用服务器）
- [ ] 版本历史与工程多版本对比
- [ ] 全文检索升级为 SQLite FTS5 或 Postgres（当前为 JSON 库 + 内存过滤）
