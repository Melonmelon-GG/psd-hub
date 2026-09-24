# PSD 展示台 · API 契约（v2.1 · 冻结）

> 本文件是前后端唯一接口真相来源（single source of truth）。
> 后端实现 `backend/`，前端实现 `frontend/`，任何一方都不得单方面偏离本契约。
> 变更流程：先改本文件 → 再改两端代码。

## 变更记录

| 版本 | 变更 |
| --- | --- |
| v1 | 初版：上传 PSD + PNG，浏览器端解析 PSD 做图层预览，自己下发 PSD 文件流 |
| v1.1 | `PsdFileInfo` 增加 `version` / `channels` / `hasAlpha`；修正色彩模式编码 7 的名称为 `Multichannel` |
| **v2.0** | **技术路线调整**：不再上传/托管 PSD，改为「**上传 PNG + 网盘分享链接**」。`preview` → `image`（必填），`psd` → `source`（网盘信息）；移除全部 PSD 相关端点，新增 `GET /api/projects/:id/go` 跳转计数。详见附录 A 的归档说明。 |
| **v2.1** | **接入主站登录系统**：复用 `7thcv.cn` 的账号体系（JWT）。新增 `POST /api/auth/login`、`GET /api/auth/me`；上传改为**需登录且为社团成员**，作者名强制取令牌里的 `cn`；新增 `MOUNT_PREFIX` 以挂到 `/psd/` 子路径。详见 §8。 |

---

## 0. 通用约定

### 0.1 基础信息

| 项 | 值 |
| --- | --- |
| API 前缀 | `/api` |
| 传输格式 | JSON（`Content-Type: application/json; charset=utf-8`） |
| 文件上传 | `multipart/form-data` |
| 时间格式 | ISO 8601 UTC，例：`2026-02-14T08:31:05.123Z` |
| 字符集 | 全链路 UTF-8（含中文文件名、中文说明） |
| 图片格式 | **仅 PNG**（v2.0 起不再接受 PSD） |
| 前端默认基址 | 同源（`VITE_API_BASE` 为空）；开发态由 Vite 代理 `/api` → `http://localhost:4000` |

### 0.2 错误响应（统一信封）

所有非 2xx 响应体一律为：

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "面向用户的中文可读信息",
    "details": { "field": "title", "reason": "标题不能为空" }
  }
}
```

`details` 可选。`code` 取值表：

| code | HTTP | 含义 |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | 参数/表单校验失败（含网盘链接格式非法） |
| `UNAUTHORIZED` | 401 | 未登录 / 令牌无效；或缺少、错误的 `x-upload-token` / `x-admin-token` |
| `NOT_A_MEMBER` | 403 | 账号有效但不是社团成员（v2.1 上传要求成员身份） |
| `NOT_FOUND` | 404 | 项目或文件不存在 |
| `METHOD_NOT_ALLOWED` | 405 | 方法不允许 |
| `DUPLICATE` | 409 | 同一张 PNG（sha256 相同）已存在 |
| `PAYLOAD_TOO_LARGE` | 413 | 超过 `MAX_UPLOAD_MB` |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 扩展名或文件头不是 PNG |
| `RATE_LIMITED` | 429 | 触发限流，响应含 `Retry-After` 头 |
| `INTERNAL` | 500 | 服务端异常（不泄漏堆栈到响应体） |
| `UPSTREAM_UNAVAILABLE` | 502 | 主站登录/校验接口不可达或超时（v2.1） |

### 0.3 鉴权

**v2.1 起上传需要登录**，登录复用主站 `7thcv.cn` 的账号体系（见 §8）。
两类令牌仍然保留，均为**可选配置**：

| 凭据 | HTTP 头 | 保护的操作 | 说明 |
| --- | --- | --- | --- |
| 登录令牌 | `Authorization: <JWT>`（`Bearer ` 前缀可选） | `POST /api/projects` | 必须是主站签发的有效令牌且 `is_member === true` |
| 上传令牌 | `x-upload-token: <token>` | `POST /api/projects` | **自动化旁路**，仅在服务端配置了 `UPLOAD_TOKEN` 时生效；清空该变量即关闭 |
| 管理令牌 | `x-admin-token: <token>` | `PATCH` / `DELETE` | 与上传令牌相互独立 |

前端通过 `GET /api/config` 得知服务端是否要求令牌与是否启用登录，未要求时不要发送空令牌头。

### 0.4 列表分页信封

```json
{ "items": [ /* Project[] */ ], "total": 137, "page": 1, "pageSize": 12, "totalPages": 12 }
```

---

## 1. 数据模型

### 1.1 `Project`

```ts
interface Project {
  id: string;                 // 形如 "prj_9f2c1ab73d4e"（小写十六进制，永久不变）
  title: string;              // 1..120 字符
  description: string;        // 0..5000 字符，允许换行（纯文本渲染，不解析 Markdown）
  author: string;             // 0..60 字符，缺省为 "匿名作者"
  tags: string[];             // 0..12 个，每个 1..24 字符
  createdAt: string;          // ISO 8601
  updatedAt: string;          // ISO 8601
  image: ImageInfo;           // 必有：展示用 PNG
  source: NetdiskSource;      // 必有：网盘分享信息
  stats: { views: number; downloads: number };
}
```

### 1.2 `ImageInfo`

```ts
interface ImageInfo {
  fileName: string;           // 原始文件名，例 "深色UI稿.png"
  size: number;               // 字节
  sha256: string;             // 小写十六进制，用于去重
  width: number | null;       // 从 PNG IHDR 解析
  height: number | null;
  url: string;                // "/api/projects/<id>/files/image"
  downloadUrl: string;        // "/api/projects/<id>/files/image?download=1"
}
```

> v2.0 起 **`image` 是必填**：没有 PNG 的工程无法创建（旧版允许无预览图，现已取消）。

### 1.3 `NetdiskSource`

```ts
type NetdiskProvider =
  | 'baidu' | 'aliyun' | 'quark' | '123pan' | 'lanzou' | 'weiyun' | 'ctfile'
  | 'onedrive' | 'googledrive' | 'mega' | 'dropbox' | 'other';

