/**
 * 渲染管线回归测试：用**真实的 Canvas2D 实现**跑一遍前端的完整渲染链路
 * （loadPsd → normalizeLayerTree → renderLayers），并与素材的裸 RGBA 参考数据逐像素比对。
 *
 * 为什么需要这个测试：在此之前，图层合成只被单元测试覆盖到「边界/树结构」层面，
 * 真正把像素画到画布上的那一段从未被执行过 —— 而这恰恰是最容易出问题的地方。
 * 用 @napi-rs/canvas（Skia 的 Node 绑定，预编译无需 node-gyp）注入 document/ImageData，
 * 前端的渲染代码就能原样在 Node 里跑。
 *
 * 覆盖的关键语义：
 *   1. **PSD 自带合成图 = Photoshop 按可见图层烘焙的结果**，因此只要用户没改过显隐，
 *      就应该直接用合成图 —— 它天然满足「显示所有已显示的图层、忽略被隐藏的图层」。
 *   2. 一旦用户切换了任一图层显隐，就必须退化为逐层合成。
 *   3. 含隐藏图层的工程**不能**被降级渲染（这正是曾经的缺陷：
 *      用「是否所有图层都可见」当判据，导致所有带隐藏图层的 PSD 都走逐层合成）。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createCanvas, ImageData as NapiImageData } from '@napi-rs/canvas';

/* ------------------------------ 浏览器环境注入 ------------------------------ */
// 必须在调用 loadPsd/renderLayers **之前**注入（这两个模块都是惰性使用 DOM 的）
(globalThis as unknown as { ImageData: unknown }).ImageData = NapiImageData;
(globalThis as unknown as { document: unknown }).document = {
  createElement(tag: string) {
    assert.equal(tag, 'canvas', '前端只应创建 canvas 元素');
    return createCanvas(1, 1);
  },
};

const { loadPsd } = await import('../src/psd/loadPsd.ts');
const { renderLayers, canUseComposite, downscaleCanvas } = await import('../src/psd/render.ts');
const { createVisibilityMap, flattenLayers, matchesOriginalVisibility } = await import('../src/psd/layerTree.ts');

type AnyCanvas = ReturnType<typeof createCanvas>;
type Loaded = Awaited<ReturnType<typeof loadPsd>>;

const FIXTURES = join(import.meta.dirname, '..', '..', 'tools', 'fixtures');

function loadFixture(name: string): { loaded: Loaded; reference: Buffer } | null {
  const psdPath = join(FIXTURES, `${name}.psd`);
  const refPath = join(FIXTURES, `${name}.rgba`);
  if (!existsSync(psdPath) || !existsSync(refPath)) return null;
  const buf = readFileSync(psdPath);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { loaded: loadPsd(arrayBuffer), reference: readFileSync(refPath) };
}

/** 逐通道比较，返回平均绝对误差与最大差 */
function diff(a: Uint8ClampedArray | Uint8Array, b: Buffer): { mae: number; max: number } {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { mae: sum / n, max };
}

