/**
 * 网盘识别单元测试（契约 §6）。
 *
 * 重点：
 * - 全表覆盖：每个 provider 至少一个主机名，中文展示名逐字一致；
 * - 大小写不敏感、忽略 `www.` 前缀、允许子域；
 * - **安全**：`pan.baidu.com.evil.com` 这类伪装必须落到 other（后缀锚定匹配）；
 * - 校验：非 http(s)、无主机名、超长一律拒绝。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NETDISK_URL_MAX_LENGTH } from '../src/config.js';
import {
  NETDISK_PROVIDER_LABELS,
  NETDISK_PROVIDERS,
  checkNetdiskUrl,
  detectProviderFromHost,
  isNetdiskProvider,
  isValidNetdiskUrl,
  normalizeHostname,
  providerLabelOf,
} from '../src/lib/netdisk.js';
import type { NetdiskProvider } from '../src/types.js';

/** 契约 §6 表格：provider → (主机名列表, 中文名) */
const TABLE: Array<{ provider: NetdiskProvider; hosts: string[]; label: string }> = [
  { provider: 'baidu', hosts: ['pan.baidu.com', 'yun.baidu.com'], label: '百度网盘' },
  { provider: 'aliyun', hosts: ['aliyundrive.com', 'alipan.com'], label: '阿里云盘' },
  { provider: 'quark', hosts: ['pan.quark.cn'], label: '夸克网盘' },
  { provider: '123pan', hosts: ['123pan.com', '123684.com', '123865.com', '123912.com'], label: '123 云盘' },
  {
    provider: 'lanzou',
    hosts: [
      'lanzou.com',
      'lanzou123.com',
      'lanzoui.com',
      'lanzoux.com',
      'lanzoub.com',
      'lanzoue.com',
      'lanzouw.com',
      'lanzoup.com',
      'lanzouo.com',
    ],
    label: '蓝奏云',
  },
  { provider: 'weiyun', hosts: ['weiyun.com'], label: '腾讯微云' },
  { provider: 'ctfile', hosts: ['ctfile.com', '545c.com'], label: '城通网盘' },
  { provider: 'onedrive', hosts: ['1drv.ms', 'onedrive.live.com', 'sharepoint.com'], label: 'OneDrive' },
  { provider: 'googledrive', hosts: ['drive.google.com', 'docs.google.com'], label: 'Google Drive' },
  { provider: 'mega', hosts: ['mega.nz', 'mega.io'], label: 'MEGA' },
  { provider: 'dropbox', hosts: ['dropbox.com', 'db.tt'], label: 'Dropbox' },
  { provider: 'other', hosts: ['example.com', 'pan.baidu.com.evil.com'], label: '其它链接' },
];

describe('detectProviderFromHost：契约 §6 全表映射', () => {
  for (const row of TABLE) {
    it(`${row.provider} ← ${row.hosts.join(' / ')}（${row.label}）`, () => {
      for (const host of row.hosts) {
        assert.equal(detectProviderFromHost(host), row.provider, `主机名 ${host}`);
        assert.equal(providerLabelOf(detectProviderFromHost(host)), row.label, `主机名 ${host} 的中文名`);
      }
    });
  }

  it('provider 列表与中文名表一一对应，没有遗漏', () => {
    assert.equal(NETDISK_PROVIDERS.length, TABLE.length);
    for (const row of TABLE) {
      assert.equal(NETDISK_PROVIDER_LABELS[row.provider], row.label);
      const checked = checkNetdiskUrl(`https://${row.hosts[0]}/s/1`);
      assert.ok(checked.ok);
      assert.equal(checked.provider, row.provider);
      assert.equal(checked.providerLabel, row.label);
    }
  });

  it('大小写不敏感（主机名归一化为小写）', () => {
    assert.equal(detectProviderFromHost('PAN.BAIDU.COM'), 'baidu');
    assert.equal(detectProviderFromHost('Pan.Baidu.Com'), 'baidu');
    assert.equal(detectProviderFromHost('WWW.MEGA.NZ'), 'mega');
    assert.equal(checkNetdiskUrl('HTTPS://PAN.BAIDU.COM/s/1').ok, true);
  });

  it('忽略 www. 前缀（含子域叠加）', () => {
    assert.equal(detectProviderFromHost('www.pan.baidu.com'), 'baidu');
    assert.equal(detectProviderFromHost('www.mega.nz'), 'mega');
    assert.equal(detectProviderFromHost('www.123pan.com'), '123pan');
    assert.equal(detectProviderFromHost('www.www.dropbox.com'), 'dropbox');
  });

  it('允许真实子域（按后缀锚定）', () => {
    assert.equal(detectProviderFromHost('share.weiyun.com'), 'weiyun');
    assert.equal(detectProviderFromHost('tenant.sharepoint.com'), 'onedrive');
    assert.equal(detectProviderFromHost('abc.pan.quark.cn'), 'quark');
    assert.equal(detectProviderFromHost('lanzou.example.lanzoui.com'), 'lanzou');
  });

  it('末尾的点不影响识别（FQDN 形式）', () => {
    assert.equal(detectProviderFromHost('pan.baidu.com.'), 'baidu');
  });

  it('空主机名 → other', () => {
    assert.equal(detectProviderFromHost(''), 'other');
    assert.equal(detectProviderFromHost('   '), 'other');
  });
});

