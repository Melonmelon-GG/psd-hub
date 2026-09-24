# 架构说明 · PSD 展示台

> ## ⚠️ v2.0 路线变更说明（先读这段）
>
> 本文的 §1–§3 以及 §2.2「在线预览」描述的是 **v1 路线**：上传 PSD、在浏览器里解析并做图层预览、
> 由服务端下发 PSD 文件流。
>
> **v2.0 起路线改为「上传 PNG + 网盘分享链接」**：站内只托管展示用 PNG，源文件交由网盘托管，
> 下载按钮走 `GET /api/projects/:id/go` 做 302 跳转并计点击量。请按下表对照阅读：
>
> | 本文中的描述 | v2.0 现状 |
> | --- | --- |
> | `Project.preview`（可选）/ `Project.psd` | → `Project.image`（**必填**）/ `Project.source`（网盘信息） |
> | §2.1 上传时在浏览器里合成缩略图 | **不再需要** —— 上传的就是图片本身 |
> | §2.2 浏览器解析 PSD、图层树、双引擎 | **不接入**（代码保留，见下） |
> | §2.3 服务端下发 PSD（Range/ETag） | 改为下发 PNG；PSD 相关端点已移除 |
> | §3 目录布局里的 `original.psd` / `preview.png` | 只剩 `image.png` + `meta.json` |
> | 「色彩模式支持矩阵」整节 | **技术存档** —— 当前路线不解析 PSD，该能力不参与运行 |
>
> **保留但不接入的代码**（仍可编译、测试仍全绿、无生产引用、不进前端产物）：
> `frontend/src/psd/**`、`frontend/src/components/{PsdViewer,LayerPanel,PsdInfoPanel}.tsx`、
> `backend/src/lib/psdHeader.ts`。技术存档见 [COLOR-MODES.md](./COLOR-MODES.md)，当前契约见 [API.md](./API.md)。
>
> §4「关键设计决策」、§5 安全、§6 扩容、§7 部署形态、§8 测试策略**仍然适用**。

---

本文记录系统的整体结构、关键数据流，以及那些"看起来可以更简单但故意没这么做"的决策。

---

## 1 · 总览

```
                      ┌──────────────────────────────────────┐
   浏览器              │  前端 SPA（Vite + React 19）          │
   ─────────           │                                      │
                       │  /            图库（卡片网格）        │
   ①  页面 + 资源       │  /p/:id       详情（PNG + 说明 + 下载）│
   ◄───────────────────┤                + 交互式 PSD 预览      │
                       │  /upload      上传（拖拽 + 进度）      │
                       │                                      │
                       │  src/psd/  ← ag-psd + Canvas 合成     │
                       └───────────────┬──────────────────────┘
                                       │ ② /api/*（同源或 VITE_API_BASE）
                                       ▼
                       ┌──────────────────────────────────────┐
                       │  后端 API（Express 5 + TypeScript）   │
                       │                                      │
                       │  routes/     health · config ·        │
                       │              projects · files         │
                       │  middleware/ 鉴权 · 限流 · 错误信封    │
                       │  store/      JSON 元数据库（原子写）   │
                       │  storage/    文件存储抽象              │
                       │  static.ts   生产模式下托管前端产物    │
                       └───────┬──────────────────┬───────────┘
                               │                  │
                    ③ 元数据    │                  │ ④ PSD / PNG 字节
                               ▼                  ▼
                       ┌──────────────┐   ┌──────────────────────┐
                       │  db.json     │   │  projects/<id>/      │
                       │  （单文件）   │   │    original.psd      │
                       └──────────────┘   │    preview.png       │
                                          │    meta.json         │
                                          └──────────────────────┘
                                          （本地磁盘，或 S3/OSS）
```

单进程部署（`SERVE_STATIC=true`）时，前端产物由后端一起托管，**一个端口提供全部内容**，
省掉跨域、省掉独立的静态服务器。

---

## 2 · 三条关键数据流

