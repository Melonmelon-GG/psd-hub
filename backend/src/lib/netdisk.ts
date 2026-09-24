/**
 * 网盘链接识别与校验（契约 §6）。
 *
 * 规则：按**主机名**匹配（大小写不敏感，忽略开头的 `www.`），
 * 命中即得 provider，都不命中则为 `other`（中文名"其它链接"）。
 *
 * 安全要点（务必保留）：
 * 匹配一律**按完整主机名或后缀锚定**——把主机名按 `.` 拆成候选后缀后做**相等比较**，
 * 绝不用 `host.includes('baidu.com')` 这类子串判断。
 * 否则 `pan.baidu.com.evil.com` 会被误判成百度网盘，攻击者只要注册一个域名
 * 就能让本站把它当成可信网盘链接展示（钓鱼/仿冒）。
 */
import { NETDISK_URL_MAX_LENGTH } from '../config.js';
import type { NetdiskProvider } from '../types.js';

/**
 * 中文展示名（契约 §6 表格右列，逐字一致）。
 * 前端不得自行拼装，一律以服务端返回值 `NetdiskSource.providerLabel` 为准。
 */
export const NETDISK_PROVIDER_LABELS: Readonly<Record<NetdiskProvider, string>> = {
  baidu: '百度网盘',
  aliyun: '阿里云盘',
  quark: '夸克网盘',
  '123pan': '123 云盘',
  lanzou: '蓝奏云',
  weiyun: '腾讯微云',
  ctfile: '城通网盘',
  onedrive: 'OneDrive',
  googledrive: 'Google Drive',
  mega: 'MEGA',
  dropbox: 'Dropbox',
  other: '其它链接',
};

/** 全部 provider（含 other），用于校验查询参数等外部输入 */
export const NETDISK_PROVIDERS: readonly NetdiskProvider[] = Object.keys(
  NETDISK_PROVIDER_LABELS,
) as NetdiskProvider[];

/** 兜底 provider */
export const FALLBACK_PROVIDER: NetdiskProvider = 'other';

/** 蓝奏云的 `lanzou*.com` 通配（只允许字母/数字/连字符，禁止再出现 `.`，避免 `lanzou.evil.com` 误命中） */
const LANZOU_PATTERN = /^lanzou[a-z0-9-]*\.com$/;

interface HostRule {
  provider: NetdiskProvider;
  /** 允许的主机名（命中自身或其子域） */
  hosts: readonly string[];
  /** 额外的主机名模式（同样只对候选后缀做整段匹配） */
  pattern?: RegExp;
}

/** 契约 §6 的映射表，顺序即匹配顺序 */
const HOST_RULES: readonly HostRule[] = [
  { provider: 'baidu', hosts: ['pan.baidu.com', 'yun.baidu.com'] },
  { provider: 'aliyun', hosts: ['aliyundrive.com', 'alipan.com'] },
  { provider: 'quark', hosts: ['pan.quark.cn'] },
  { provider: '123pan', hosts: ['123pan.com', '123684.com', '123865.com', '123912.com'] },
  {
    provider: 'lanzou',
    hosts: [
      'lanzoui.com',
      'lanzoux.com',
      'lanzoub.com',
      'lanzoue.com',
      'lanzouw.com',
      'lanzoup.com',
      'lanzouo.com',
    ],
    pattern: LANZOU_PATTERN,
  },
  { provider: 'weiyun', hosts: ['weiyun.com'] },
  { provider: 'ctfile', hosts: ['ctfile.com', '545c.com'] },
  { provider: 'onedrive', hosts: ['1drv.ms', 'onedrive.live.com', 'sharepoint.com'] },
  { provider: 'googledrive', hosts: ['drive.google.com', 'docs.google.com'] },
  { provider: 'mega', hosts: ['mega.nz', 'mega.io'] },
  { provider: 'dropbox', hosts: ['dropbox.com', 'db.tt'] },
];

