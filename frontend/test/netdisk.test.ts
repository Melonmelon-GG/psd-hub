/**
 * 网盘本地识别（netdisk/providers）测试。
 *
 * 重要前提（契约 §1.3 / §6）：`provider` / `providerLabel` **以服务端为准**，
 * 本地 `detectProvider()` 只服务上传表单的即时提示。
 * 因此这里断言的是「本地识别与服务端表格同口径」，而非替代服务端判定。
 *
 * 重点覆盖后缀锚定：`pan.baidu.com.evil.com` 这类伪装域名必须归为 `other`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NETDISK_HOST_RULES,
  PROVIDER_FILTER_OPTIONS,
  PROVIDER_STYLES,
  detectProvider,
  detectProviderLabel,
  normalizeProviderFilter,
  providerStyle,
} from '../src/netdisk/providers.ts';
import type { NetdiskProvider } from '../src/types.ts';

/* ------------------------------ 契约 §6 真值表 ------------------------------ */

/** [链接, 期望 provider] —— 逐条对应契约 §6 的表格 */
const TRUTH_TABLE: ReadonlyArray<readonly [string, NetdiskProvider]> = [
  ['https://pan.baidu.com/s/1abcd', 'baidu'],
  ['https://yun.baidu.com/s/1abcd', 'baidu'],
  ['https://aliyundrive.com/s/abcd', 'aliyun'],
  ['https://www.alipan.com/s/abcd', 'aliyun'],
  ['https://pan.quark.cn/s/abcd', 'quark'],
  ['https://123pan.com/s/abcd', '123pan'],
  ['https://www.123684.com/s/abcd', '123pan'],
  ['https://123865.com/s/abcd', '123pan'],
  ['https://123912.com/s/abcd', '123pan'],
  ['https://lanzou.com/abc', 'lanzou'],
  ['https://lanzoui.com/abc', 'lanzou'],
  ['https://lanzoux.com/abc', 'lanzou'],
  ['https://lanzoub.com/abc', 'lanzou'],
  ['https://lanzoue.com/abc', 'lanzou'],
  ['https://lanzouw.com/abc', 'lanzou'],
  ['https://lanzoup.com/abc', 'lanzou'],
  ['https://lanzouo.com/abc', 'lanzou'],
  ['https://lanzouabc.com/abc', 'lanzou'],
  ['https://weiyun.com/abc', 'weiyun'],
  ['https://ctfile.com/abc', 'ctfile'],
  ['https://545c.com/abc', 'ctfile'],
  ['https://1drv.ms/u/s!abc', 'onedrive'],
  ['https://onedrive.live.com/abc', 'onedrive'],
  ['https://contoso.sharepoint.com/abc', 'onedrive'],
  ['https://drive.google.com/file/d/abc', 'googledrive'],
  ['https://docs.google.com/document/d/abc', 'googledrive'],
  ['https://mega.nz/file/abc', 'mega'],
  ['https://mega.io/file/abc', 'mega'],
  ['https://www.dropbox.com/s/abc', 'dropbox'],
  ['https://db.tt/abc', 'dropbox'],
  ['https://example.com/s/1', 'other'],
  ['https://pan.baidu.com.evil.com/s/1', 'other'],
];

test('detectProvider 与契约 §6 的真值表一致', () => {
  for (const [url, expected] of TRUTH_TABLE) {
    assert.equal(detectProvider(url), expected, `链接 ${url} 应识别为 ${expected}`);
  }
});

test('伪装域名不会被误判（后缀锚定，而非子串包含）', () => {
  const fakes = [
    'https://pan.baidu.com.evil.com/s/1',
    'https://pan.baidu.com.evil.com',
    'https://yun.baidu.com.evil.com/s/1',
    'https://evil-pan.baidu.com/s/1',
    'https://notpan.quark.cn/s/1',
    'https://pan.quark.cn.evil.com/s/1',
    'https://drive.google.com.evil.com/file/d/1',
    'https://weiyun.com.evil.com/x',
    // 后缀相同但顶层域不同：`evilbaidu.com` 不是 baidu.com
    'https://evilbaidu.com/s/1',
    'https://xdropbox.com/s/1',
  ];

  for (const url of fakes) {
    assert.equal(detectProvider(url), 'other', `伪装链接 ${url} 必须归为 other`);
  }
});