### 2.1 上传（含"没有 Photoshop 也能有预览图"）

```
用户选择 PSD
   │
   ├─► 浏览器读取为 ArrayBuffer ──► ag-psd readPsd ──► 图层树 + 合成图
   │                                                        │
   │                                          renderLayers  │ 逐层合成
   │                                                        ▼
   │                                            canvas.toBlob('image/png')
   │                                                        │
   ▼                                                        ▼
 表单（标题/说明/作者/标签）  ──────────►  FormData { psd, preview, ... }
                                                        │
                                          XMLHttpRequest（真实进度）
                                                        │
                                                        ▼
                              POST /api/projects  （multipart）
                                                        │
   后端：校验令牌 → 校验扩展名与文件头（8BPS / PNG 魔数）→ 流式算 sha256
        → 查重（同 sha256 → 409 + existingId）
        → 解析 PSD 头 26 字节拿宽/高/色彩模式/位深
        → 落盘 <DATA_DIR>/projects/<id>/{original.psd, preview.png, meta.json}
        → 写 db.json（原子替换）
        → 201 { item }
```

要点：**缩略图在浏览器端合成**。这样后端不需要 `node-canvas` / `sharp` 之类的原生依赖，
`npm install` 在任何平台都能一次装成。用户也可以在界面上用自己指定的 PNG 覆盖自动生成的结果。

### 2.2 在线预览（PSD → 可交互画布）

```
GET /api/projects/:id/files/psd      ← inline，不计下载数
   │
   ▼  ArrayBuffer
ag-psd readPsd(buffer, { useImageData: false, skipThumbnail: true })
   │
   ├─ psd.canvas        PSD 自带的合成图（若有）
   └─ psd.children[]    图层树：name / left / top / right / bottom /
                        opacity(0..1) / hidden / blendMode / clipping / children[]
   │
   ▼  normalizeLayerTree()  ← 规整成稳定 id 的 LayerNode 树
   │
   ▼  用户切换显隐 / 缩放平移
renderLayers(tree, { visibility, compositeCanvas, forceLayerRender })
   │
   ├─ 快速路径：全部图层可见 且 有合成图 → 直接 drawImage 合成图
   │            （最准确，含 Photoshop 自己的图层样式与调整层结果）
   └─ 逐层路径：自底向上 drawImage，
                每层设 globalAlpha = opacity、
                globalCompositeOperation = mapBlendMode(blendMode)；
                组图层先渲染到离屏 canvas 再整体合成
```

### 2.3 下载

```
<a href={url(item.psd.downloadUrl)} download>     ← 不用 fetch+blob，大文件不占内存
   │
   ▼
GET /api/projects/:id/files/psd?download=1
   │
   ├─ 支持 Range: bytes=0-  → 206 + Content-Range（断点续传 / 下载器多线程）
   ├─ 支持 If-None-Match    → 304
   ├─ Content-Disposition: attachment;
   │     filename="__UI_.psd"; filename*=UTF-8''%E6%B7%B1%E8%89%B2UI%E7%A8%BF.psd
   └─ 下载计数 +1
```

中文文件名走 RFC 5987 的 `filename*=UTF-8''`，并对纯 ASCII 回退名做降级，
避免老客户端把文件名变成乱码或直接截断。

---

## 3 · 数据模型

```ts
Project {
  id, title, description, author, tags[], createdAt, updatedAt,
  psd:     { fileName, size, sha256, width, height, colorMode, bitsPerChannel, layerCount,
             version, channels, hasAlpha, downloadUrl, streamUrl },
  preview: { fileName, size, width, height, source: 'uploaded'|'generated', url, downloadUrl } | null,
  stats:   { views, downloads }
}
```

`version` / `channels` / `hasAlpha` 是**颜色通道级元数据**（契约 v1.1 新增）：后端把文件头里
已经读到的通道数、版本一并暴露给前端，前端据此决定走哪条渲染路径、以及是否提示"近似预览"。
语义（尤其 `hasAlpha` 何时为 `null`）见 **[API.md §6](API.md)**，权威定义在那里，本文不复述。

