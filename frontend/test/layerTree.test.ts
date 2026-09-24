/**
 * layerTree 纯函数测试：用鸭子类型的假图层验证树规整、计数与默认值填充，
 * 并覆盖「组图层边界退化」这一实测发现的兜底逻辑。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectLayerIds,
  collectPixelLayers,
  countForest,
  countLayers,
  createVisibilityMap,
  flattenLayers,
  isEffectivelyVisible,
  normalizeLayer,
  normalizeLayerTree,
  resolveGroupBounds,
  unionChildBounds,
  type LayerNode,
} from '../src/psd/layerTree.ts';
test('normalizeLayerTree 递归规整 children 并保留数组顺序（索引 0 = 最上层）', () => {
  const tree = normalizeLayerTree([
    { name: '顶层' },
    { name: '组', children: [{ name: '组内 A' }, { name: '组内 B' }] },
    { name: '底层' },
  ]);

  assert.equal(tree.length, 3);
  assert.deepEqual(
    tree.map((node) => node.name),
    ['顶层', '组', '底层'],
  );
  assert.equal(tree[1].children.length, 2);
  assert.deepEqual(
    tree[1].children.map((child) => child.name),
    ['组内 A', '组内 B'],
  );
});

test('id 采用路径式且稳定，可用于 React key 与显隐表', () => {
  const tree = normalizeLayerTree([
    { name: 'A' },
    { name: 'B', children: [{ name: 'B1' }, { name: 'B2', children: [{ name: 'B2a' }] }] },
  ]);

  assert.equal(tree[0].id, '0');
  assert.equal(tree[1].id, '1');
  assert.equal(tree[1].children[0].id, '1/0');
  assert.equal(tree[1].children[1].id, '1/1');
  assert.equal(tree[1].children[1].children[0].id, '1/1/0');
});

test('kind 依据 children 判定：有子层为 group，否则为 layer', () => {
  const tree = normalizeLayerTree([
    { name: '组', children: [{ name: '子' }] },
    { name: '普通图层' },
    { name: '空 children 视为普通图层', children: [] },
  ]);

  assert.equal(tree[0].kind, 'group');
  assert.equal(tree[1].kind, 'layer');
  assert.equal(tree[2].kind, 'layer');
});

test('默认值填充：name / opacity / hidden / blendMode / 边界', () => {
  const node = normalizeLayer({}, '0');

  assert.equal(node.name, '未命名图层');
  assert.equal(node.opacity, 1);
  assert.equal(node.hidden, false);
  assert.equal(node.blendMode, 'normal');
  assert.equal(node.clipping, false);
  assert.equal(node.left, 0);
  assert.equal(node.top, 0);
  assert.equal(node.right, 0);
  assert.equal(node.bottom, 0);
  assert.equal(node.width, 0);
  assert.equal(node.height, 0);
  assert.equal(node.canvas, null);
});

test('空白名称回落到默认名，opacity 被裁剪到 0..1', () => {
  const node = normalizeLayer({ name: '   ', opacity: 5 }, '0');
  assert.equal(node.name, '未命名图层');

  assert.equal(normalizeLayer({ opacity: -1 }, '0').opacity, 0);
  assert.equal(normalizeLayer({ opacity: 2 }, '0').opacity, 1);
  assert.equal(normalizeLayer({ opacity: Number.NaN }, '0').opacity, 1);
  assert.equal(normalizeLayer({ opacity: 0.5 }, '0').opacity, 0.5);
});

test('宽度高度由 right-left / bottom-top 计算，负数与小数被规整为整数', () => {
  const node = normalizeLayer(
    { left: -20, top: -10.4, right: 30.6, bottom: 40 },
    '0',
  );
  // left/top 允许为负（图层可超出画布）
  assert.equal(node.left, -20);
  assert.equal(node.top, -10);
  assert.equal(node.right, 31);
  assert.equal(node.bottom, 40);
  assert.equal(node.width, 51);
  assert.equal(node.height, 50);
});

test('countLayers / countForest 统计含组在内的图层总数', () => {
  const tree = normalizeLayerTree([
    { name: 'A' },
    { name: '组', children: [{ name: 'B' }, { name: 'C', children: [{ name: 'D' }] }] },
  ]);

  // 顶层 A + 组 + B + C + D = 5
  assert.equal(countForest(tree), 5);
  assert.equal(countLayers(tree[1]), 4);
  assert.equal(tree[0].descendantCount, 1);
});

test('flattenLayers / collectPixelLayers / collectLayerIds', () => {
  const tree = normalizeLayerTree([
    { name: 'A' },
    { name: '组', children: [{ name: 'B' }] },
  ]);

  assert.equal(flattenLayers(tree).length, 3);
  // 不含组，仅叶子
  assert.deepEqual(
    collectPixelLayers(tree).map((node) => node.name),
    ['A', 'B'],
  );
  assert.deepEqual(collectLayerIds(tree), ['0', '1', '1/0']);
});

test('createVisibilityMap 尊重 PSD 自带的 hidden 标记', () => {
  const tree = normalizeLayerTree([
    { name: '可见' },
    { name: '隐藏', hidden: true },
    { name: '组', hidden: true, children: [{ name: '组内可见' }] },
  ]);

  const map = createVisibilityMap(tree);
  assert.equal(map['0'], true);
  assert.equal(map['1'], false);
  // 组被隐藏时子层仍保留自身状态，由 isEffectivelyVisible 处理继承
  assert.equal(map['2'], false);
  assert.equal(map['2/0'], true);
});

test('isEffectivelyVisible 综合自身与祖先状态', () => {
  const tree = normalizeLayerTree([
    { name: '组', children: [{ name: '子 A' }, { name: '子 B', hidden: true }] },
  ]);
  const group = tree[0];
  const childA = group.children[0];
  const childB = group.children[1];

  const visibility: Record<string, boolean> = { '0': true, '0/0': true, '0/1': true };

  assert.equal(isEffectivelyVisible(group, visibility), true);
  assert.equal(isEffectivelyVisible(childA, visibility), true);
  assert.equal(isEffectivelyVisible(childB, visibility), true);

  // 关闭组 → 整组都不可见
  visibility['0'] = false;
  assert.equal(isEffectivelyVisible(group, visibility), false);
  assert.equal(isEffectivelyVisible(childA, visibility), false);

  // 打开组但关闭子 A
  visibility['0'] = true;
  visibility['0/0'] = false;
  assert.equal(isEffectivelyVisible(childA, visibility), false);
  assert.equal(isEffectivelyVisible(childB, visibility), true);
});

test('resolveGroupBounds：组自身边界有效时优先使用自身', () => {
  const tree = normalizeLayerTree([
    {
      name: '组',
      left: 100,
      top: 50,
      right: 300,
      bottom: 250,
      children: [{ name: '子', left: 0, top: 0, right: 10, bottom: 10 }],
    },
  ]);

  const bounds = resolveGroupBounds(tree[0], { left: 0, top: 0, right: 1000, bottom: 1000 });
  assert.deepEqual(bounds, { left: 100, top: 50, right: 300, bottom: 250 });
});

test('resolveGroupBounds：组边界退化为 0×0 时取子图层并集（回归：避免 1×1 画布丢内容）', () => {
  // 实测发现：ag-psd 的 writePsd 造出的组读回来可能是 (8,8,8,8) 这种退化边界
  const tree = normalizeLayerTree([
    {
      name: '组',
      left: 8,
      top: 8,
      right: 8,
      bottom: 8,
      children: [
        { name: '子 A', left: 10, top: 20, right: 60, bottom: 90 },
        { name: '子 B', left: 40, top: 5, right: 120, bottom: 45 },
      ],
    },
  ]);

  const group = tree[0];
  assert.equal(group.width, 0, '前置条件：组的边界确实退化为 0 宽');
  assert.equal(group.height, 0);

  const bounds = resolveGroupBounds(group, { left: 0, top: 0, right: 1000, bottom: 1000 });

  // 并集：left=min(10,40)=10, top=min(20,5)=5, right=max(60,120)=120, bottom=max(90,45)=90
  assert.deepEqual(bounds, { left: 10, top: 5, right: 120, bottom: 90 });

  // 关键断言：据此建出的离屏画布尺寸不是 1×1
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  assert.equal(width, 110);
  assert.equal(height, 85);
  assert.ok(width > 1 && height > 1, '不得退化为 1×1 画布');
});

test('resolveGroupBounds：组与子图层都无效时回落到画布尺寸', () => {
  const tree = normalizeLayerTree([{ name: '空组', children: [{ name: '无边界子层' }] }]);
  const fallback = { left: 0, top: 0, right: 1200, bottom: 800 };

  assert.deepEqual(resolveGroupBounds(tree[0], fallback), fallback);
});

test('resolveGroupBounds：嵌套组递归取并集', () => {
  const tree = normalizeLayerTree([
    {
      name: '外层组',
      children: [
        { name: '内层组', children: [{ name: '深处图层', left: -30, top: 200, right: 70, bottom: 260 }] },
      ],
    },
  ]);

  const bounds = resolveGroupBounds(tree[0], { left: 0, top: 0, right: 10, bottom: 10 });
  assert.deepEqual(bounds, { left: -30, top: 200, right: 70, bottom: 260 });
});

test('unionChildBounds：无有效子图层时返回 null', () => {
  const tree = normalizeLayerTree([{ name: '空组', children: [{ name: '无边界子层' }] }]);
  assert.equal(unionChildBounds(tree[0].children), null);
  assert.equal(unionChildBounds([]), null);
});

test('text 字段仅在非空时保留', () => {
  const withText = normalizeLayer({ text: { text: '标题文字' } }, '0');
  assert.equal(withText.text, '标题文字');

  const blankText = normalizeLayer({ text: { text: '   ' } }, '0');
  assert.equal(blankText.text, undefined);
});

test('LayerNode 类型可用于下游消费（编译期校验 + 运行期取值）', () => {
  const node: LayerNode = normalizeLayer({ name: 'X', opacity: 0.25 }, '0');
  assert.equal(node.name, 'X');
  assert.equal(node.opacity, 0.25);
});