interface NetdiskSource {
  provider: NetdiskProvider;  // 由服务端按 §6 的规则从 URL 主机名识别
  providerLabel: string;      // 中文展示名，服务端算好（如 "百度网盘" / "其它链接"）
  url: string;                // 分享链接，http/https，长度 ≤ 500
  extractCode: string | null; // 提取码，长度 ≤ 16；无则 null
  fileName: string | null;    // 网盘里那个源文件的文件名（≤ 200），便于展示
  note: string | null;        // 备注（≤ 200），如 "含分层源文件"
}
```

> `provider` 与 `providerLabel` **以服务端返回为准**。前端可自行做一次本地识别用于表单即时反馈，但必须以上传/查询响应里的值为最终结果。

---

## 2. 端点总览

| # | 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | GET | `/api/health` | — | 存活探针 |
| 2 | GET | `/api/config` | — | 公开运行时配置 |
| 3 | GET | `/api/projects` | — | 项目列表（搜索/排序/分页） |
| 4 | GET | `/api/projects/tags` | — | 标签聚合 |
| 5 | GET | `/api/projects/:id` | — | 项目详情（默认计一次浏览） |
| 6 | POST | `/api/projects` | 上传令牌 | 新建项目（上传 PNG + 网盘链接） |
| 7 | PATCH | `/api/projects/:id` | 管理令牌 | 修改文本字段与网盘信息 |
| 8 | DELETE | `/api/projects/:id` | 管理令牌 | 删除项目及其图片 |
| 9 | GET | `/api/projects/:id/files/image` | — | PNG 字节（`?download=1` 强制附件） |
| 10 | **GET** | **`/api/projects/:id/go`** | — | **302 跳转到网盘链接，并计一次下载** |

**路由顺序注意**：`/api/projects/tags` 必须注册在 `/api/projects/:id` **之前**，否则 `tags` 会被当作 id。

---

## 3. 端点详细定义

### 3.1 `GET /api/health`

200：`{ "ok": true, "name": "psd-hub-api", "version": "2.0.0", "uptimeMs": 12345, "time": "..." }`

### 3.2 `GET /api/config`

前端启动时调用一次，用于渲染上传限制提示、显隐令牌输入框。

```json
{
  "name": "psd-hub",
  "version": "2.1.0",
  "maxUploadBytes": 20971520,
  "maxUploadLabel": "20 MB",
  "acceptedImageTypes": ["image/png"],
  "acceptedImageExtensions": [".png"],
  "uploadTokenRequired": false,
  "adminTokenRequired": false,
  "extractCodeMaxLength": 16,
  "netdiskUrlMaxLength": 500,
  "loginEnabled": true,
  "mountPrefix": "/psd"
}
```

| v2.1 新增字段 | 含义 |
| --- | --- |
| `loginEnabled` | 服务端是否配置了主站地址（即是否要求登录）。为 `false` 时前端退回「上传不校验」的旧行为（本地开发用） |
| `mountPrefix` | 应用被挂载的子路径前缀（如 `/psd`）；未挂子路径时为空字符串 |

> v2.0 起默认上传上限降到 **20 MB**（只传 PNG，不再是几百 MB 的 PSD）。

### 3.3 `GET /api/projects`

Query 参数（非法值按默认处理，宽容解析）：

| 参数 | 类型 | 默认 | 约束 |
| --- | --- | --- | --- |
| `q` | string | — | 模糊匹配 title / description / author / tags / image.fileName / source.fileName |
| `tag` | string | — | 精确匹配标签 |
| `author` | string | — | 作者精确匹配 |
| `provider` | string | — | 按网盘类型过滤（`baidu` / `quark` …） |
| `sort` | enum | `newest` | `newest` \| `oldest` \| `title` \| `downloads` \| `views` |
| `page` | int | `1` | ≥ 1 |
| `pageSize` | int | `12` | 1..48 |

200 → 分页信封（§0.4）。

### 3.4 `GET /api/projects/tags`

200：`{ "tags": [ { "name": "UI", "count": 12 } ] }`（按 count 降序，其次 name 升序）

### 3.5 `GET /api/projects/:id`

Query：`count`（默认 `1`）= `0` 时不增加浏览计数。

200：`{ "item": Project }`；404：`NOT_FOUND`。

### 3.6 `POST /api/projects`

`Content-Type: multipart/form-data`

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `image` | file | ✅ | 扩展名 `.png`，文件头必须为标准 PNG 魔数 `89 50 4E 47 0D 0A 1A 0A` |
| `netdiskUrl` | text | ✅ | `http://` 或 `https://` 开头，长度 ≤ 500 |
| `title` | text | ✅ | trim 后 1..120 字符 |
| `description` | text | ❌ | 0..5000 字符 |
| `author` | text | ❌ | 0..60 字符，空则为 `"匿名作者"` |
| `tags` | text | ❌ | 逗号分隔（`,` `，` 均可）或重复字段多次出现，两形式都要支持并合并 |
| `extractCode` | text | ❌ | 0..16 字符，trim 后为空则存 `null` |
| `sourceFileName` | text | ❌ | 0..200 字符，空则 `null` |
| `sourceNote` | text | ❌ | 0..200 字符，空则 `null` |
| `allowDuplicate` | text | ❌ | `"1"` / `"true"` 时跳过 sha256 去重检查 |