describe('安全：后缀锚定匹配，拒绝伪装域名', () => {
  const traps: Array<[string, string]> = [
    ['https://pan.baidu.com.evil.com/s/1', 'evil.com 的子域'],
    ['https://pan.baidu.com.evil.com', 'evil.com 的子域（无路径）'],
    ['https://baidu.com.evil.com/s/1', 'baidu.com 前缀伪装'],
    ['https://yun.baidu.com.attacker.net/s/1', 'yun.baidu.com 后缀伪装'],
    ['https://pan.quark.cn.phish.io/s/1', 'quark 伪装'],
    ['https://mega.nz.evil.com/xyz', 'mega 伪装'],
    ['https://notpan.baidu.com/s/1', '规则未收录的兄弟域'],
    ['https://evil.com/pan.baidu.com/s/1', '主机名对但路径是伪装'],
    ['https://lanzou.evil.com/x', 'lanzou 通配不跨点'],
    ['https://dropbox.com.evil.com/x', 'dropbox 伪装'],
  ];

  for (const [url, why] of traps) {
    it(`${url}（${why}）→ other / 其它链接`, () => {
      const checked = checkNetdiskUrl(url);
      assert.ok(checked.ok, '语法上仍是合法的 http(s) 链接');
      assert.equal(checked.provider, 'other');
      assert.equal(checked.providerLabel, '其它链接');
    });
  }

  it('伪装域名不会因为包含 pan.baidu.com 子串而被误判', () => {
    assert.equal(detectProviderFromHost('www.pan.baidu.com.evil.com'), 'other');
    assert.equal(detectProviderFromHost('pan.baidu.com.evil.com'), 'other');
  });
});

describe('normalizeHostname', () => {
  it('小写 / 去 www / 去末尾点 / 去空白', () => {
    assert.equal(normalizeHostname('  WWW.Pan.Baidu.Com.  '), 'pan.baidu.com');
    assert.equal(normalizeHostname('mega.nz'), 'mega.nz');
  });
});

describe('checkNetdiskUrl：校验规则', () => {
  it('合法链接返回归一化后的 url / 主机名 / provider', () => {
    const checked = checkNetdiskUrl('  https://pan.baidu.com/s/1abcdef  ');
    assert.ok(checked.ok);
    assert.equal(checked.url, 'https://pan.baidu.com/s/1abcdef', 'trim 两端空白');
    assert.equal(checked.host, 'pan.baidu.com');
    assert.equal(checked.provider, 'baidu');
    assert.equal(checked.providerLabel, '百度网盘');
    assert.equal(isValidNetdiskUrl('https://pan.baidu.com/s/1abcdef'), true);
  });

  it('http:// 与 https:// 都接受', () => {
    assert.ok(checkNetdiskUrl('http://pan.baidu.com/s/1').ok);
    assert.ok(checkNetdiskUrl('https://pan.baidu.com/s/1').ok);
  });

  it('非 http(s) 协议一律拒绝', () => {
    for (const url of ['javascript:alert(1)', 'ftp://x', 'file:///etc/passwd', 'data:text/plain,hi', 'ws://pan.baidu.com']) {
      const checked = checkNetdiskUrl(url);
      assert.equal(checked.ok, false, `${url} 应被拒绝`);
      if (!checked.ok) assert.equal(checked.reason, '网盘链接必须以 http:// 或 https:// 开头');
    }
  });

  it('无主机名 / 无法解析的字符串一律拒绝', () => {
    for (const url of ['https://', 'not a url', '//pan.baidu.com/s/1', '/s/1', 'https://:8080/s/1']) {
      const checked = checkNetdiskUrl(url);
      assert.equal(checked.ok, false, `${url} 应被拒绝`);
    }
  });

  it('空串 / 纯空白拒绝', () => {
    for (const url of ['', '   ']) {
      const checked = checkNetdiskUrl(url);
      assert.equal(checked.ok, false);
      if (!checked.ok) assert.equal(checked.reason, '网盘链接不能为空');
    }
  });

  it('非字符串一律拒绝（不抛异常）', () => {
    for (const value of [undefined, null, 123, {}, [], true]) {
      const checked = checkNetdiskUrl(value);
      assert.equal(checked.ok, false, `${JSON.stringify(value)} 应被拒绝`);
      if (!checked.ok) assert.equal(checked.reason, '网盘链接必须是文本');
    }
  });

  it(`长度上限 ${NETDISK_URL_MAX_LENGTH}：恰好 500 通过，501 拒绝`, () => {
    const prefix = 'https://pan.baidu.com/s/';
    const exact = prefix + 'a'.repeat(NETDISK_URL_MAX_LENGTH - prefix.length);
    assert.equal(exact.length, NETDISK_URL_MAX_LENGTH);
    assert.ok(checkNetdiskUrl(exact).ok);

    const tooLong = `${exact}a`;
    const checked = checkNetdiskUrl(tooLong);
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.match(checked.reason, /不能超过 500 个字符/);
  });

  it('isNetdiskProvider 只认契约 §6 的取值', () => {
    assert.equal(isNetdiskProvider('baidu'), true);
    assert.equal(isNetdiskProvider('other'), true);
    assert.equal(isNetdiskProvider('bogus'), false);
    assert.equal(isNetdiskProvider(''), false);
    assert.equal(isNetdiskProvider(undefined), false);
  });
});