test('大小写不敏感、忽略 www. 前缀与末尾点', () => {
  assert.equal(detectProvider('HTTPS://PAN.BAIDU.COM/s/1'), 'baidu');
  assert.equal(detectProvider('https://WWW.Pan.Baidu.COM/s/1'), 'baidu');
  assert.equal(detectProvider('https://pan.baidu.com./s/1'), 'baidu');
  assert.equal(detectProvider('https://www.pan.baidu.com/s/1'), 'baidu');
});

test('非 http(s) 或无法解析的一律归为 other', () => {
  const cases = [
    '',
    '   ',
    'pan.baidu.com/s/1', // 缺协议头
    'ftp://pan.baidu.com/s/1',
    'file:///C:/x.png',
    'javascript:alert(1)',
    '随便写点什么',
    'https://',
  ];

  for (const value of cases) {
    assert.equal(detectProvider(value), 'other', `输入 ${JSON.stringify(value)} 应为 other`);
  }
});

/* ------------------------------ 展示映射 ------------------------------ */

test('PROVIDER_STYLES 覆盖契约 §1.3 的全部 provider，且中文名与 §6 一致', () => {
  const expectedLabels: Record<NetdiskProvider, string> = {
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

  for (const [provider, label] of Object.entries(expectedLabels)) {
    const style = PROVIDER_STYLES[provider as NetdiskProvider];
    assert.equal(style.label, label);
    assert.ok(style.icon.length > 0, `${provider} 需要有一个图标标记`);
    assert.match(style.color, /^#[0-9a-f]{6}$/i, `${provider} 的主题色应为十六进制颜色`);
  }
});

test('providerStyle 对未知 provider 退回 other，不会炸掉界面', () => {
  assert.equal(providerStyle('baidu').label, '百度网盘');
  assert.equal(providerStyle(null).label, '其它链接');
  assert.equal(providerStyle(undefined).label, '其它链接');
  assert.equal(providerStyle('something-new' as NetdiskProvider).label, '其它链接');
});

test('detectProviderLabel 返回与服务端同表的中文名', () => {
  assert.equal(detectProviderLabel('https://pan.baidu.com/s/1'), '百度网盘');
  assert.equal(detectProviderLabel('https://pan.baidu.com.evil.com/s/1'), '其它链接');
});

test('NETDISK_HOST_RULES 覆盖契约 §6 的全部主机名条目', () => {
  const hosts = NETDISK_HOST_RULES.map((rule) => rule.host);
  for (const host of [
    'pan.baidu.com',
    'yun.baidu.com',
    'aliyundrive.com',
    'alipan.com',
    'pan.quark.cn',
    '123pan.com',
    '123684.com',
    '123865.com',
    '123912.com',
    'lanzou*.com',
    'lanzoui.com',
    'lanzoux.com',
    'lanzoub.com',
    'lanzoue.com',
    'lanzouw.com',
    'lanzoup.com',
    'lanzouo.com',
    'weiyun.com',
    'ctfile.com',
    '545c.com',
    '1drv.ms',
    'onedrive.live.com',
    'sharepoint.com',
    'drive.google.com',
    'docs.google.com',
    'mega.nz',
    'mega.io',
    'dropbox.com',
    'db.tt',
  ]) {
    assert.ok(hosts.includes(host), `缺少契约 §6 的主机名条目：${host}`);
  }
});

/* ------------------------------ 列表筛选参数 ------------------------------ */

test('PROVIDER_FILTER_OPTIONS 覆盖全部 provider', () => {
  assert.equal(PROVIDER_FILTER_OPTIONS.length, Object.keys(PROVIDER_STYLES).length);
  assert.deepEqual(
    PROVIDER_FILTER_OPTIONS.map((option) => option.value),
    Object.keys(PROVIDER_STYLES),
  );
  assert.equal(PROVIDER_FILTER_OPTIONS[0].label, '百度网盘');
});

test('normalizeProviderFilter 宽容解析非法值（契约 §3.3）', () => {
  assert.equal(normalizeProviderFilter('baidu'), 'baidu');
  assert.equal(normalizeProviderFilter('other'), 'other');
  assert.equal(normalizeProviderFilter('BAIDU'), null);
  assert.equal(normalizeProviderFilter('not-a-provider'), null);
  assert.equal(normalizeProviderFilter(''), null);
  assert.equal(normalizeProviderFilter(null), null);
});