行为：

1. 校验令牌（若配置）。
2. 校验字段与 PNG 文件头；失败即 `400/415`，并删除已落盘的临时文件。
3. 计算 PNG 的 sha256。若已存在同 sha256 的工程且未给 `allowDuplicate` → `409 DUPLICATE`，`details.existingId` = 已存在项目 id。
4. 解析 PNG IHDR 得到宽高。
5. 按 §6 从 `netdiskUrl` 识别 `provider` 与 `providerLabel`。
6. 落盘、写库，返回 201。

201：`{ "item": Project }`

### 3.7 `PATCH /api/projects/:id`

`Content-Type: application/json`，body 为 `Project` 的可改子集：

```json
{
  "title": "新标题",
  "description": "新说明",
  "author": "作者",
  "tags": ["UI"],
  "netdiskUrl": "https://pan.baidu.com/s/xxxx",
  "extractCode": "abcd",
  "sourceFileName": "深色UI稿.psd",
  "sourceNote": "含分层源文件"
}
```

未出现的字段保持不变。**`netdiskUrl` 若被修改，必须重新识别 `provider` / `providerLabel`。** `updatedAt` 刷新。

200：`{ "item": Project }`

### 3.8 `DELETE /api/projects/:id`

204，无响应体。幂等：对不存在的 id 也返回 204。

### 3.9 `GET /api/projects/:id/files/image`

| Query | 行为 |
| --- | --- |
| 无 | `Content-Type: image/png`，inline，长缓存 |
| `download=1` | `Content-Disposition: attachment; filename="..."; filename*=UTF-8''...` |

响应头必须包含 `ETag`、`Last-Modified`、`Accept-Ranges: bytes`、`Content-Length`，支持 `Range`（206）与 `If-None-Match`（304）。
缓存策略：`Cache-Control: public, max-age=31536000, immutable`（内容不可变，id 变化即换 URL）。

