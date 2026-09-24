/**
 * 把 ag-psd 的图层 children 递归规整成前端使用的 LayerNode 树。
 *
 * 本模块刻意只依赖**鸭子类型**的输入（见 RawLayer），
 * 以便用假对象做单元测试，也避免与 ag-psd 的类型定义强耦合。
 */

/** 与 ag-psd Layer 中本前端需要的字段对齐的最小结构 */
export interface RawLayer {
  name?: string;
  /** 图层在画布中的边界（像素，可为负） */
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  /** 0..1 */
  opacity?: number;
  hidden?: boolean;
  blendMode?: string;
  clipping?: boolean;
  /** 组图层的子图层 */
  children?: RawLayer[];
  /** ag-psd 在非 imageData 模式下提供的已渲染图层位图 */
  canvas?: CanvasImageSource | null;
  /** 部分图层（如纯调整层）没有像素，只有文字信息 */
  text?: { text?: string };
}

/** 规整后的图层节点 */
export interface LayerNode {
  /** 稳定 id：路径式（0/2/1），用于 React key 与显隐状态存储 */
  id: string;
  /** 展示用名称；ag-psd 未提供时兜底 */
  name: string;
  /** 原始名称（用于判断是否为自动兜底名） */
  kind: 'group' | 'layer';
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  /** 0..1 */
  opacity: number;
  hidden: boolean;
  blendMode: string;
  clipping: boolean;
  children: LayerNode[];
  canvas: CanvasImageSource | null;
  /** 该子树（含自身）的图层总数，组图层用于展示 "n 个图层" */
  descendantCount: number;
  /** 文本图层的内容（若可读） */
  text?: string;
}

/** 默认值：ag-psd 缺省时按 PSD 语义填充 */
const DEFAULT_OPACITY = 1;
const DEFAULT_BLEND_MODE = 'normal';
const DEFAULT_NAME = '未命名图层';

function clampOpacity(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULT_OPACITY;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function toInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
}

/**
 * 递归规整图层数组。
 * @param layers 原始图层数组（ag-psd 的 psd.children）
 * @param parentPath 父级路径前缀，用于生成稳定 id
 */
export function normalizeLayerTree(
  layers: readonly RawLayer[] | undefined | null,
  parentPath = '',
): LayerNode[] {
  if (!Array.isArray(layers) || layers.length === 0) return [];
  return layers.map((raw, index) => normalizeLayer(raw, `${parentPath}${index}`));
}

/** 规整单个图层 */
export function normalizeLayer(raw: RawLayer, path: string): LayerNode {
  const children = normalizeLayerTree(raw.children, `${path}/`);

  const left = toInt(raw.left, 0);
  const top = toInt(raw.top, 0);
  const right = toInt(raw.right, left);
  const bottom = toInt(raw.bottom, top);

  const name =
    typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : DEFAULT_NAME;

  const node: LayerNode = {
    id: path,
    name,
    kind: children.length > 0 ? 'group' : 'layer',
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    opacity: clampOpacity(raw.opacity),
    hidden: raw.hidden === true,
    blendMode:
      typeof raw.blendMode === 'string' && raw.blendMode.trim()
        ? raw.blendMode.trim()
        : DEFAULT_BLEND_MODE,
    clipping: raw.clipping === true,
    children,
    canvas: raw.canvas ?? null,
    descendantCount: 0,
  };

  const text = raw.text?.text;
  if (typeof text === 'string' && text.trim()) node.text = text;

  node.descendantCount = countLayers(node);
  return node;
}

/** 统计一棵子树中的图层总数（含自身） */
export function countLayers(node: LayerNode): number {
  let total = 1;
  for (const child of node.children) total += child.descendantCount || countLayers(child);
  return total;
}

/** 统计整片森林的图层总数 */
export function countForest(nodes: readonly LayerNode[]): number {
  let total = 0;
  for (const node of nodes) total += node.descendantCount || countLayers(node);
  return total;
}

