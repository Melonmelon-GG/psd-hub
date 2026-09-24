/**
 * PSD 头部解析与 PNG 魔数识别的单元测试（契约 §6）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASE_CHANNEL_COUNT_BY_MODE,
  CHANNELS_MAX,
  CHANNELS_MIN,
  COLOR_MODE_BY_CODE,
  PSD_HEADER_SIZE,
  baseChannelCount,
  deriveHasAlpha,
  isPngBuffer,
  isPsdBuffer,
  isValidChannelCount,
  parsePngSize,
  parsePsdHeader,
  versionLabel,
} from '../src/lib/psdHeader.js';
import { buildPngBuffer, buildPsdBuffer } from './helpers.js';

describe('parsePsdHeader', () => {
  it('解析 26 字节头部：宽 / 高 / 通道 / 位深 / 色彩模式', () => {
    const buffer = buildPsdBuffer({
      width: 1920,
      height: 1080,
      channels: 4,
      bitsPerChannel: 8,
      colorMode: 3,
      version: 1,
    });
    const header = parsePsdHeader(buffer);
    assert.ok(header, '应解析成功');
    assert.equal(header.version, 1);
    assert.equal(header.width, 1920);
    assert.equal(header.height, 1080);
    assert.equal(header.channels, 4);
    assert.equal(header.bitsPerChannel, 8);
    assert.equal(header.colorMode, 'RGB');
  });

  it('版本 2 识别为 PSB', () => {
    const header = parsePsdHeader(buildPsdBuffer({ version: 2, width: 30000, height: 40000 }));
    assert.ok(header);
    assert.equal(header.version, 2);
    assert.equal(header.width, 30000);
    assert.equal(header.height, 40000);
  });

  it('色彩模式编码映射完整（0/1/2/3/4/7/8/9），编码 7 = Multichannel', () => {
    const expected: Record<number, string> = {
      0: 'Bitmap',
      1: 'Grayscale',
      2: 'Indexed',
      3: 'RGB',
      4: 'CMYK',
      7: 'Multichannel',
      8: 'Duotone',
      9: 'Lab',
    };
    for (const [code, name] of Object.entries(expected)) {
      const header = parsePsdHeader(buildPsdBuffer({ colorMode: Number(code) }));
      assert.ok(header, `色彩模式 ${code} 应解析成功`);
      assert.equal(header.colorMode, name);
      assert.equal(header.colorModeCode, Number(code), '原始数值编码应一并保留');
    }
    assert.deepEqual(COLOR_MODE_BY_CODE, expected);
  });

  it('未收录的色彩模式编码映射为 null（不抛错）', () => {
    for (const code of [5, 6, 10, 999]) {
      const header = parsePsdHeader(buildPsdBuffer({ colorMode: code }));
      assert.ok(header);
      assert.equal(header.colorMode, null);
      assert.equal(header.colorModeCode, code, '未收录编码仍保留原始数值，供 deriveHasAlpha 判定');
    }
  });

  it('位深映射 1/8/16/32，其它为 null', () => {
    for (const bits of [1, 8, 16, 32]) {
      const header = parsePsdHeader(buildPsdBuffer({ bitsPerChannel: bits }));
      assert.ok(header);
      assert.equal(header.bitsPerChannel, bits);
    }
    for (const bits of [2, 12, 64]) {
      const header = parsePsdHeader(buildPsdBuffer({ bitsPerChannel: bits }));
      assert.ok(header);
      assert.equal(header.bitsPerChannel, null);
    }
  });

  it('签名不是 8BPS → null', () => {
    assert.equal(parsePsdHeader(buildPsdBuffer({ signature: '8BPX' })), null);
    assert.equal(parsePsdHeader(buildPsdBuffer({ signature: '9BPS' })), null);
    assert.equal(parsePsdHeader(buildPsdBuffer({ signature: '8bps' })), null);
  });

  it('保留字节非 0 → null', () => {
    const reserved = Buffer.from([0, 0, 0, 0, 0, 1]);
    assert.equal(parsePsdHeader(buildPsdBuffer({ reserved })), null);
  });

  it('非法版本 → null', () => {
    assert.equal(parsePsdHeader(buildPsdBuffer({ version: 3 })), null);
    assert.equal(parsePsdHeader(buildPsdBuffer({ version: 0 })), null);
  });

  it('长度不足 26 字节 / 空输入 → null', () => {
    assert.equal(parsePsdHeader(buildPsdBuffer().subarray(0, PSD_HEADER_SIZE - 1)), null);
    assert.equal(parsePsdHeader(Buffer.alloc(0)), null);
    assert.equal(parsePsdHeader(null), null);
    assert.equal(parsePsdHeader(undefined), null);
  });
});

describe('isPsdBuffer / isPngBuffer', () => {
  it('识别 8BPS 签名', () => {
    assert.equal(isPsdBuffer(buildPsdBuffer()), true);
    assert.equal(isPsdBuffer(buildPsdBuffer({ signature: '8BPX' })), false);
    assert.equal(isPsdBuffer(Buffer.from('8BP')), false);
    assert.equal(isPsdBuffer(null), false);
  });

  it('识别 PNG 魔数 89 50 4E 47 0D 0A 1A 0A', () => {
    const png = buildPngBuffer();
    assert.equal(isPngBuffer(png), true);

    const broken = Buffer.from(png);
    broken[1] = 0x00;
    assert.equal(isPngBuffer(broken), false);
    assert.equal(isPngBuffer(Buffer.from([0x89, 0x50, 0x4e])), false);
    assert.equal(isPngBuffer(null), false);
  });
});

describe('parsePngSize', () => {
  it('从 IHDR 读取宽高', () => {
    const png = buildPngBuffer(64, 32);
    assert.deepEqual(parsePngSize(png), { width: 64, height: 32 });
  });

  it('非 PNG 或数据不足 → null', () => {
    assert.equal(parsePngSize(buildPsdBuffer()), null);
    assert.equal(parsePngSize(buildPngBuffer().subarray(0, 20)), null);
    assert.equal(parsePngSize(null), null);
  });
});

// ---------------------------------------------------------------------------
// v1.1 新增：颜色通道级元数据（契约 §1.1 / §6）
// ---------------------------------------------------------------------------

describe('versionLabel（PSD / PSB）', () => {
  it('头版本 1 → "PSD"，2 → "PSB"', () => {
    assert.equal(versionLabel(1), 'PSD');
    assert.equal(versionLabel(2), 'PSB');

    const psd = parsePsdHeader(buildPsdBuffer({ version: 1 }));
    assert.ok(psd);
    assert.equal(versionLabel(psd.version), 'PSD');

    const psb = parsePsdHeader(buildPsdBuffer({ version: 2 }));
    assert.ok(psb);
    assert.equal(versionLabel(psb.version), 'PSB');
  });

  it('其它版本编码 → null（且整体解析也失败）', () => {
    for (const bogus of [0, 3, 4, 255, 65535]) {
      assert.equal(versionLabel(bogus), null, `versionLabel(${bogus}) 应为 null`);
      assert.equal(parsePsdHeader(buildPsdBuffer({ version: bogus })), null, `头版本 ${bogus} 应解析失败`);
    }
    assert.equal(versionLabel(null), null);
    assert.equal(versionLabel(undefined), null);
  });
});

describe('parsePsdHeader：通道数透传与越界值', () => {
  it('正常值原样透传（1 / 3 / 4 / 5 / 56）', () => {
    for (const channels of [1, 3, 4, 5, 56]) {
      const header = parsePsdHeader(buildPsdBuffer({ channels, colorMode: 3 }));
      assert.ok(header);
      assert.equal(header.channels, channels);
    }
  });

  it('越界值（0 / 57 / 65535）与现有实现一致：解析仍成功、通道数原样透传不钳制', () => {
    for (const channels of [0, 57, 65535]) {
      const header = parsePsdHeader(buildPsdBuffer({ channels, colorMode: 3 }));
      assert.ok(header, `通道数 ${channels} 不改变整体解析结果`);
      assert.equal(header.channels, channels, '不做钳制，原样透传');
      assert.equal(isValidChannelCount(channels), false);
      // 通道数不可信 → hasAlpha 无法判定（不谎报 false）
      assert.equal(deriveHasAlpha(header.channels, header.colorModeCode), null);
    }
  });

  it('isValidChannelCount 边界：1..56 合法，其余非法', () => {
    assert.equal(CHANNELS_MIN, 1);
    assert.equal(CHANNELS_MAX, 56);
    for (const channels of [1, 2, 56]) assert.equal(isValidChannelCount(channels), true);
    for (const channels of [0, -1, 57, 1.5, Number.NaN, null, undefined]) {
      assert.equal(isValidChannelCount(channels), false, `${String(channels)} 应判为非法`);
    }
  });
});

describe('baseChannelCount（契约 §6 基色通道数表）', () => {
  it('全部 8 个已知编码 + 未知编码 + 缺失值', () => {
    const expected: Record<number, number | null> = {
      0: 1, // Bitmap
      1: 1, // Grayscale
      2: 1, // Indexed
      3: 3, // RGB
      4: 4, // CMYK
      7: null, // Multichannel：不固定
      8: 1, // Duotone
      9: 3, // Lab
      5: null, // 未收录
      6: null,
      10: null,
      999: null,
    };
    for (const [code, count] of Object.entries(expected)) {
      assert.equal(baseChannelCount(Number(code)), count, `编码 ${code}`);
    }
    assert.equal(baseChannelCount(null), null);
    assert.equal(baseChannelCount(undefined), null);

    // 7 刻意不在表里 —— 这就是 Multichannel 返回 null 的实现依据
    assert.equal(Object.prototype.hasOwnProperty.call(BASE_CHANNEL_COUNT_BY_MODE, 7), false);
  });
});

describe('deriveHasAlpha 真值表（契约 §6）', () => {
  const RGB = 3;
  const GRAYSCALE = 1;
  const CMYK = 4;
  const DUOTONE = 8;
  const LAB = 9;
  const MULTICHANNEL = 7;

  it('基色通道数相等 → false；多出通道 → true', () => {
    assert.equal(deriveHasAlpha(3, RGB), false, 'RGB + 3 通道 → false');
    assert.equal(deriveHasAlpha(4, RGB), true, 'RGB + 4 通道 → true');
    assert.equal(deriveHasAlpha(1, GRAYSCALE), false, 'Grayscale + 1 通道 → false');
    assert.equal(deriveHasAlpha(2, GRAYSCALE), true, 'Grayscale + 2 通道 → true');
    assert.equal(deriveHasAlpha(4, CMYK), false, 'CMYK + 4 通道 → false');
    assert.equal(deriveHasAlpha(5, CMYK), true, 'CMYK + 5 通道 → true');
    assert.equal(deriveHasAlpha(1, DUOTONE), false, 'Duotone + 1 通道 → false');
    assert.equal(deriveHasAlpha(3, LAB), false, 'Lab + 3 通道 → false');
  });

  it('Multichannel 一律 null（专色通道与 alpha 通道无法区分）', () => {
    assert.equal(deriveHasAlpha(3, MULTICHANNEL), null);
    assert.equal(deriveHasAlpha(5, MULTICHANNEL), null);
    for (const channels of [1, 2, 4, 8, 56]) {
      assert.equal(deriveHasAlpha(channels, MULTICHANNEL), null, `Multichannel + ${channels} 通道 → null`);
    }
  });

  it('通道数或色彩模式不可用时 → null（不猜）', () => {
    assert.equal(deriveHasAlpha(null, RGB), null);
    assert.equal(deriveHasAlpha(0, RGB), null);
    assert.equal(deriveHasAlpha(57, RGB), null);
    assert.equal(deriveHasAlpha(4, null), null);
    assert.equal(deriveHasAlpha(4, 5), null, '未收录编码 → null');
  });
});