/** 统计"字符数"（按 Unicode 码点，与路由层其它字段一致） */
function charLength(value: string): number {
  return Array.from(value).length;
}

/** 主机名归一化：小写、去掉末尾的点、去掉一层 `www.` 前缀 */
export function normalizeHostname(host: string): string {
  let value = host.trim().toLowerCase();
  while (value.endsWith('.')) value = value.slice(0, -1);
  if (value.startsWith('www.')) value = value.slice(4);
  return value;
}

/**
 * 主机名的全部候选后缀：`a.pan.baidu.com` → `a.pan.baidu.com` / `pan.baidu.com` / `baidu.com` / `com`。
 * 用"候选后缀是否等于规则主机名"代替子串包含，天然支持子域与 `www.`，
 * 同时让 `pan.baidu.com.evil.com`（后缀是 `evil.com`）无法命中。
 */
function candidateSuffixes(host: string): string[] {
  const parts = host.split('.');
  const suffixes: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    suffixes.push(parts.slice(index).join('.'));
  }
  return suffixes;
}

function matchesRule(rule: HostRule, candidates: readonly string[]): boolean {
  for (const candidate of candidates) {
    if (rule.hosts.includes(candidate)) return true;
    if (rule.pattern && rule.pattern.test(candidate)) return true;
  }
  return false;
}

/** 由主机名识别 provider（大小写不敏感，忽略 `www.` 前缀；无法识别 → other） */
export function detectProviderFromHost(host: string): NetdiskProvider {
  const normalized = normalizeHostname(host);
  if (normalized === '') return FALLBACK_PROVIDER;
  const candidates = candidateSuffixes(normalized);
  for (const rule of HOST_RULES) {
    if (matchesRule(rule, candidates)) return rule.provider;
  }
  return FALLBACK_PROVIDER;
}

/** provider → 中文展示名 */
export function providerLabelOf(provider: NetdiskProvider): string {
  return NETDISK_PROVIDER_LABELS[provider];
}

/** provider 是否为契约 §6 收录的取值（用于宽容解析外部输入） */
export function isNetdiskProvider(value: unknown): value is NetdiskProvider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(NETDISK_PROVIDER_LABELS, value);
}

/** 校验结果：成功带归一化后的 url / 主机名 / provider / 中文名 */
export type NetdiskUrlCheck =
  | { ok: true; url: string; host: string; provider: NetdiskProvider; providerLabel: string }
  | { ok: false; reason: string };

/**
 * 校验网盘链接（契约 §1.3 / §3.6）：
 * - 必须是字符串，trim 后非空；
 * - 长度 ≤ 500（NETDISK_URL_MAX_LENGTH）；
 * - 用 `new URL()` 解析，解析异常即为非法；
 * - 协议必须是 http: 或 https:；
 * - 必须有主机名；
 * - 一律不做可用性探测（不发外网请求，契约 §7）。
 */
export function checkNetdiskUrl(raw: unknown): NetdiskUrlCheck {
  if (typeof raw !== 'string') return { ok: false, reason: '网盘链接必须是文本' };
  const url = raw.trim();
  if (url === '') return { ok: false, reason: '网盘链接不能为空' };
  if (charLength(url) > NETDISK_URL_MAX_LENGTH) {
    return { ok: false, reason: `网盘链接长度不能超过 ${NETDISK_URL_MAX_LENGTH} 个字符` };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: '网盘链接不是合法的 URL' };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, reason: '网盘链接必须以 http:// 或 https:// 开头' };
  }

  const host = normalizeHostname(parsed.hostname);
  if (host === '') return { ok: false, reason: '网盘链接缺少主机名' };

  const provider = detectProviderFromHost(host);
  return { ok: true, url, host, provider, providerLabel: providerLabelOf(provider) };
}

/** 便捷判定：链接是否合法 */
export function isValidNetdiskUrl(raw: unknown): boolean {
  return checkNetdiskUrl(raw).ok;
}