> **本端点不计入 `stats.downloads`。** 语义上「下载」指的是用户拿走**源文件**，
> 而那一步统一由 §3.10 的 `/go` 计数。本端点只是把展示图本身给到用户（含「另存图片」），
> 重复请求它不该被当成一次「下载作品」。

### 3.10 `GET /api/projects/:id/go` ← v2.0 新增

把用户送到网盘链接，同时把下载计数 +1。

行为：
1. 查项目；不存在 → 404 `NOT_FOUND`。
2. `stats.downloads` +1 并持久化。
3. 返回 **302**，`Location` 为 `source.url`。

响应头必须包含 `Cache-Control: no-store`（避免中间层缓存跳转导致计数失真）。

> 为什么不让前端直接放外链：那样服务端无法统计下载次数，也无法在链接失效时统一给用户提示。所有对外跳转都应经过本端点。

---

## 4. 文件与目录布局（运行时）

```
<DATA_DIR>/
├─ db.json                     # 元数据库（原子写 + 写队列）
├─ projects/
│  └─ <id>/
│     ├─ image.png             # 展示用 PNG（保留原始字节）
│     └─ meta.json             # 单项目快照
└─ tmp/                        # multer 临时目录，崩溃后可安全清空
```

`db.json` 结构：`{ "version": 2, "updatedAt": "...", "projects": [ /* Project[] */ ] }`

> v2.0 的 `projects/<id>/` 下**不再有 PSD 文件**（`original.psd` / `preview.png` 已废弃）。

---

## 5. 前端拼接规则

```ts
const base = import.meta.env.VITE_API_BASE ?? '';       // 生产留空 = 同源
const url = (p: string) => `${base.replace(/\/$/, '')}${p}`; // p 以 "/" 开头
```

- `Project.image.url` → `<img src>`。
- `Project.image.downloadUrl` → `<a download>` 的 href。
- **网盘下载按钮** href = `url('/api/projects/<id>/go')`，用普通 `<a>`（或 `window.open`），**不要用 fetch**，否则 302 跳转不会生效。
- 大图列表用 `loading="lazy"`。

---

## 6. 网盘识别规则

服务端按下表顺序匹配 `netdiskUrl` 的**主机名**（大小写不敏感，忽略 `www.` 前缀）；都不匹配则为 `other`。
匹配项与中文展示名：

| provider | 主机名（任一即可） | providerLabel |
| --- | --- | --- |
| `baidu` | `pan.baidu.com`、`yun.baidu.com` | 百度网盘 |
| `aliyun` | `aliyundrive.com`、`alipan.com` | 阿里云盘 |
| `quark` | `pan.quark.cn` | 夸克网盘 |
| `123pan` | `123pan.com`、`123684.com`、`123865.com`、`123912.com` | 123 云盘 |
| `lanzou` | `lanzou*.com`、`lanzoui.com`、`lanzoux.com`、`lanzoub.com`、`lanzoue.com`、`lanzouw.com`、`lanzoup.com`、`lanzouo.com` | 蓝奏云 |
| `weiyun` | `weiyun.com` | 腾讯微云 |
| `ctfile` | `ctfile.com`、`545c.com` | 城通网盘 |
| `onedrive` | `1drv.ms`、`onedrive.live.com`、`sharepoint.com` | OneDrive |
| `googledrive` | `drive.google.com`、`docs.google.com` | Google Drive |
| `mega` | `mega.nz`、`mega.io` | MEGA |
| `dropbox` | `dropbox.com`、`db.tt` | Dropbox |
| `other` | （兜底） | 其它链接 |

主机名匹配需**按后缀判断**，防止 `pan.baidu.com.evil.com` 这类伪装被识别为百度网盘（须命中完整主机名或以 `.` 结尾锚定）。

---

## 7. 兼容性说明

- 所有列表接口对未知 query 参数保持沉默（忽略）。
- 后端不解析 Markdown，`description` 以 `white-space: pre-wrap` 原样渲染。
- 网盘链接一律不做可用性探测（不发起外网请求），只做格式与主机名校验。

---

## 8. 认证与授权（v2.1）

平台**不自建账号体系**，复用主站 `https://7thcv.cn` 的登录系统
（JWT / HS256，`POST /api/login`，载荷含 `cn` 与 `is_member`，有效期 24 小时）。

**只有已登录且为社团成员的用户才能上传作品**；作品作者名一律取自令牌里的 `cn`，
客户端无法自行指定 —— 这样「以用户名为作者名」就是不可伪造的。

