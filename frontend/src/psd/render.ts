/**
 * 图层树合成渲染。
 *
 * 策略：
 * 1. 快速路径：全部图层可见 且 PSD 自带合成图（compositeCanvas）→ 直接使用合成图，
 *    因为它包含 Photoshop 自身的混合结果（含所有调整层/图层样式），最准确也最快。
 * 2. 否则逐层自底向上绘制：ag-psd 的 children 顺序是自上而下（索引 0 是最上层），
 *    因此绘制顺序需要反向遍历。
 * 3. 组图层：先递归渲染到离屏 canvas，再按组自身的 opacity/blendMode 整体合成，
 *    这样组的混合模式才能作用于组内所有图层的合成结果。
 *
 * 已知近似实现：
 * - 裁剪图层（clipping: true）按普通图层直接叠加，未实现 Photoshop 的"仅作用于下一个图层"语义。
 * - 部分混合模式（linear burn / vivid light / divide 等）在 Canvas 中无等价项，
 *   由 blendModes.ts 映射到最接近的模式。
 * - 图层样式（投影/描边等）在 ag-psd 无完整还原时以其 canvas 内容为准。
 */
import { mapBlendMode } from './blendModes';
import type { LayerNode } from './layerTree';
import { isEffectivelyVisible, matchesOriginalVisibility, resolveGroupBounds } from './layerTree';

/** 创建离屏 canvas（优先 OffscreenCanvas，不可用时退回 document.createElement） */
export function createSurface(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  return canvas;
}

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D，无法渲染 PSD');
  return ctx;
}

/** 复位混合状态：每画完一层都必须调用 */
function resetContext(ctx: CanvasRenderingContext2D): void {
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/** 图层是否需要绘制（有 canvas 且尺寸非零） */
function isDrawable(node: LayerNode): boolean {
  return node.canvas !== null && node.width > 0 && node.height > 0;
}

/**
 * 把一组图层自底向上画到 ctx 上。
 * @param ctx 目标上下文
 * @param nodes 图层数组，顺序为 PSD 的原始顺序（索引 0 = 最上层）
 * @param visibility 显隐表，缺失的图层按自身 hidden 标记
 */
export function drawLayerList(
  ctx: CanvasRenderingContext2D,
  nodes: readonly LayerNode[],
  visibility: Readonly<Record<string, boolean>>,
): void {
  // PSD 的 children[0] 是最上层，绘制需要从最下层开始
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (!isEffectivelyVisible(node, visibility)) continue;

    if (node.children.length > 0) {
      drawGroup(ctx, node, visibility);
    } else {
      drawLeaf(ctx, node);
    }
  }
  resetContext(ctx);
}

/** 绘制叶子图层 */
function drawLeaf(ctx: CanvasRenderingContext2D, node: LayerNode): void {
  if (!isDrawable(node) || !node.canvas) return;
  ctx.globalAlpha = node.opacity;
  ctx.globalCompositeOperation = mapBlendMode(node.blendMode);
  // 契约要求的 left/top 偏移；缺失时为 0
  try {
    ctx.drawImage(node.canvas, node.left ?? 0, node.top ?? 0);
  } catch {
    // 个别图层可能持有已失效的位图（例如 tainted canvas），跳过而不中断整次渲染
  }
  resetContext(ctx);
}

/** 绘制组图层：先离屏递归，再整体合成 */
function drawGroup(
  ctx: CanvasRenderingContext2D,
  node: LayerNode,
  visibility: Readonly<Record<string, boolean>>,
): void {
  // 组的边界可能是退化值（见 resolveGroupBounds 注释），需要按子图层并集兜底
  const bounds = resolveGroupBounds(node, {
    left: 0,
    top: 0,
    right: ctx.canvas.width || 1,
    bottom: ctx.canvas.height || 1,
  });

  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);

  const surface = createSurface(width, height);
  const surfaceCtx = get2dContext(surface);
  // 组内绘制在组的局部坐标系中（原点 = 组的实际左/上边界）
  surfaceCtx.save();
  surfaceCtx.translate(-bounds.left, -bounds.top);
  drawLayerList(surfaceCtx, node.children, visibility);
  surfaceCtx.restore();

  ctx.globalAlpha = node.opacity;
  ctx.globalCompositeOperation = mapBlendMode(node.blendMode);
  try {
    ctx.drawImage(surface, bounds.left, bounds.top);
  } catch {
    // 同上：单个组失败不影响其它图层
  }
  resetContext(ctx);
}