/** 深度优先收集所有节点（含组） */
export function flattenLayers(nodes: readonly LayerNode[]): LayerNode[] {
  const out: LayerNode[] = [];
  const walk = (list: readonly LayerNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.children.length) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** 收集所有图层节点（不含组），用于图层计数展示 */
export function collectPixelLayers(nodes: readonly LayerNode[]): LayerNode[] {
  return flattenLayers(nodes).filter((node) => node.kind === 'layer');
}

/** 收集全部图层的 id（用于"全部图层开/关"） */
export function collectLayerIds(nodes: readonly LayerNode[]): string[] {
  return flattenLayers(nodes).map((node) => node.id);
}

/**
 * 初始显隐表：默认尊重 PSD 自带的 hidden 标记。
 * 组图层被隐藏时，其子图层仍保持自身状态（渲染时父级隐藏即整组不画）。
 */
export function createVisibilityMap(nodes: readonly LayerNode[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const node of flattenLayers(nodes)) {
    map[node.id] = !node.hidden;
  }
  return map;
}

/** 判断某节点在给定显隐表下是否可见（自身与所有祖先都可见） */
export function isEffectivelyVisible(
  node: LayerNode,
  visibility: Readonly<Record<string, boolean>>,
): boolean {
  if (!(visibility[node.id] ?? !node.hidden)) return false;
  const segments = node.id.split('/');
  // 逐级回溯祖先（组）的显隐状态
  for (let i = 1; i < segments.length; i += 1) {
    const ancestorId = segments.slice(0, i).join('/');
    if (!(visibility[ancestorId] ?? true)) return false;
  }
  return true;
}

/**
 * 当前显隐表是否与 PSD **自带的** hidden 标记完全一致（即用户还没有动过任何图层开关）。
 *
 * 为什么需要这个判断：PSD 文件里保存的合成图（composite，即 `psd.canvas`）
 * **本身就是 Photoshop 按「可见图层」烘焙出来的结果** —— 也就是说
 * 「显示所有已显示的图层、忽略被隐藏的图层」这条语义，合成图已经天然满足了。
 *
 * 因此只要用户没改过显隐，就应该直接用合成图：
 *   · 它包含图层样式、调整层、裁剪蒙版等我们逐层合成无法完全复现的效果；
 *   · 它不会因为个别图层没有像素数据（调整层/纯文字层）而丢内容。
 *
 * 反过来说，**不能**用「是否所有图层都可见」来决定要不要走合成图 ——
 * 只要 PSD 里存在任意一个隐藏图层，那个条件就永远为假，
 * 于是所有带隐藏图层的工程都会被降级为逐层合成，画面可能大量缺失。
 * 这正是本函数要修正的问题。
 */
export function matchesOriginalVisibility(
  nodes: readonly LayerNode[],
  visibility: Readonly<Record<string, boolean>>,
): boolean {
  for (const node of flattenLayers(nodes)) {
    // 显隐表里没有该 id（未被用户触碰过）时，其有效值就等于 PSD 原始状态
    const current = visibility[node.id];
    if (current === undefined) continue;
    if (current !== !node.hidden) return false;
  }
  return true;
}

/** 矩形边界 */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 解析组图层用于离屏渲染的边界。
 *
 * 背景（实测结论）：PSD 的组容器记录**不保证**存储有效的边界矩形——
 * 用 ag-psd 的 writePsd 造出来的组读回来就可能是 (8,8,8,8) 这种 0×0 退化值，
 * 若直接按它建离屏 canvas 会得到 1×1 并丢掉整组内容。
 * 因此：自身边界有效时用自身，否则递归取所有可见子图层的并集。
 *
 * @param fallback 连子图层也没有有效边界时使用的兜底（通常是画布尺寸）
 */
export function resolveGroupBounds(node: LayerNode, fallback: Bounds): Bounds {
  if (node.width > 0 && node.height > 0) {
    return { left: node.left, top: node.top, right: node.right, bottom: node.bottom };
  }

  const union = unionChildBounds(node.children);
  if (union) return union;
  return fallback;
}

/** 计算一组图层（递归）的边界并集；无有效子图层时返回 null */
export function unionChildBounds(nodes: readonly LayerNode[]): Bounds | null {
  let acc: Bounds | null = null;

  const merge = (bounds: Bounds) => {
    if (!acc) {
      acc = { ...bounds };
      return;
    }
    acc = {
      left: Math.min(acc.left, bounds.left),
      top: Math.min(acc.top, bounds.top),
      right: Math.max(acc.right, bounds.right),
      bottom: Math.max(acc.bottom, bounds.bottom),
    };
  };

  for (const node of nodes) {
    if (node.children.length > 0) {
      const nested = unionChildBounds(node.children);
      if (nested) merge(nested);
    } else if (node.width > 0 && node.height > 0) {
      merge({ left: node.left, top: node.top, right: node.right, bottom: node.bottom });
    }
  }

  return acc;
}