完整字段语义、约束与错误码见 **[API.md](API.md)**——那是前后端唯一的接口真相来源。

磁盘布局：

```
<DATA_DIR>/
├─ db.json                       全部项目元数据（原子写 + 进程内串行写队列）
├─ projects/<id>/
│  ├─ original.psd | original.psb
│  ├─ preview.png                可缺省
│  └─ meta.json                  单项目快照，便于 rsync / 迁移
└─ tmp/                          multer 临时目录，崩溃后可安全清空
```

`db.json` 用「写临时文件 → fsync → rename 覆盖」保证原子性；所有写操作（含计数自增）
都排进同一个 Promise 队列，因此**并发上传不会损坏文件、也不会丢计数**。

---

## 4 · 关键设计决策

| 决策 | 为什么这么做 | 代价 |
| --- | --- | --- |
| **元数据用 JSON 文件而非数据库** | 零依赖、零运维，单机小规模完全够用；`npm install` 不会因为原生模块编译失败 | **只能单实例**；数据量大时全量载入内存 |
| **缩略图在浏览器端生成** | 避开 `node-canvas`/`sharp` 的原生编译地狱，跨平台安装零摩擦 | 依赖用户浏览器；无头/脚本上传时没有预览图（此时 `preview: null`，界面用占位图） |
| **前端用 ag-psd 现场解析 PSD** | 图层显隐切换必须拿到图层数据；服务端预渲染成图就失去交互性 | 大 PSD 会占用浏览器内存，解析在主线程（同步 API） |
| **`FileStorage` 抽象 + 本地驱动默认** | 单机部署最简单，切对象存储只改一个环境变量 | 需要自己迁移已有数据（见 DEPLOY §6） |
| **统一错误信封 + 中文 message** | 前端可以直接把 `message` 弹给用户，不需要维护一张错误码→文案的映射表 | 后端要负责文案（已约定不改） |
| **单令牌鉴权（`UPLOAD_TOKEN`/`ADMIN_TOKEN`）** | 需求是"上传/下载通道"，不是多租户 SaaS；令牌方案零依赖、五分钟就能上生产 | 没有账号体系、没有按用户隔离 |
| **前端手写 CSS，不用 UI 框架** | 这个界面结构不复杂，手写能让设计令牌集中可控，产物小、无版本漂移风险 | 组件要自己写（表单、模态、Toast、分页） |
| **裁剪图层与部分混合模式做近似** | Canvas 2D 没有这些概念，完整实现要自己写像素级合成器 | 预览与 Photoshop 在这些细节上会有差异（已在 UI 与文档中说明） |

---

## 色彩模式支持矩阵

> 本节标题刻意不带序号，因为 `README.md` 直接以锚点 `#色彩模式支持矩阵` 链接到这里。

网站上常见的 PSD 并不都是 RGB 8 位。下面这张表是**实测**结果，不是推断：三套实现互相交叉验证
（`ag-psd` 8bit / `ag-psd` 16bit / Pillow），本项目的自研解码器不自证正确性。

| 色彩模式 | ag-psd 8bit | ag-psd 16bit | Pillow（独立实现） | 前端采用的路径 |
| --- | --- | --- | --- | --- |
| RGB(3) | ✅ 逐像素一致 | ❌ RLE 路径按 1 字节/样本处理，会错位 | ✅ 一致 | 8bit 走 ag-psd；16bit 走自研解码 |
| Grayscale(1) | ✅ 一致 | 未验证 | ✅ 一致 | 走 ag-psd |
| Indexed(2) | ✅ 一致 | — | ✅ 一致 | 走 ag-psd |
| CMYK(4) | ❌ 抛 `Color mode not supported` | ❌ | ✅ MAE=0.00 | **自研解码** |
| Lab(9) | ❌ 抛错 | ❌ | 公式不同（Pillow 用简化换算，本项目按 ICC D50） | **自研解码** |
| Multichannel(7) | ❌ 抛错 | ❌ | 只读首通道（按灰度） | **自研解码（近似）** |
| Duotone(8) | ❌ 抛错 | ❌ | ✅（按灰度） | **自研解码（按灰度近似）** |

