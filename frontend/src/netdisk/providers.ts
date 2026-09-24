/**
 * 网盘来源的**展示用**映射表与本地即时识别。
 *
 * ⚠️ 权威性说明（契约 §1.3 / §6）：
 * 服务端按 docs/API.md §6 的规则识别 `provider` / `providerLabel`，**以服务端为准**。
 * 本文件里的 `detectProvider()` 只是为了让上传表单在用户输入链接时**即时**给出
 * 「已识别为：百度网盘」这类反馈，避免用户填错链接却要等到提交才知道。
 * 提交后（以及详情页/列表页）一律使用响应里的 `source.provider` / `source.providerLabel`，
 * 不得用本地结果覆盖或改写服务端返回值。
 *
 * 主机名匹配同样按**完整主机名或 `.` 锚定的后缀**判断（与服务端口径一致），
 * 因此 `pan.baidu.com.evil.com` 会被归为 `other` —— 绝不使用 `includes('baidu.com')`
 * 这类子串匹配，否则伪装域名会被误判。
 */
import type { CSSProperties } from 'react';

import type { NetdiskProvider } from '@/types';

/** 展示用的网盘样式（中文名与契约 §6 的 providerLabel 保持一致） */
export interface ProviderStyle {
  /** 与服务端 §6 的 providerLabel 完全一致的中文名 */
  label: string;
  /** 展示用图标：单字/短标记，渲染在彩色方块里（不引入任何图标库） */
  icon: string;
  /** 主题色，用作徽标前景色；背景由 CSS 用 color-mix 从 currentColor 派生 */
  color: string;
}

/**
 * provider → 展示样式。
 * 所有 key 都必须存在，保证 `PROVIDER_STYLES[source.provider]` 永不返回 undefined
 * （即便后端将来新增类型，`providerStyle()` 也会退回 other）。
 */
export const PROVIDER_STYLES: Record<NetdiskProvider, ProviderStyle> = {
  baidu: { label: '百度网盘', icon: '百', color: '#4e6ef2' },
  aliyun: { label: '阿里云盘', icon: '阿', color: '#ff6a00' },
  quark: { label: '夸克网盘', icon: '夸', color: '#5b6cff' },
  '123pan': { label: '123 云盘', icon: '123', color: '#2f7cf6' },
  lanzou: { label: '蓝奏云', icon: '蓝', color: '#3aa0ff' },
  weiyun: { label: '腾讯微云', icon: '微', color: '#1fb6d8' },
  ctfile: { label: '城通网盘', icon: '城', color: '#f0a020' },
  onedrive: { label: 'OneDrive', icon: 'O', color: '#0364b8' },
  googledrive: { label: 'Google Drive', icon: 'G', color: '#1a936f' },
  mega: { label: 'MEGA', icon: 'M', color: '#e0393e' },
  dropbox: { label: 'Dropbox', icon: 'D', color: '#0f7ae5' },
  other: { label: '其它链接', icon: '链', color: '#8a93a8' },
};

/** 取某个 provider 的展示样式；未知值退回 other，避免界面炸掉 */
export function providerStyle(provider: NetdiskProvider | null | undefined): ProviderStyle {
  if (provider && provider in PROVIDER_STYLES) {
    return PROVIDER_STYLES[provider];
  }
  return PROVIDER_STYLES.other;
}

/**
 * 徽标的内联样式：把品牌色写成 CSS 变量 `--netdisk-color`，
 * 由样式表派生出描边/底色，并按主题深浅微调前景色（见 styles/components.css）。
 * 之所以不直接内联 `color`，是因为写死的前景色在浅色主题下会对比度不足。
 */
export function providerColorStyle(provider: NetdiskProvider | null | undefined): CSSProperties {
  return { '--netdisk-color': providerStyle(provider).color } as CSSProperties;
}

/** 一条主机名匹配规则 */
interface HostRule {
  provider: NetdiskProvider;
  /** 完整主机名，或形如 `lanzou*.com` 的域名模式 */
  host: string;
}

/**
 * 契约 §6 的匹配表（顺序即优先级）。
 * - 形如 `pan.baidu.com` 的条目按**完整主机名或 `.` 后缀**匹配；
 * - 形如 `lanzou*.com` 的条目按域名模式匹配（`*` 只允许出现在最左侧标签内）。
 */