function pixelsOf(canvas: unknown): Uint8ClampedArray {
  const c = canvas as AnyCanvas;
  const ctx = c.getContext('2d');
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

function render(loaded: Loaded, visibility: Record<string, boolean>, forceLayerRender: boolean) {
  return renderLayers(loaded.tree, {
    width: loaded.width,
    height: loaded.height,
    visibility,
    compositeCanvas: loaded.compositeCanvas,
    forceLayerRender,
  });
}

/* ------------------------------ 1. 渲染结果与参考图一致 ------------------------------ */

test('sample-ui.psd：未改动显隐时走合成图，与参考图逐像素一致', (t) => {
  const fixture = loadFixture('sample-ui');
  if (!fixture) {
    t.skip('缺少 tools/fixtures/sample-ui.psd（先执行 node tools/make-sample-psd.mjs）');
    return;
  }
  const { loaded, reference } = fixture;
  const visibility = createVisibilityMap(loaded.tree);

  assert.ok(loaded.compositeCanvas, 'PSD 自带合成图应存在');
  assert.equal(canUseComposite(loaded.tree, visibility, loaded.compositeCanvas, false), true, '未改动显隐时应可用合成图');

  const fast = diff(pixelsOf(render(loaded, visibility, false)), reference);
  assert.ok(fast.mae < 1, `合成图路径应逐像素一致，实际 MAE=${fast.mae.toFixed(2)} max=${fast.max}`);

  // 逐层合成是近似实现（混合模式映射），允许可见范围内的误差，但必须有内容
  const layered = diff(pixelsOf(render(loaded, visibility, true)), reference);
  assert.ok(layered.mae < 8, `逐层合成 MAE 应在可接受范围，实际 ${layered.mae.toFixed(2)}`);
});

test('sample-mini.psd：小尺寸素材逐层合成同样正确', (t) => {
  const fixture = loadFixture('sample-mini');
  if (!fixture) {
    t.skip('缺少 tools/fixtures/sample-mini.psd');
    return;
  }
  const { loaded, reference } = fixture;
  const visibility = createVisibilityMap(loaded.tree);
  const layered = diff(pixelsOf(render(loaded, visibility, true)), reference);
  assert.ok(layered.mae < 3, `逐层合成 MAE 应很小，实际 ${layered.mae.toFixed(2)} max=${layered.max}`);
});

/* ------------------------------ 2. 隐藏图层语义（缺陷回归） ------------------------------ */

test('含隐藏图层的工程不得被降级渲染：未改动显隐时仍应使用合成图', (t) => {
  const fixture = loadFixture('sample-ui-hidden');
  if (!fixture) {
    t.skip('缺少 tools/fixtures/sample-ui-hidden.psd');
    return;
  }
  const { loaded, reference } = fixture;
  const visibility = createVisibilityMap(loaded.tree);

  const hiddenNames = flattenLayers(loaded.tree)
    .filter((node) => node.hidden)
    .map((node) => node.name);
  assert.ok(hiddenNames.length > 0, `该素材应包含隐藏图层，实际：${JSON.stringify(hiddenNames)}`);
  assert.equal(flattenLayers(loaded.tree).every((n) => !n.hidden), false, '并非所有图层都可见');

  // 这才是关键断言：即使存在隐藏图层，只要用户没改过开关，就仍应走合成图。
  // 旧实现用「所有图层都可见」作为判据，会让本用例返回 false，从而降级为逐层合成。
  assert.equal(
    matchesOriginalVisibility(loaded.tree, visibility),
    true,
    'createVisibilityMap 生成的表应与 PSD 原始 hidden 标记一致',
  );
  assert.equal(
    canUseComposite(loaded.tree, visibility, loaded.compositeCanvas, false),
    true,
    '存在隐藏图层时也必须能用合成图（合成图本就是按可见图层烘焙的）',
  );

  const rendered = diff(pixelsOf(render(loaded, visibility, false)), reference);
  assert.ok(rendered.mae < 1, `应呈现「所有可见图层」的完整画面，实际 MAE=${rendered.mae.toFixed(2)} max=${rendered.max}`);

  // 逐层合成时也必须忽略隐藏图层（结果同样应接近参考图）
  const layered = diff(pixelsOf(render(loaded, visibility, true)), reference);
  assert.ok(layered.mae < 8, `逐层合成需忽略隐藏图层，实际 MAE=${layered.mae.toFixed(2)}`);
});

test('用户切换显隐后必须退化为逐层合成，且显隐变化要真的反映到画面上', (t) => {
  const fixture = loadFixture('sample-ui-hidden');
  if (!fixture) {
    t.skip('缺少 tools/fixtures/sample-ui-hidden.psd');
    return;
  }
  const { loaded, reference } = fixture;
  const base = createVisibilityMap(loaded.tree);
  const hidden = flattenLayers(loaded.tree).find((node) => node.hidden);
  assert.ok(hidden, '应能找到一个隐藏图层');

  // 把隐藏图层打开 → 显隐表不再等于原始状态
  const toggled = { ...base, [hidden.id]: true };
  assert.equal(matchesOriginalVisibility(loaded.tree, toggled), false, '改动后不应再算作未触碰');
  assert.equal(canUseComposite(loaded.tree, toggled, loaded.compositeCanvas, false), false, '改动后不可再用合成图');

  const rendered = diff(pixelsOf(render(loaded, toggled, true)), reference);
  assert.ok(rendered.mae > 0.2, `打开隐藏图层后画面应当发生变化，实际 MAE=${rendered.mae.toFixed(2)}`);
});

/* ------------------------------ 3. 逐层合成的显隐正确性 ------------------------------ */

test('只保留单个图层可见时，画布内容应恰好来自该图层', (t) => {
  const fixture = loadFixture('sample-mini');
  if (!fixture) {
    t.skip('缺少 tools/fixtures/sample-mini.psd');
    return;
  }
  const { loaded } = fixture;
  const all = flattenLayers(loaded.tree);
  const target = all.find((node) => node.name === '圆点');
  assert.ok(target, '应找到「圆点」图层');

  const only = Object.fromEntries(all.map((node) => [node.id, node.id === target.id]));
  const data = pixelsOf(render(loaded, only, true));

  let nonTransparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonTransparent++;
  assert.ok(nonTransparent > 0, '「圆点」图层应当被画出来');

  // 圆点是画面中央的圆形，四角应仍然透明（说明背景图层确实没被画上）
  const cornerAlpha = data[3];
  assert.equal(cornerAlpha, 0, '背景图层不应出现在只有「圆点」可见的渲染结果里');
});

test('组图层按子层并集渲染：组内子图层可见性生效', (t) => {
  const fixture = loadFixture('sample-ui');
  if (!fixture) {
    t.skip('缺少 tools/fixtures/sample-ui.psd');
    return;
  }
  const { loaded } = fixture;
  const group = flattenLayers(loaded.tree).find((node) => node.kind === 'group');
  assert.ok(group, '示例素材应包含图层组');
  assert.equal(group.children.length, 2, '「文字组」应含 2 个子图层');

  const all = flattenLayers(loaded.tree);
  // 组可见 + 只开组内第一个子层：组内第二个子层不应被画出
  const visibility = Object.fromEntries(all.map((node) => [node.id, false]));
  visibility[group.id] = true;
  visibility[group.children[0].id] = true;

  const withFirst = pixelsOf(render(loaded, visibility, true));
  visibility[group.children[1].id] = true;
  const withBoth = pixelsOf(render(loaded, visibility, true));

  let differing = 0;
  for (let i = 0; i < withFirst.length; i++) if (withFirst[i] !== withBoth[i]) differing++;
  assert.ok(differing > 0, '打开组内第二个子图层后画面应当发生变化');
});

/* ------------------------------ 5. 双引擎路由与集成 ------------------------------ */

/**
 * `loadPsd` 按文件头选择引擎：
 *   · 8 位 RGB / Grayscale / Indexed → ag-psd 主引擎
 *   · CMYK / Lab / Multichannel / Duotone / 任意 16 位 → 内置兜底解码器
 * 两条路径都必须产出**同形状**的 LoadedPsd（图层树带 canvas、有合成图），
 * 这样渲染层与界面层完全不需要分支。
 */
test('loadPsd 按色彩模式与位深选择正确的引擎', (t) => {
  const expectations: Array<[string, 'ag-psd' | 'fallback']> = [
    ['sample-ui', 'ag-psd'],
    ['sample-mini', 'ag-psd'],
    ['sample-gray', 'ag-psd'],
    ['sample-indexed', 'ag-psd'],
    ['sample-cmyk-rle', 'fallback'],
    ['sample-cmyk-raw', 'fallback'],
    ['sample-cmyk-16', 'fallback'],
    ['sample-lab', 'fallback'],
    ['sample-multichannel', 'fallback'],
    ['sample-duotone', 'fallback'],
    ['sample-rgb16', 'fallback'],
  ];

  for (const [name, expectedEngine] of expectations) {
    const fixture = loadFixture(name);
    if (!fixture) {
      t.skip(`缺少 ${name} 素材`);
      return;
    }
    assert.equal(
      fixture.loaded.engine,
      expectedEngine,
      `${name} 应由 ${expectedEngine} 引擎处理，实际 ${fixture.loaded.engine}`,
    );
  }
});

test('CMYK 工程经兜底引擎解码后：元信息、图层树、合成图都可用', (t) => {
  const fixture = loadFixture('sample-cmyk-rle');
  if (!fixture) {
    t.skip('缺少 sample-cmyk-rle 素材');
    return;
  }
  const { loaded, reference } = fixture;

  assert.equal(loaded.engine, 'fallback');
  assert.equal(loaded.colorMode, 'CMYK');
  assert.equal(loaded.bitsPerChannel, 8);
  assert.equal(loaded.meta.channels, 4, '应报告 4 个通道');
  assert.equal(loaded.meta.approximate, false, 'CMYK 属于色彩换算而非近似，不应标记为近似');
  assert.ok(loaded.compositeCanvas, '兜底引擎必须产出合成图');
  assert.equal(loaded.layerCount, 2, '图层总数应为 2');
  assert.equal(loaded.tree.length, 2);
  assert.ok(loaded.tree.every((node) => node.canvas !== null), '每个图层都应有可绘制的位图');

  // 渲染结果必须与参考 RGBA 一致（合成图路径）
  const visibility = createVisibilityMap(loaded.tree);
  const rendered = diff(pixelsOf(render(loaded, visibility, false)), reference);
  assert.ok(rendered.mae < 1, `CMYK 合成图应与参考图一致，实际 MAE=${rendered.mae.toFixed(2)}`);

  // 逐层合成同样应接近（验证图层位图确实带上了正确的像素）
  const layered = diff(pixelsOf(render(loaded, visibility, true)), reference);
  assert.ok(layered.mae < 2, `CMYK 逐层合成应接近参考图，实际 MAE=${layered.mae.toFixed(2)}`);
});

test('16 位 RGB 走兜底引擎且结果正确（ag-psd 的 16 位 RLE 会错位）', (t) => {
  const fixture = loadFixture('sample-rgb16');
  if (!fixture) {
    t.skip('缺少 sample-rgb16 素材');
    return;
  }
  const { loaded, reference } = fixture;

  assert.equal(loaded.engine, 'fallback', '16 位必须走兜底引擎');
  assert.equal(loaded.bitsPerChannel, 16);

  const visibility = createVisibilityMap(loaded.tree);
  const rendered = diff(pixelsOf(render(loaded, visibility, false)), reference);
  assert.ok(rendered.mae < 1, `16 位合成图应与参考图一致，实际 MAE=${rendered.mae.toFixed(2)} max=${rendered.max}`);
});

test('近似预览的色彩模式会被正确标注（Duotone / Multichannel）', (t) => {
  for (const name of ['sample-duotone', 'sample-multichannel']) {
    const fixture = loadFixture(name);
    if (!fixture) {
      t.skip(`缺少 ${name} 素材`);
      return;
    }
    const { loaded } = fixture;
    assert.equal(loaded.engine, 'fallback', `${name} 应走兜底引擎`);
    assert.equal(loaded.meta.approximate, true, `${name} 应被标记为近似预览`);
    assert.ok(
      typeof loaded.meta.approxReason === 'string' && loaded.meta.approxReason.length > 0,
      `${name} 应给出可展示的近似原因`,
    );
    assert.ok(
      loaded.warnings.some((w) => w.length > 0),
      `${name} 应带上中文警告说明`,
    );
  }
});

test('竖版 CMYK 之外的引擎路由不影响自动预览图比例', (t) => {
  const fixture = loadFixture('sample-cmyk-rle');
  if (!fixture) {
    t.skip('缺少素材');
    return;
  }
  const { loaded } = fixture;
  const canvas = renderLayers(loaded.tree, {
    width: loaded.width,
    height: loaded.height,
    visibility: createVisibilityMap(loaded.tree),
    compositeCanvas: loaded.compositeCanvas,
  });
  const scaled = downscaleCanvas(canvas, 1600);
  assert.ok(
    Math.abs(scaled.width / scaled.height - loaded.width / loaded.height) < 0.01,
    '兜底引擎下比例同样必须保持',
  );
});

/* ------------------------------ 6. 自动生成预览图的尺寸 ------------------------------ */

/**
 * 上传时自动生成的预览图必须**按原始画布比例**产出，不能被写成任何固定比例
 * （例如误用 9:16 之类的"常见比例"）。
 *
 * 这里跑的是 UploadPage 里那条真实链路：
 *   loadPsd → renderLayers（默认显隐）→ downscaleCanvas(1600) → toBlob('image/png')
 */
function generateThumbnail(loaded: Loaded): { width: number; height: number } {
  const canvas = renderLayers(loaded.tree, {
    width: loaded.width,
    height: loaded.height,
    visibility: createVisibilityMap(loaded.tree),
    compositeCanvas: loaded.compositeCanvas,
  });
  const scaled = downscaleCanvas(canvas, 1600);
  return { width: scaled.width, height: scaled.height };
}

test('自动生成的预览图严格跟随画布比例（横版素材）', (t) => {
  for (const name of ['sample-ui', 'sample-mini']) {
    const fixture = loadFixture(name);
    if (!fixture) {
      t.skip(`缺少 ${name} 素材`);
      return;
    }
    const { loaded } = fixture;
    const thumb = generateThumbnail(loaded);
    const canvasRatio = loaded.width / loaded.height;
    const thumbRatio = thumb.width / thumb.height;
    assert.ok(
      Math.abs(canvasRatio - thumbRatio) < 0.01,
      `${name}：缩略图比例 ${thumbRatio.toFixed(4)} 应与画布比例 ${canvasRatio.toFixed(4)} 一致（实际 ${thumb.width}×${thumb.height}）`,
    );
  }
});

test('竖版画布（1080×2340）不得被套用任何固定比例，长边压到 1600 后比例不变', (t) => {
  const fixture = loadFixture('sample-portrait');
  if (!fixture) {
    t.skip('缺少 tools/fixtures/sample-portrait.psd');
    return;
  }
  const { loaded } = fixture;
  assert.equal(loaded.width, 1080, '竖版素材宽度应为 1080');
  assert.equal(loaded.height, 2340, '竖版素材高度应为 2340');

  const thumb = generateThumbnail(loaded);

  // 长边必须被压到 1600 以内，短边等比缩放
  assert.equal(Math.max(thumb.width, thumb.height), 1600, '长边应被压到 1600');
  assert.ok(thumb.height > thumb.width, '竖版画布的缩略图必须仍然是竖版');

  const canvasRatio = loaded.width / loaded.height; // 0.4615
  const thumbRatio = thumb.width / thumb.height;
  assert.ok(
    Math.abs(canvasRatio - thumbRatio) < 0.01,
    `缩略图比例 ${thumbRatio.toFixed(4)} 应等于画布比例 ${canvasRatio.toFixed(4)}（实际 ${thumb.width}×${thumb.height}）`,
  );

  // 明确排除"写死 9:16"这种实现：9/16 = 0.5625，与 0.4615 差异远大于容差
  assert.ok(
    Math.abs(thumbRatio - 9 / 16) > 0.05,
    `缩略图不应是 9:16（9:16=${(9 / 16).toFixed(4)}，实际 ${thumbRatio.toFixed(4)}）`,
  );
  assert.equal(thumb.width, Math.round((1080 * 1600) / 2340), '短边应为等比计算值');
});