这张表就是**前端双引擎架构**与**后端暴露颜色通道级元数据**（契约 v1.1 的
`version` / `channels` / `hasAlpha`）的直接依据：前端必须先知道"这是哪种模式、几个通道"，
才能决定走 `ag-psd` 还是自研解码器；对 Multichannel 这类没有唯一正确解释的情况，
`hasAlpha: null` 让界面能诚实地标注"近似预览"，而不是断言一个可能错误的结果。

### 踩坑记录（由第三方实现交叉验证才暴露出来的真实缺陷）

1. **CMYK 存的是反相墨量**：PSD 里 `255 = 无墨`、`0 = 满墨`，与"直觉上的 255 = 最浓"正好相反。
   换成屏幕 sRGB 需要先反相再乘黑版：`R = round(S_C × S_K / 255)`（`S_C = 255 - C`，`S_K = 255 - K`）。
   早期按直读值换算会得到"负片效果"，且与 Pillow 的 MAE 立刻飙高——正是交叉验证抓到了它。
2. **Indexed 调色板是平面存放**：色彩模式表之后的 768 字节 = **256 个 R + 256 个 G + 256 个 B**
   三段平面连续存放，**不是** RGB 交错（`R0 G0 B0 R1 G1 B1 …`）。
   按交错读会让画面颜色完全错乱（往往还"看起来像有点对"），这一点也是靠 Pillow 逐像素比对才定位到。

### 验证手段

| 工具 | 作用 |
| --- | --- |
| `tools/verify-fixtures.mjs` | 结构校验 + 与 `ag-psd` 交叉比对每个素材（含 CMYK / Lab / Multichannel / Duotone / 16bit） |
| `tools/pillow-crosscheck.py` | Pillow 独立实现的逐像素交叉验证（MAE / 最大偏差），用于给自研解码器的色彩换算背书 |

两个工具分别由根目录的 `npm run verify:fixtures` 与 `npm run crosscheck` 调用；
素材缺失时自动 skip 而不是 fail（素材不进版本库，`npm run setup` 生成）。

---

## 5 · 安全考量

- **上传内容校验**：扩展名白名单 + 文件头魔数（PSD 必须是 `8BPS`，PNG 必须是标准魔数），
  不信 `Content-Type`。
- **路径穿越**：项目 id 由服务端生成的 12 位 hex 组成，落盘路径全部由服务端拼接，不采用任何用户输入。
- **鉴权**：令牌比较使用 `crypto.timingSafeEqual` 常量时间比较。
- **限流**：全局宽松限流 + 上传接口更严格限流，超限返回 `429` 并带 `Retry-After`。
- **错误信息**：`500` 只返回通用中文提示与 `x-request-id`，不泄漏堆栈；启动横幅只打印
  "令牌已启用/未启用"，**绝不打印令牌值**。
- **响应头**：`X-Content-Type-Options: nosniff`、`Referrer-Policy`、`X-Frame-Options`，
  反代层再加 HSTS。
- **systemd 加固**：`ProtectSystem=strict` + `ReadWritePaths` 精确授权，`NoNewPrivileges`、
  `PrivateTmp`、`SystemCallFilter=@system-service`。
- **容器**：以非 root 的 `node` 用户运行，`tini` 做 PID 1 以正确转发信号。

> 还**没有**做、但生产上值得补的：上传内容深度校验（PSD 结构完整解析）、
> 病毒扫描（ClamAV 挂载上传目录）、按 IP / 用户的配额、审计日志。

---

## 6 · 容量与扩容路径

