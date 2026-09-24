/**
 * ag-psd 集成测试：证明「PSD 写入 → 读取」链路与前端图层树规整在真实数据上可用。
 *
 * Node 环境没有 document，若 readPsd 收到 useImageData: false 会调用 createCanvas
 * 并抛出 'Canvas not initialized'。这里用 initializeCanvas 注入一个最小 stub，
 * 从而走与浏览器一致的分支（图层得到 canvas）。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { initializeCanvas, readPsd, writePsd } from 'ag-psd';

import { countForest, normalizeLayerTree } from '../src/psd/layerTree.ts';

/** 最小可用的 canvas stub：满足 ag-psd 对 getContext('2d') 的需求 */
function createStubCanvas(width: number, height: number) {
  const noop = () => undefined;
  const context = {
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: noop,
    drawImage: noop,
    clearRect: noop,
    fillRect: noop,
    save: noop,
    restore: noop,
    translate: noop,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  };

  return {
    width,
    height,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
}

initializeCanvas((width: number, height: number) => createStubCanvas(width, height));

/** 鸭子类型的 ImageData（Node 无全局 ImageData） */
function fakeImageData(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

/* ------------------------------ 合成 PSD 往返 ------------------------------ */

test('writePsd → readPsd 往返：画布尺寸与图层名正确', () => {
  const source = {
    width: 64,
    height: 48,
    children: [
      {
        name: '底层-红',
        left: 0,
        top: 0,
        right: 64,
        bottom: 48,
        opacity: 1,
        hidden: false,
        blendMode: 'normal' as const,
        imageData: fakeImageData(64, 48, [220, 40, 40, 255]),
      },
      {
        name: '组-测试组',
        left: 8,
        top: 8,
        right: 40,
        bottom: 32,
        opacity: 0.5,
        blendMode: 'multiply' as const,
        children: [
          {
            name: '组内-蓝',
            left: 8,
            top: 8,
            right: 40,
            bottom: 32,
            hidden: true,
            blendMode: 'linear burn' as const,
            imageData: fakeImageData(32, 24, [40, 80, 220, 255]),
          },
        ],
      },
      {
        name: '顶层-绿',
        left: 16,
        top: 12,
        right: 48,
        bottom: 36,
        blendMode: 'screen' as const,
        clipping: true,
        imageData: fakeImageData(32, 24, [40, 200, 90, 128]),
      },
    ],
  };

  const buffer = writePsd(source as never, { generateThumbnail: false });
  assert.ok(buffer.byteLength > 0, 'writePsd 应产出非空字节');

  const psd = readPsd(buffer, {
    skipThumbnail: true,
    useImageData: false,
    skipLayerImageData: false,
    skipCompositeImageData: false,
  }) as unknown as {
    width: number;
    height: number;
    bitsPerChannel: number;
    colorMode: number;
    children: Array<{
      name?: string;
      hidden?: boolean;
      opacity?: number;
      blendMode?: string;
      clipping?: boolean;
      children?: unknown[];
      canvas?: unknown;
    }>;
  };

  assert.equal(psd.width, 64);
  assert.equal(psd.height, 48);
  assert.equal(psd.bitsPerChannel, 8);
  // 真实形状：colorMode 是**数字**（3 = RGB），前端需自行映射成契约 §1.1 的文本
  assert.equal(psd.colorMode, 3);

  assert.equal(psd.children.length, 3);
  assert.deepEqual(
    psd.children.map((layer) => layer.name),
    ['底层-红', '组-测试组', '顶层-绿'],
  );

  // 属性往返一致
  const group = psd.children[1];
  assert.equal(group.children?.length, 1);

  // useImageData: false 时图层应拿到 canvas（此处为 stub）
  assert.ok(psd.children[0].canvas, '图层应带有 canvas 而不是 undefined');
});

test('图层属性：opacity 是 0..1 小数、hidden 是布尔、blendMode 是带空格的字符串', () => {
  const buffer = writePsd(
    {
      width: 16,
      height: 16,
      children: [
        {
          name: '半透明',
          left: 0,
          top: 0,
          right: 16,
          bottom: 16,
          opacity: 0.5,
          hidden: true,
          blendMode: 'color burn' as const,
          imageData: fakeImageData(16, 16, [10, 20, 30, 255]),
        },
      ],
    } as never,
    { generateThumbnail: false },
  );

  const psd = readPsd(buffer, {
    skipThumbnail: true,
    useImageData: false,
    skipLayerImageData: false,
    skipCompositeImageData: false,
  }) as unknown as {
    children: Array<{ opacity?: number; hidden?: boolean; blendMode?: string }>;
  };

  const layer = psd.children[0];
  assert.equal(typeof layer.opacity, 'number');
  // 0..1 而非 0..255
  assert.ok((layer.opacity ?? -1) > 0 && (layer.opacity ?? 2) <= 1, `opacity=${layer.opacity} 应在 0..1`);
  assert.equal(layer.hidden, true);
  assert.equal(layer.blendMode, 'color burn');
});

/* ------------------------------ 规整到前端图层树 ------------------------------ */

test('真实 ag-psd 输出经 normalizeLayerTree 规整后计数与层级正确', () => {
  const buffer = writePsd(
    {
      width: 32,
      height: 32,
      children: [
        { name: 'A', left: 0, top: 0, right: 32, bottom: 32, imageData: fakeImageData(32, 32, [1, 2, 3, 255]) },
        {
          name: '组',
          children: [
            { name: 'B', left: 0, top: 0, right: 8, bottom: 8, imageData: fakeImageData(8, 8, [4, 5, 6, 255]) },
            { name: 'C', left: 0, top: 0, right: 8, bottom: 8, imageData: fakeImageData(8, 8, [7, 8, 9, 255]) },
          ],
        },
      ],
    } as never,
    { generateThumbnail: false },
  );

  const psd = readPsd(buffer, {
    skipThumbnail: true,
    useImageData: false,
    skipLayerImageData: false,
    skipCompositeImageData: false,
  }) as unknown as { children: Array<Record<string, unknown>> };

  const tree = normalizeLayerTree(psd.children);

  assert.equal(tree.length, 2);
  assert.equal(tree[0].name, 'A');
  assert.equal(tree[0].kind, 'layer');
  assert.equal(tree[1].name, '组');
  assert.equal(tree[1].kind, 'group');
  assert.equal(tree[1].children.length, 2);
  assert.deepEqual(
    tree[1].children.map((child) => child.name),
    ['B', 'C'],
  );
  // A + 组 + B + C = 4
  assert.equal(countForest(tree), 4);
  // 图层 id 路径式且稳定
  assert.equal(tree[1].children[1].id, '1/1');
});

/* ------------------------------ 真实素材回归 ------------------------------ */

const FIXTURE_URL = new URL('../../tools/fixtures/sample-ui.psd', import.meta.url);
const MINI_FIXTURE_URL = new URL('../../tools/fixtures/sample-mini.psd', import.meta.url);

test('真实素材 sample-ui.psd：1200×800 / RGB / 8bit / 8 个图层（含中文图层名）', (t) => {
  if (!existsSync(FIXTURE_URL)) {
    t.skip('未找到 tools/fixtures/sample-ui.psd，跳过真实素材回归');
    return;
  }

  const buffer = readFileSync(FIXTURE_URL);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;

  const psd = readPsd(arrayBuffer, {
    skipThumbnail: true,
    useImageData: false,
    skipLayerImageData: false,
    skipCompositeImageData: false,
  }) as unknown as {
    width: number;
    height: number;
    colorMode: number;
    bitsPerChannel: number;
    children: Array<Record<string, unknown>>;
  };

  assert.equal(psd.width, 1200);
  assert.equal(psd.height, 800);
  assert.equal(psd.colorMode, 3); // RGB
  assert.equal(psd.bitsPerChannel, 8);
  assert.equal(psd.children.length, 6, '顶层 6 个节点');

  const tree = normalizeLayerTree(psd.children);
  assert.equal(countForest(tree), 8, '图层总数（含组）为 8');

  const names = tree.map((node) => node.name);
  assert.ok(names.includes('高光 · 滤色'), `实际顶层名称：${names.join('、')}`);
  assert.ok(names.includes('文字组'));

  // 中文图层名经由 luni 附加信息读取，ag-psd 能正确还原
  const highlight = tree.find((node) => node.name === '高光 · 滤色');
  assert.ok(highlight, '应能按中文名找到图层');
  assert.equal(highlight.blendMode, 'screen');
  assert.ok(Math.abs(highlight.opacity - 0.78) < 0.01, `opacity=${highlight.opacity} 应约为 0.78`);

  const group = tree.find((node) => node.name === '文字组');
  assert.ok(group, '应找到「文字组」');
  assert.equal(group.kind, 'group');
  assert.equal(group.children.length, 2);
  assert.deepEqual(
    group.children.map((child) => child.name),
    ['标题文字占位', '副标题文字占位'],
  );

  // 组边界正常（非退化），因此 resolveGroupBounds 会直接采用自身边界
  assert.ok(group.width > 0 && group.height > 0, `组边界不应退化：${group.width}×${group.height}`);
});

test('真实素材 sample-mini.psd：320×200 / 2 个图层', (t) => {
  if (!existsSync(MINI_FIXTURE_URL)) {
    t.skip('未找到 tools/fixtures/sample-mini.psd，跳过');
    return;
  }

  const buffer = readFileSync(MINI_FIXTURE_URL);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;

  const psd = readPsd(arrayBuffer, {
    skipThumbnail: true,
    useImageData: false,
    skipLayerImageData: false,
    skipCompositeImageData: false,
  }) as unknown as { width: number; height: number; children: Array<Record<string, unknown>> };

  assert.equal(psd.width, 320);
  assert.equal(psd.height, 200);

  const tree = normalizeLayerTree(psd.children);
  assert.equal(tree.length, 2);
  assert.deepEqual(
    tree.map((node) => node.name),
    ['圆点', '背景'],
  );
});