export const NETDISK_HOST_RULES: readonly HostRule[] = [
  { provider: 'baidu', host: 'pan.baidu.com' },
  { provider: 'baidu', host: 'yun.baidu.com' },
  { provider: 'aliyun', host: 'aliyundrive.com' },
  { provider: 'aliyun', host: 'alipan.com' },
  { provider: 'quark', host: 'pan.quark.cn' },
  { provider: '123pan', host: '123pan.com' },
  { provider: '123pan', host: '123684.com' },
  { provider: '123pan', host: '123865.com' },
  { provider: '123pan', host: '123912.com' },
  // 蓝奏云的域名会随备案变动而换后缀，故除通配条目外把契约表格里的域名逐一列出
  { provider: 'lanzou', host: 'lanzou*.com' },
  { provider: 'lanzou', host: 'lanzoui.com' },
  { provider: 'lanzou', host: 'lanzoux.com' },
  { provider: 'lanzou', host: 'lanzoub.com' },
  { provider: 'lanzou', host: 'lanzoue.com' },
  { provider: 'lanzou', host: 'lanzouw.com' },
  { provider: 'lanzou', host: 'lanzoup.com' },
  { provider: 'lanzou', host: 'lanzouo.com' },
  { provider: 'weiyun', host: 'weiyun.com' },
  { provider: 'ctfile', host: 'ctfile.com' },
  { provider: 'ctfile', host: '545c.com' },
  { provider: 'onedrive', host: '1drv.ms' },
  { provider: 'onedrive', host: 'onedrive.live.com' },
  { provider: 'onedrive', host: 'sharepoint.com' },
  { provider: 'googledrive', host: 'drive.google.com' },
  { provider: 'googledrive', host: 'docs.google.com' },
  { provider: 'mega', host: 'mega.nz' },
  { provider: 'mega', host: 'mega.io' },
  { provider: 'dropbox', host: 'dropbox.com' },
  { provider: 'dropbox', host: 'db.tt' },
];

/** 归一化主机名：小写、去掉末尾点、去掉 `www.` 前缀 */
function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

/**
 * 单条规则是否命中主机名。
 * - 精确条目：`host === rule` 或 `host` 以 `.rule` 结尾（子域名，反向前缀锚定）
 * - 通配条目：把 `*` 编译成 `[a-z0-9-]*` 并要求整体匹配
 * 两种形式都不会让 `pan.baidu.com.evil.com` 命中。
 */
function hostMatches(host: string, rule: string): boolean {
  if (rule.includes('*')) {
    const pattern = new RegExp(
      `^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]*')}$`,
    );
    return pattern.test(host);
  }
  return host === rule || host.endsWith(`.${rule}`);
}

/**
 * 本地即时识别网盘类型（**仅供表单提示**，最终以服务端返回为准）。
 * 非 http/https、无法解析、主机名不命中任何规则时一律返回 `'other'`。
 */
export function detectProvider(rawUrl: string): NetdiskProvider {
  const trimmed = rawUrl.trim();
  if (!trimmed) return 'other';

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'other';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'other';

  const host = normalizeHostname(parsed.hostname);
  if (!host) return 'other';

  for (const rule of NETDISK_HOST_RULES) {
    if (hostMatches(host, rule.host)) return rule.provider;
  }
  return 'other';
}

/**
 * 本地识别的中文名（与服务端 providerLabel 同表）。
 * 与 `detectProvider` 一样只用于表单即时反馈。
 */
export function detectProviderLabel(rawUrl: string): string {
  return providerStyle(detectProvider(rawUrl)).label;
}

/** 列表页「按网盘类型筛选」下拉的选项（契约 §3.3 `provider` 参数） */
export const PROVIDER_FILTER_OPTIONS: ReadonlyArray<{ value: NetdiskProvider; label: string }> = (
  [
    'baidu',
    'aliyun',
    'quark',
    '123pan',
    'lanzou',
    'weiyun',
    'ctfile',
    'onedrive',
    'googledrive',
    'mega',
    'dropbox',
    'other',
  ] as const
).map((value) => ({ value, label: PROVIDER_STYLES[value].label }));

/** 校验 URL 里的 provider 过滤参数（非法值返回 null，契约 §3.3 宽容解析） */
export function normalizeProviderFilter(value: string | null): NetdiskProvider | null {
  if (!value) return null;
  const found = PROVIDER_FILTER_OPTIONS.find((option) => option.value === value);
  return found ? found.value : null;
}