当前架构的硬边界是**单实例**（JSON 元数据库 + 进程内写队列）。真实瓶颈通常按这个顺序出现：

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 内存随工程数增长 | `db.json` 全量载入内存 | 换 SQLite(SQLite WAL 单写) 或 Postgres |
| 单次上传耗内存 | 请求体 + 每项目元数据 | 限制并发上传、切对象存储、调大内存上限 |
| CPU 打满 | sha256 流式计算 + JSON 序列化 | 多实例（前提：先换掉元数据库与文件存储） |
| 磁盘满 | PSD 本体 | 切对象存储 / 冷数据归档 |

**扩容到多实例的正确顺序**：

1. `STORAGE_DRIVER=s3`，把 `FileStorage` 换到对象存储（接口已就绪，只需安装 `@aws-sdk/client-s3`）。
2. 把 `ProjectStore` 的实现从 `jsonStore.ts` 换成 Postgres / SQLite 版本
   （接口在 `backend/src/store/types.ts`，路由层不需要改动）。
3. 这时才可以把 PM2 改成 cluster、或起多个容器，前面挂 Nginx 做负载均衡。

---

## 7 · 部署形态对照

| 形态 | 命令 | 适用 |
| --- | --- | --- |
| 开发 | `npm run dev` | 本地开发，双进程 + Vite HMR |
| 单进程 | `npm run build && SERVE_STATIC=true npm start` | 最小生产形态、内网工具 |
| Docker Compose | `docker compose up -d --build` | 绝大多数 VPS（推荐） |
| Compose + Nginx | `docker compose --profile edge up -d` | 需要 HTTPS / 需要统一入口 |
| systemd | `systemctl enable --now psd-hub` | 不想装 Docker 的机器 |
| PM2 | `pm2 start deploy/pm2/ecosystem.config.cjs` | 已有 PM2 体系 |

详细步骤与排障见 **[DEPLOY.md](DEPLOY.md)**。

---

## 8 · 测试策略

| 层级 | 位置 | 覆盖内容 |
| --- | --- | --- |
| 后端单元 | `backend/test/psdHeader.test.ts` | PSD 头 26 字节解析、色彩模式/位深映射、魔数校验、**版本标签与 `baseChannelCount` / `deriveHasAlpha` 真值表** |
| 后端单元 | `backend/test/jsonStore.test.ts` | CRUD、模糊搜索、标签聚合、5 种排序、分页、**并发 50 次计数不丢**、**重启后颜色通道级元数据不丢（含老库补 null）** |
| 后端接口 | `backend/test/api.test.ts` | 真实 HTTP multipart：上传/去重/校验/列表/计数/Range/304/令牌/预览替换/SPA 回退；**四条返回 Project 的路径都带 `version`/`channels`/`hasAlpha`** |
| 前端单元 | `frontend/test/layerTree.test.ts` | 图层树规整、稳定 id、默认值、**组边界退化兜底** |
| 前端单元 | `frontend/test/blendModes.test.ts` | 全部 PSD 混合模式映射 + 未知值兜底 |
| 前端单元 | `frontend/test/fieldRules.test.ts` | 与服务端一致的本地校验与中文错误文案 |
| 前端单元 | `frontend/test/api.client.test.ts` | 错误信封 → `ApiError`、令牌头、`VITE_API_BASE` 拼接 |
| 前端集成 | `frontend/test/ag-psd.integration.test.ts` | `writePsd → readPsd` 往返 + **真实素材回归**（1200×800、中文图层名、图层组、screen 与 78% 不透明度） |
| 端到端 | `tools/smoke-e2e.mjs` | 66 项断言走真实 HTTP，可对线上环境执行 |

测试素材由 `tools/make-sample-psd.mjs` **手写 PSD 字节流**生成（零依赖），
并用 `tools/verify-psd.mjs` 拿 ag-psd 反向校验结构合法性——这既提供了稳定的回归基线，
也顺带证明了我们对 PSD 格式的理解是对的。

> 素材不进版本库（单个 PSD 19MB），`npm run setup` 会自动生成；
> 素材缺失时相关测试会 **skip 而不是 fail**，保证新克隆仓库也能跑通测试。
