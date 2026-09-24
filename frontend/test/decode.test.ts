/**
 * 自研 PSD 兜底解码器的回归测试。
 *
 * 判据来自 `tools/fixtures/`：每份 PSD 都配了一份**裸 RGBA 参考数据**（宽×高×4，行优先），
 * 就是该文件按规范解码后应得的画面。这里逐像素比对。
 *
 * 容差说明（依据规范与实测）：
 *   · CMYK：往返无损（生成侧与解码侧用的是同一套乘性换算式），容差 2 仅为舍入
 *   · RGB / Multichannel：不涉及色彩空间换算，容差 2
 *   · Grayscale / Duotone：单通道灰度，容差 2
 *   · Lab：sRGB↔Lab 往返有量化损失，容差 12
 *   · Indexed：量化到 256 色，容差 12
 *   · 16 位：取高字节降 8 位，往返无损，容差 2
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { decodePsd, PsdDecodeError } from '../src/psd/decode/index.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', 'tools', 'fixtures');
const MANIFEST = join(FIXTURES, 'manifest.json');

interface FixtureEntry {
  file: string;
  reference: string;
  rawReference: string;
  width: number;
  height: number;
  colorMode: number;
  colorModeName: string;
  bitsPerChannel: number;
  compression: 'raw' | 'rle';
  channels: number;
  layerRecords: number;
}

function loadManifest(): FixtureEntry[] | null {
  if (!existsSync(MANIFEST)) return null;
  return (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { fixtures: FixtureEntry[] }).fixtures;
}

function decodeFixture(entry: FixtureEntry) {
  const buf = readFileSync(join(FIXTURES, entry.file));
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return decodePsd(arrayBuffer);
}

/** 逐通道比较，返回平均绝对误差与最大差 */
function diff(actual: Uint8ClampedArray | Uint8Array, expected: Uint8Array): { mae: number; max: number } {
  const n = Math.min(actual.length, expected.length);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(actual[i] - expected[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { mae: sum / n, max };
}

/** 每个色彩模式的容差 */
function toleranceFor(entry: FixtureEntry): number {
  if (entry.bitsPerChannel !== 8) return 2;
  switch (entry.colorMode) {
    case 3: // RGB
    case 4: // CMYK
    case 7: // Multichannel
    case 1: // Grayscale
    case 8: // Duotone
      return 2;
    case 9: // Lab
    case 2: // Indexed
      return 12;
    default:
      return 12;
  }
}

/* ------------------------------ 1. 全素材逐像素回归 ------------------------------ */

test('全部素材：解码结果与参考 RGBA 逐像素一致（容差内）', (t) => {
  const manifest = loadManifest();
  if (!manifest) {
    t.skip('缺少 tools/fixtures/manifest.json（先执行 node tools/make-sample-psd.mjs）');
    return;
  }

  const lines: string[] = [];
  const failures: string[] = [];

  for (const entry of manifest) {
    const refPath = join(FIXTURES, entry.rawReference);
    if (!existsSync(refPath) || !existsSync(join(FIXTURES, entry.file))) {
      lines.push(`  · ${entry.file.padEnd(26)} 素材缺失，跳过`);
      continue;
    }

    let decoded;
    try {
      decoded = decodeFixture(entry);
    } catch (error) {
      failures.push(`${entry.file}: 解码抛错 ${(error as Error).message}`);
      lines.push(`  ✗ ${entry.file.padEnd(26)} 解码抛错：${(error as Error).message}`);
      continue;
    }

    // 元数据先对齐
    if (decoded.width !== entry.width || decoded.height !== entry.height) {
      failures.push(`${entry.file}: 尺寸 ${decoded.width}×${decoded.height} ≠ ${entry.width}×${entry.height}`);
    }
    if (decoded.colorModeName !== entry.colorModeName) {
      failures.push(`${entry.file}: 色彩模式名 ${decoded.colorModeName} ≠ ${entry.colorModeName}`);
    }
    if (decoded.channels !== entry.channels) {
      failures.push(`${entry.file}: 通道数 ${decoded.channels} ≠ ${entry.channels}`);
    }
    if (decoded.compression !== entry.compression) {
      failures.push(`${entry.file}: 压缩方式 ${decoded.compression} ≠ ${entry.compression}`);
    }

    const expected = readFileSync(refPath);
    if (decoded.composite.data.length !== expected.length) {
      failures.push(
        `${entry.file}: 像素面长度 ${decoded.composite.data.length} ≠ 参考 ${expected.length}`,
      );
      lines.push(`  ✗ ${entry.file.padEnd(26)} 像素面长度不符`);
      continue;
    }

    const { mae, max } = diff(decoded.composite.data, expected);
    const tolerance = toleranceFor(entry);
    const ok = max <= tolerance;
    if (!ok) failures.push(`${entry.file}: 最大差 ${max} 超过容差 ${tolerance}`);
    lines.push(
      `  ${ok ? '✓' : '✗'} ${entry.file.padEnd(26)} ${entry.colorModeName.padEnd(13)} ` +
        `${String(entry.bitsPerChannel).padStart(2)}bit ${entry.compression.padEnd(3)} ` +
        `MAE=${mae.toFixed(2).padStart(6)} max=${String(max).padStart(3)} (容差 ${tolerance})`,
    );
  }

  t.diagnostic(lines.join('\n'));
  assert.deepEqual(failures, [], `有 ${failures.length} 项与参考数据不符`);
});

/* ------------------------------ 2. 图层树 ------------------------------ */

test('CMYK 素材的图层树：名称、边界、混合模式、不透明度', (t) => {
  const manifest = loadManifest();
  if (!manifest) {
    t.skip('缺少素材');
    return;
  }
  const entry = manifest.find((e) => e.file === 'sample-cmyk-rle.psd');
  if (!entry) {
    t.skip('缺少 sample-cmyk-rle.psd');
    return;
  }

  const decoded = decodeFixture(entry);
  assert.equal(decoded.layers.length, 2, '应由 2 个顶层图层组成');
  assert.deepEqual(
    decoded.layers.map((l) => l.name),
    ['角标', '色卡'],
  );
  assert.equal(decoded.layerCount, 2);

  const chart = decoded.layers[1];
  assert.equal(chart.left, 0);
  assert.equal(chart.top, 0);
  assert.equal(chart.right, 640);
  assert.equal(chart.bottom, 480);
  assert.equal(chart.blendMode, 'normal');
  assert.equal(chart.hidden, false);
  assert.ok(chart.surface, '「色卡」图层应有像素面');
  assert.equal(chart.surface?.width, 640);
  assert.equal(chart.surface?.height, 480);
});

test('RGB 素材的图层树：中文图层名 + 图层组 + screen 混合模式', (t) => {
  const manifest = loadManifest();
  if (!manifest) {
    t.skip('缺少素材');
    return;
  }
  const entry = manifest.find((e) => e.file === 'sample-ui.psd');
  if (!entry) {
    t.skip('缺少 sample-ui.psd');
    return;
  }

  const decoded = decodeFixture(entry);
  assert.equal(decoded.layers.length, 6, '顶层应为 6 个节点');
  assert.equal(decoded.layerCount, 8, '图层总数（含组）应为 8');

  const names = decoded.layers.map((l) => l.name);
  assert.ok(names.includes('高光 · 滤色'), `顶层名称应含中文名，实际：${names.join('、')}`);
  assert.ok(names.includes('文字组'));

  const glow = decoded.layers.find((l) => l.name === '高光 · 滤色');
  assert.ok(glow, '应找到「高光 · 滤色」');
  assert.equal(glow.blendMode, 'screen', '混合模式 key "scrn" 应映射为 "screen"');
  assert.ok(Math.abs(glow.opacity - 0.78) < 0.01, `不透明度应约为 0.78，实际 ${glow.opacity}`);

  const group = decoded.layers.find((l) => l.name === '文字组');
  assert.ok(group, '应找到「文字组」');
  assert.equal(group.children.length, 2, '「文字组」应含 2 个子图层');
  assert.deepEqual(
    group.children.map((l) => l.name),
    ['标题文字占位', '副标题文字占位'],
  );
  assert.equal(group.surface, null, '组图层自身不应有像素面');
  assert.ok(group.children[0].surface, '组内子图层应有像素面');
});

test('含隐藏图层的素材：hidden 标记应被正确读出', (t) => {
  const manifest = loadManifest();
  if (!manifest) {
    t.skip('缺少素材');
    return;
  }
  const entry = manifest.find((e) => e.file === 'sample-ui-hidden.psd');
  if (!entry) {
    t.skip('缺少 sample-ui-hidden.psd');
    return;
  }

  const decoded = decodeFixture(entry);
  const hidden = decoded.layers.filter((l) => l.hidden).map((l) => l.name);
  assert.deepEqual(hidden, ['斜条纹'], `顶层隐藏图层应为「斜条纹」，实际：${JSON.stringify(hidden)}`);

  const group = decoded.layers.find((l) => l.name === '文字组');
  assert.ok(group);
  const hiddenChildren = group.children.filter((l) => l.hidden).map((l) => l.name);
  assert.deepEqual(hiddenChildren, ['副标题文字占位'], '组内隐藏子层应被标记');
});

/* ------------------------------ 3. 色彩换算单元 ------------------------------ */

test('CMYK 换算：与 Pillow 一致的反相墨量 + 乘性公式', async () => {
  const { cmykToRgb } = await import('../src/psd/decode/color.ts');
  // 无墨 → 白
  assert.deepEqual(cmykToRgb(255, 255, 255, 255), [255, 255, 255]);
  // 满墨 → 黑
  assert.deepEqual(cmykToRgb(0, 0, 0, 0), [0, 0, 0]);
  // 只有 K：R = G = B = K
  assert.deepEqual(cmykToRgb(255, 255, 255, 100), [100, 100, 100]);
  // 一般情况：S_C=64, S_M=128, S_Y=200, S_K=200 → (50, 100, 157)
  assert.deepEqual(cmykToRgb(64, 128, 200, 200), [
    Math.round((64 * 200) / 255),
    Math.round((128 * 200) / 255),
    Math.round((200 * 200) / 255),
  ]);
});

test('Lab 换算：黑白端点与中等灰符合 D50 预期', async () => {
  const { labToRgb } = await import('../src/psd/decode/color.ts');
  assert.deepEqual(labToRgb(0, 128, 128), [0, 0, 0], 'L=0 应为黑');
  const white = labToRgb(255, 128, 128);
  assert.ok(white.every((v) => v >= 250), `L=255 应接近纯白，实际 ${white.join(',')}`);
  const mid = labToRgb(221, 128, 128);
  assert.ok(mid[0] === mid[1] && mid[1] === mid[2], 'a=b=0 时应为中性灰');
  assert.ok(mid[0] > 180 && mid[0] < 245, `中等灰应落在合理区间，实际 ${mid[0]}`);
});

test('PackBits 解码：字面量 / 游程 / 128 空操作三种分支', async () => {
  const { decodePackBits } = await import('../src/psd/decode/packbits.ts');
  const out = new Uint8Array(16);
  // 字面量：header=2 → 复制 3 字节
  let written = decodePackBits(new Uint8Array([2, 10, 20, 30]), 0, 4, out, 0, 16);
  assert.equal(written, 3);
  assert.deepEqual(Array.from(out.subarray(0, 3)), [10, 20, 30]);
  // 游程：header=0xFE(254) → 重复 3 次；再来一个 header=0x80 → 空操作
  written = decodePackBits(new Uint8Array([254, 7, 128, 0, 9]), 0, 5, out, 0, 16);
  assert.equal(written, 4, '128 不产出字节');
  assert.deepEqual(Array.from(out.subarray(0, 4)), [7, 7, 7, 9]);
});

/* ------------------------------ 4. 容错 ------------------------------ */

test('非法输入一律抛 PsdDecodeError，且不返回半截数据', () => {
  const cases: Array<[string, Uint8Array, string]> = [
    ['空输入', new Uint8Array(0), 'TRUNCATED'],
    ['不足 4 字节', new Uint8Array(3), 'TRUNCATED'],
    ['签名不是 8BPS', new Uint8Array(26), 'INVALID_SIGNATURE'],
    ['签名与版本合法但整体被截断', (() => {
      const b = new Uint8Array(10);
      const view = new DataView(b.buffer);
      b.set([0x38, 0x42, 0x50, 0x53]); // '8BPS'
      view.setUint16(4, 1, false); // version = 1，但后面不足 26 字节
      return b;
    })(), 'TRUNCATED'],
  ];

  for (const [label, input, expectedCode] of cases) {
    let thrown: unknown = null;
    try {
      decodePsd(input);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof PsdDecodeError, `${label} 应抛 PsdDecodeError，实际 ${String(thrown)}`);
    assert.equal((thrown as PsdDecodeError).code, expectedCode, `${label} 的 code 应为 ${expectedCode}`);
    assert.ok((thrown as PsdDecodeError).message.length > 0, `${label} 应有中文提示`);
  }
});

test('版本非法 / 位深非法 / 色彩模式非法都会被拒绝', () => {
  const build = (mutate: (b: Uint8Array, view: DataView) => void): Uint8Array => {
    const b = new Uint8Array(64);
    const view = new DataView(b.buffer);
    view.setUint8(0, 0x38);
    view.setUint8(1, 0x42);
    view.setUint8(2, 0x50);
    view.setUint8(3, 0x53); // '8BPS'
    view.setUint16(4, 1, false); // version = 1 (PSD)
    view.setUint16(12, 3, false); // channels = 3
    view.setUint32(14, 10, false); // height = 10
    view.setUint32(18, 20, false); // width = 20
    view.setUint16(22, 8, false); // bitsPerChannel = 8
    view.setUint16(24, 3, false); // colorMode = RGB
    mutate(b, view);
    return b;
  };

  const expectCode = (input: Uint8Array, code: string, label: string) => {
    let thrown: unknown = null;
    try {
      decodePsd(input);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof PsdDecodeError, `${label} 应抛 PsdDecodeError，实际 ${String(thrown)}`);
    assert.equal((thrown as PsdDecodeError).code, code, `${label} code 应为 ${code}`);
  };

  expectCode(build((_b, view) => view.setUint16(4, 9, false)), 'UNSUPPORTED_VERSION', '版本 9');
  expectCode(build((_b, view) => view.setUint16(22, 7, false)), 'UNSUPPORTED_BITS', '位深 7');
  expectCode(build((_b, view) => view.setUint16(24, 5, false)), 'UNSUPPORTED_COLOR_MODE', '色彩模式 5');
  expectCode(build((_b, view) => view.setUint32(18, 0, false)), 'INVALID_DIMENSION', '宽度为 0');
  expectCode(build((_b, view) => view.setUint32(14, 0, false)), 'INVALID_DIMENSION', '高度为 0');
  expectCode(build((_b, view) => view.setUint16(12, 0, false)), 'INVALID_HEADER', '通道数为 0');
  expectCode(build((b) => { b[6] = 1; }), 'INVALID_HEADER', '保留字段非 0');
  // 合法文件头但缺少后续段落 → 应报截断而不是崩溃
  expectCode(build(() => {}), 'TRUNCATED', '缺少色彩模式数据段');
});

test('引擎路由：requiresFallbackEngine 的真值表', async () => {
  const { requiresFallbackEngine } = await import('../src/psd/decode/capabilities.ts');
  // ag-psd 支持且 8 位 → 不需要兜底
  for (const mode of [1, 2, 3]) {
    assert.equal(requiresFallbackEngine(mode, 8), false, `模式 ${mode} 8 位应由 ag-psd 处理`);
  }
  // ag-psd 不支持的色彩模式 → 需要兜底
  for (const mode of [0, 4, 7, 8, 9]) {
    assert.equal(requiresFallbackEngine(mode, 8), true, `模式 ${mode} 需要兜底解码`);
  }
  // 16 位一律走兜底（ag-psd 的 16 位 RLE 会错位）
  for (const mode of [1, 2, 3, 4]) {
    assert.equal(requiresFallbackEngine(mode, 16), true, `模式 ${mode} 16 位需要兜底解码`);
  }
});