### 8.1 `POST /api/auth/login`

请求体 `application/json`：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `cn` | ✅ | 用户名（主站的 `cn`） |
| `password` | ✅ | 密码 |

行为：本服务把凭据**转发**给主站 `POST {MAIN_SITE_BASE_URL}/api/login`，
成功后把令牌原样返回给前端。**本服务不保存密码、不写日志、不落库。**

200：

```json
{ "token": "<JWT>", "cn": "张三", "isMember": true, "expiresInSeconds": 86400 }
```

| 情形 | HTTP | code |
| --- | --- | --- |
| 用户名或密码错误 | 401 | `UNAUTHORIZED` |
| 凭据为空 / 字段缺失 | 400 | `BAD_REQUEST` |
| 账号有效但不是社团成员 | 403 | `NOT_A_MEMBER` |
| 主站不可达或超时 | 502 | `UPSTREAM_UNAVAILABLE` |

### 8.2 `GET /api/auth/me`

请求头 `Authorization: <JWT>`（`Bearer ` 前缀可选）。用于前端刷新页面后恢复登录态。

- 200：`{ "cn": "张三", "isMember": true }`
- 401 `UNAUTHORIZED`：令牌缺失、无效或已过期
- 403 `NOT_A_MEMBER`：令牌有效但不是社团成员

### 8.3 上传鉴权（`POST /api/projects`）

按以下顺序判定：

1. 若服务端配置了 `UPLOAD_TOKEN`，且请求带 `x-upload-token` 与之匹配 → **通过**。
   这是给 CI 与部署脚本保留的**自动化旁路**，`author` 取表单里的值。清空该环境变量即可关闭。
2. 否则要求 `Authorization` 携带有效主站令牌且 `is_member === true` → 通过。
   **`author` 强制取令牌里的 `cn`，忽略表单里的同名字段。**
3. 两者都没有 → 401 `UNAUTHORIZED`。

**校验方式**：把令牌转发给主站一个**成员专属**接口
（默认 `GET {MAIN_SITE_BASE_URL}{MAIN_SITE_VERIFY_PATH}`，`MAIN_SITE_VERIFY_PATH` 默认 `/api/kb/tree`）。
200 → 通过；401 → 令牌无效；403 → 不是成员。

> 本服务**不持有主站的 JWT 签名密钥**，因此无法伪造任何人的身份。
> 代价是每次上传会多一次到主站的校验请求（上传是低频操作，可以接受）；
> 主站不可达时上传会以 `UPSTREAM_UNAVAILABLE` 失败，而不是放行。

### 8.4 挂载前缀 `MOUNT_PREFIX`

为了与主站**同源部署**在 `https://7thcv.cn/psd/`（这样才能安全地处理登录密码），
服务端支持 `MOUNT_PREFIX`（例：`/psd`）：

- 所有请求先剥掉该前缀再进入路由（`/psd/api/projects` → `/api/projects`）
- 静态资源与 SPA 回退同理由此前缀下提供
- 设置后访问根 `/` 会 302 跳到 `{MOUNT_PREFIX}/`

前端相应地把 Vite `base` 设为 `/psd/`、`VITE_API_BASE` 设为 `/psd`。
未设置 `MOUNT_PREFIX` 时行为与 v2.0 完全一致（挂在根）。

---

## 附录 A · v1 已归档端点（当前**不再提供**）

v2.0 起不再上传或托管 PSD，以下端点在服务端**已移除**（请求会落到 404 JSON 信封）：

| 方法 | 路径 | 原用途 |
| --- | --- | --- |
| GET | `/api/projects/:id/files/psd` | 下发 PSD 原始字节（含 Range） |
| GET | `/api/projects/:id/files/preview` | 下发预览 PNG |
| POST | `/api/projects/:id/preview` | 替换预览 PNG |

`POST /api/projects` 这个**路径本身仍然存在**（现在是上传 PNG），因此带着旧的 `psd` 字段去调用它
不会得到 404，而是 **400 `BAD_REQUEST`**（未知的上传字段）。这是刻意的：路径还在，只是字段换了。

与之配套的前端能力（浏览器端 PSD 解析、图层树、自研多色彩模式解码器）**代码仍保留在仓库中但不再接入**
（见 `frontend/src/psd/**`、`frontend/src/components/PsdViewer.tsx` 等），
文档见 `docs/COLOR-MODES.md`。若将来需要恢复在线预览，按该文档的结论接回即可。
