#!/usr/bin/env node
/**
 * 用 ag-psd 反向解析 tools/fixtures 下的示例 PSD，验证：
 *  1) 手写生成的 PSD 结构合法（能被成熟库解析，也就能被 Photoshop 打开）；
 *  2) 图层树、图层组、混合模式、不透明度、位置都能被读出来；
 *  3) 合成图存在且尺寸正确 —— 这正是前端 PsdViewer 依赖的东西。
 *
 * 任一断言失败即以非 0 退出码结束。
 * 用法：`npm --prefix tools run verify`
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPsd, initializeCanvas } from 'ag-psd';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

/*
 * ag-psd 是跨环境库：只要传了 useImageData: false，它就会调用 createCanvas 造 canvas，
 * 在 Node 下必须先 initializeCanvas。浏览器里用 document.createElement('canvas')，
 * 这里用一个只记录尺寸、绘图操作全部空转的桩对象即可满足「结构校验」的目的。
 */
function createStubCanvas(width, height) {
  const ctx = {
    canvas: null,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
    drawImage: () => {},
    clearRect: () => {},
    fillRect: () => {},
    save: () => {},
    restore: () => {},
  };
  const canvas = { width, height, getContext: () => ctx };
  ctx.canvas = canvas;
  return canvas;
}
initializeCanvas(createStubCanvas);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` （期望 ${JSON.stringify(expected)}）`}`);
}
function checkTruthy(label, value) {
  const ok = Boolean(value);
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}: ${JSON.stringify(value)}`);
}

const COLOR_MODES = { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };

function describe(node, depth = 0) {
  const pad = '  '.repeat(depth + 1);
  const kind = node.children ? '组' : '图层';
  const size = `${(node.right ?? 0) - (node.left ?? 0)}×${(node.bottom ?? 0) - (node.top ?? 0)}`;
  console.log(
    `${pad}· [${kind}] ${JSON.stringify(node.name)}  位置=(${node.left ?? 0},${node.top ?? 0}) 尺寸=${size} ` +
      `不透明度=${Math.round((node.opacity ?? 1) * 100)}% 混合=${node.blendMode ?? 'normal'}` +
      `${node.hidden ? ' (隐藏)' : ''}`,
  );
  for (const child of node.children ?? []) describe(child, depth + 1);
}

function countLayers(nodes) {
  let total = 0;
  for (const n of nodes) {
    total += 1;
    if (n.children) total += countLayers(n.children);
  }
  return total;
}

function verifyFile(fileName, expectations) {
  const abs = join(FIXTURES, fileName);
  console.log(`\n=== ${fileName} ===`);
  if (!existsSync(abs)) {
    failures++;
    console.log('  ✗ 文件不存在，请先运行 `node tools/make-sample-psd.mjs`');
    return;
  }
  const buf = readFileSync(abs);
  check('文件头签名', buf.subarray(0, 4).toString('latin1'), '8BPS');

  let psd;
  try {
    psd = readPsd(buf, { skipThumbnail: true, useImageData: false, skipCompositeImageData: false });
  } catch (err) {
    failures++;
    console.log(`  ✗ ag-psd 解析抛异常：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  console.log('  —— ag-psd 解析结果 ——');
  check('width', psd.width, expectations.width);
  check('height', psd.height, expectations.height);
  check('bitsPerChannel', psd.bitsPerChannel, 8);
  check('colorMode', COLOR_MODES[psd.colorMode] ?? psd.colorMode, 'RGB');
  check('顶层图层数', (psd.children ?? []).length, expectations.topLevel);
  check('图层总数（含组内）', countLayers(psd.children ?? []), expectations.total);
  checkTruthy('合成图 canvas 存在', Boolean(psd.canvas));

  console.log('  —— 图层树 ——');
  for (const node of psd.children ?? []) describe(node, 1);

  if (psd.canvas) {
    check('合成图尺寸', [psd.canvas.width, psd.canvas.height], [expectations.width, expectations.height]);
  }
  if (expectations.mustContainGroup) {
    const hasGroup = (psd.children ?? []).some((c) => Array.isArray(c.children) && c.children.length > 0);
    checkTruthy('包含图层组且组内有子图层', hasGroup);
  }
  if (expectations.mustContainScreen) {
    const flat = [];
    (function walk(nodes) {
      for (const n of nodes ?? []) {
        flat.push(n);
        walk(n.children);
      }
    })(psd.children);
    checkTruthy(
      "包含 'screen' 混合模式图层",
      flat.some((n) => n.blendMode === 'screen'),
    );
    checkTruthy(
      '存在非 100% 不透明度的图层',
      flat.some((n) => typeof n.opacity === 'number' && n.opacity < 1),
    );
  }
}

verifyFile('sample-ui.psd', { width: 1200, height: 800, topLevel: 6, total: 8, mustContainGroup: true, mustContainScreen: true });
verifyFile('sample-mini.psd', { width: 320, height: 200, topLevel: 2, total: 2 });

console.log('');
if (failures > 0) {
  console.error(`✗ 校验未通过：${failures} 项断言失败`);
  process.exit(1);
}
console.log('✓ 全部断言通过：示例 PSD 结构合法，ag-psd 可完整解析（含图层组与混合模式）');
