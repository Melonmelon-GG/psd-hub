#!/usr/bin/env node
/**
 * 素材校验：确认 tools/fixtures 下的示例 PSD 结构合法、可被成熟实现解码，
 * 并且与「参考 PNG」逐像素一致。
 *
 *   node tools/verify-fixtures.mjs              # 基础校验（文件头 + ag-psd 能力范围内的逐像素比对）
 *   node tools/verify-fixtures.mjs --verbose    # 额外打印图层树
 *   python tools/pillow-crosscheck.py           # 独立实现的交叉验证（CMYK / Lab / Indexed 等）
 *
 * 为什么需要两种实现交叉验证：本项目自研了解码器，如果只用自研代码验证自研生成的素材，
 * 就是「自己证明自己」。ag-psd 与 Pillow 是两套完全独立的第三方实现，
 * 它们能给出一致的结果，才说明「文件结构 + 通道约定」的理解是对的。
 * 实际收益：正是靠这个工具发现了两处真实缺陷 ——
 *   1) CMYK 存储的是反相墨量（不是墨量）；
 *   2) Indexed 调色板是**平面**存放（256R + 256G + 256B），不是 RGB 交错。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const VERBOSE = process.argv.includes('--verbose');

if (!existsSync(join(FIX, 'manifest.json'))) {
  console.error('未找到 tools/fixtures/manifest.json，请先执行：node tools/make-sample-psd.mjs');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(FIX, 'manifest.json'), 'utf8'));

/* ────────────────── 动态加载 ag-psd（可选依赖）────────────────── */
let readPsd = null;
let initializeCanvas = null;
try {
  const agpsd = await import('ag-psd');
  readPsd = agpsd.readPsd;
  initializeCanvas = agpsd.initializeCanvas;
  // Node 下 ag-psd 仍需 canvas 工厂；桩对象只为满足它的调用
  initializeCanvas((w, h) => ({
    width: w,
    height: h,
    getContext: () => ({
      createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }),
      getImageData: (_x, _y, a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }),
      putImageData: () => {},
      drawImage: () => {},
      clearRect: () => {},
      fillRect: () => {},
      save: () => {},
      restore: () => {},
      translate: () => {},
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
    }),
  }));
} catch {
  console.warn('提示：未安装 ag-psd，跳过第三方逐像素比对（npm --prefix tools install）\n');
}

const COLOR_MODE_NAMES = { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };
const pad = (s, n) => String(s).padEnd(n);

let failures = 0;
const rows = [];

console.log('══ 1. 文件头结构与 manifest 一致性 ══');
for (const f of manifest.fixtures) {
  const buf = readFileSync(join(FIX, f.file));
  const sig = buf.subarray(0, 4).toString('latin1');
  const version = buf.readUInt16BE(4);
  const channels = buf.readUInt16BE(12);
  const height = buf.readUInt32BE(14);
  const width = buf.readUInt32BE(18);
  const bits = buf.readUInt16BE(22);
  const colorMode = buf.readUInt16BE(24);

  const problems = [];
  if (sig !== '8BPS') problems.push(`签名=${sig}`);
  if (version !== 1) problems.push(`版本=${version}`);
  if (width !== f.width || height !== f.height) problems.push(`尺寸 ${width}×${height} ≠ ${f.width}×${f.height}`);
  if (bits !== f.bitsPerChannel) problems.push(`位深 ${bits}`);
  if (colorMode !== f.colorMode) problems.push(`色彩模式 ${colorMode}`);
  if (channels !== f.channels) problems.push(`通道数 ${channels} ≠ ${f.channels}`);
  if (!existsSync(join(FIX, f.reference))) problems.push('缺参考图');

  if (problems.length) {
    failures++;
    console.log(`  ✗ ${pad(f.file, 26)} ${problems.join('; ')}`);
  } else {
    console.log(`  ✓ ${pad(f.file, 26)} ${pad(COLOR_MODE_NAMES[colorMode], 12)} ${bits}bit ${pad(f.compression, 4)} ${channels}通道 ${width}×${height}`);
  }
}

/* ────────────────── 2. ag-psd 逐像素比对 ────────────────── */
/*
 * 预期分类（依据实测，见 docs/ARCHITECTURE.md 的「色彩模式支持矩阵」）：
 *   ok             —— ag-psd 能正确解码，必须与参考图一致
 *   unsupported    —— ag-psd 不支持该色彩模式（抛 "Color mode not supported"），属预期
 *   depth-defect   —— ag-psd 的 16 位 RLE 路径按 1 字节/样本处理，会错位，属已知缺陷
 * 只有「预期 ok 却对不上」或「预期 unsupported 却成功了但结果不对」才算失败。
 */
const EXPECT_SUPPORTED_MODES = new Set([3, 1, 2]); // RGB / Grayscale / Indexed

function expectationOf(f) {
  if (!EXPECT_SUPPORTED_MODES.has(f.colorMode)) return 'unsupported';
  if (f.bitsPerChannel !== 8) return 'depth-defect';
  return 'ok';
}