export interface RenderOptions {
  /** 画布宽度（默认取 PSD 宽度） */
  width: number;
  /** 画布高度 */
  height: number;
  /** 图层显隐表 */
  visibility: Readonly<Record<string, boolean>>;
  /** PSD 自带的合成图，用于快速路径 */
  compositeCanvas?: CanvasImageSource | null;
  /** 关掉快速路径（例如用户切换过任何图层显隐后必须逐层渲染） */
  forceLayerRender?: boolean;
  /** 透明区域的底色；不传则保持透明（由 CSS 棋盘格透出） */
  background?: string | null;
}

/**
 * 渲染整棵图层树，返回新的 canvas。
 * 每次调用都创建独立 canvas，避免复用导致的脏像素。
 */
export function renderLayers(
  tree: readonly LayerNode[],
  options: RenderOptions,
): HTMLCanvasElement {
  const { width, height, visibility, compositeCanvas, forceLayerRender, background } = options;

  const canvas = createSurface(width, height);
  const ctx = get2dContext(canvas);

  /*
   * 快速路径：用户没改过显隐 + 有 PSD 自带合成图 + 未强制逐层。
   *
   * 这里刻意**不用**「所有图层都可见」作为条件 —— PSD 的合成图本身就是 Photoshop
   * 按可见图层烘焙的（隐藏图层本来就不在其中），所以只要用户没动过开关，
   * 合成图就是「显示所有已显示图层、忽略隐藏图层」最准确的答案。
   * 反之，用「全部可见」做条件会让**任何带隐藏图层的工程**都退化成逐层合成，
   * 一旦遇到调整层/裁剪蒙版这类没有独立像素的图层就会大面积丢内容。
   */
  const untouched = matchesOriginalVisibility(tree, visibility);
  if (!forceLayerRender && untouched && compositeCanvas && !background) {
    try {
      ctx.drawImage(compositeCanvas, 0, 0);
      return canvas;
    } catch {
      // 合成图不可用时静默回退到逐层渲染
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  drawLayerList(ctx, tree, visibility);
  return canvas;
}

/**
 * 判断能否走"直接用 PSD 合成图"的快速路径。
 * 供 PsdViewer 决定是否需要逐层渲染。
 *
 * 判据与 renderLayers 保持一致：只要用户没改动过显隐，合成图就是权威结果
 * （它已按可见图层烘焙，天然忽略隐藏图层）。
 */
export function canUseComposite(
  tree: readonly LayerNode[],
  visibility: Readonly<Record<string, boolean>>,
  compositeCanvas: CanvasImageSource | null | undefined,
  forced: boolean,
): boolean {
  if (forced || !compositeCanvas) return false;
  return matchesOriginalVisibility(tree, visibility);
}

/** 把 canvas 导出为 PNG Blob（上传时自动生成缩略图使用） */
export function canvasToPngBlob(canvas: HTMLCanvasElement, qualityHint = 0.92): Promise<Blob> {
  void qualityHint;
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('导出 PNG 失败：浏览器未能生成图片数据'));
    }, 'image/png');
  });
}

/**
 * 等比例缩放到最大边长限制内，返回新 canvas。
 * 用于避免超大 PSD 生成的缩略图过大导致上传超限。
 */
export function downscaleCanvas(
  source: HTMLCanvasElement,
  maxEdge: number,
): HTMLCanvasElement {
  const longest = Math.max(source.width, source.height);
  if (longest <= maxEdge) return source;

  const scale = maxEdge / longest;
  const target = createSurface(Math.round(source.width * scale), Math.round(source.height * scale));
  const ctx = get2dContext(target);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, target.width, target.height);
  return target;
}