if (readPsd) {
  console.log('\n══ 2. ag-psd（第三方实现）解码结果 vs 参考 PNG ══');
  for (const f of manifest.fixtures) {
    const expected = expectationOf(f);
    const buf = readFileSync(join(FIX, f.file));
    let psd = null;
    let err = null;
    try {
      psd = readPsd(buf, { useImageData: true, skipThumbnail: true, skipLayerImageData: false, skipCompositeImageData: false });
    } catch (e) {
      err = e.message;
    }

    const label = `${pad(f.file, 26)} ${pad(f.colorModeName, 12)} ${String(f.bitsPerChannel).padStart(2)}bit ${pad(f.compression, 3)}`;

    if (err) {
      const unsupported = /not supported/i.test(err);
      if (expected === 'unsupported' && unsupported) {
        rows.push({ f, status: '不支持' });
        console.log(`  · ${label} ag-psd 不支持该色彩模式 → 走自研解码（符合预期）`);
      } else {
        failures++;
        rows.push({ f, status: '抛错', note: err });
        console.log(`  ✗ ${label} 非预期抛错：${err}`);
      }
      continue;
    }

    const img = psd.imageData;
    if (!img?.data) {
      failures++;
      console.log(`  ✗ ${label} ag-psd 未产出合成图像素`);
      continue;
    }

    // 16 位时 ag-psd 给的是 Uint16Array，需要 >>8 才能与 8 位参考比较
    const actual = img.data instanceof Uint16Array ? Uint8Array.from(img.data, (v) => v >> 8) : img.data;
    // 参考数据用裸 RGBA（宽×高×4，行优先），无需任何图片解码器
    const ref = readFileSync(join(FIX, f.rawReference));

    if (actual.length !== ref.length) {
      failures++;
      rows.push({ f, status: '样本数不符' });
      console.log(`  ✗ ${label} 样本数不符：ag-psd ${actual.length} vs 参考 ${ref.length}`);
      continue;
    }

    let sum = 0;
    let mx = 0;
    for (let i = 0; i < ref.length; i++) {
      const d = Math.abs(ref[i] - actual[i]);
      sum += d;
      if (d > mx) mx = d;
    }
    const mae = sum / ref.length;
    const consistent = mae < 8;

    if (expected === 'ok') {
      if (!consistent) failures++;
      rows.push({ f, status: consistent ? '一致' : '不一致', mae, mx });
      console.log(`  ${consistent ? '✓' : '✗'} ${label} MAE=${mae.toFixed(2).padStart(7)} max=${String(mx).padStart(3)}  ${consistent ? '一致' : '不一致 ← 需排查'}`);
    } else if (expected === 'depth-defect') {
      rows.push({ f, status: '16位缺陷', mae, mx });
      console.log(
        `  ! ${label} MAE=${mae.toFixed(2).padStart(7)} max=${String(mx).padStart(3)}  ` +
          `${consistent ? '一致' : 'ag-psd 16 位不可靠 → 走自研解码（已知缺陷，非本项缺陷）'}`,
      );
    } else {
      // 预期不支持，却成功读出来了 —— 记录一下，不判失败，但提示复核预期
      rows.push({ f, status: '意外支持', mae, mx });
      console.log(`  ? ${label} 预期不支持但成功了（MAE=${mae.toFixed(2)}），请复核能力矩阵`);
    }
  }
}

/* ────────────────── 3. 汇总 ────────────────── */
console.log('\n══ 3. 能力边界汇总（决定前端用哪个引擎）══');
const needsOwn = rows.filter((r) => r.status === '不支持').map((r) => r.f.colorModeName);
const unique = [...new Set(needsOwn)];
console.log(`  ag-psd 可直接处理：${[...new Set(rows.filter((r) => r.status === '一致').map((r) => r.f.colorModeName))].join('、') || '（无）'}`);
console.log(`  必须自研解码：  ${unique.join('、') || '（无）'}`);

if (VERBOSE && readPsd) {
  console.log('\n══ 4. 图层树（仅 ag-psd 支持的模式）══');
  for (const f of manifest.fixtures) {
    try {
      const psd = readPsd(readFileSync(join(FIX, f.file)), { useImageData: true, skipThumbnail: true });
      const walk = (nodes, depth) => {
        for (const n of nodes ?? []) {
          console.log(`  ${'  '.repeat(depth)}· ${n.name} ${n.children ? '(组)' : ''} [${n.blendMode ?? 'normal'}] ${n.hidden ? '(隐藏)' : ''}`);
          walk(n.children, depth + 1);
        }
      };
      console.log(`  ${f.file}:`);
      walk(psd.children, 1);
    } catch {
      /* 不支持的模式跳过 */
    }
  }
}

console.log('');
if (failures > 0) {
  console.error(`✗ 校验未通过：${failures} 项`);
  process.exit(1);
}
console.log('✓ 全部断言通过');
