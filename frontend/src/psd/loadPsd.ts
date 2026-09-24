/**
 * PSD 解析入口（双引擎）。
 *
 * 引擎选择依据实测结论（详见 docs/COLOR-MODES.md 的「色彩模式支持矩阵」）：
 *
 *   · ag-psd 主引擎 —— 支持 Bitmap / Grayscale / RGB / Indexed 的 **8 位**数据，
 *     且能给出图层样式、调整层等完整信息，因此优先使用；
 *   · 内置兜底解码器 —— 接管 ag-psd 处理不了的情况：
 *       - 色彩模式：CMYK / Lab / Multichannel / Duotone（ag-psd 会直接抛错）
 *       - 任意 16 位数据（ag-psd 的 16 位 RLE 路径按 1 字节/样本处理，会错位）
 *
 * 两条引擎产出**同一形状**的 `LoadedPsd`，因此渲染层（render.ts）与界面层
 * （PsdViewer / LayerPanel）无需关心底层是谁解出来的。
 */
import { initializeCanvas, readPsd } from 'ag-psd';

import type { PsdMeta } from '@/types';

import { colorModeInfo } from './colorModes';
import { decodePsd, requiresFallbackEngine, type DecodedLayer, type DecodedSurface } from './decode';
import { countForest, normalizeLayerTree, type LayerNode, type RawLayer } from './layerTree';

/** ag-psd 顶层 Psd 对象中本前端需要的字段 */
interface RawPsd {
  width?: number;
  height?: number;
  colorMode?: number | string;
  bitsPerChannel?: number;
  children?: RawLayer[];
  canvas?: CanvasImageSource | null;
  imageData?: ImageData | null;
}

/** 解析所用的引擎 */
export type PsdEngine = 'ag-psd' | 'fallback';

export interface LoadedPsd {
  width: number;
  height: number;
  /** 已本地化为可读文本，例如 "RGB" / "CMYK" */
  colorMode: string;
  bitsPerChannel: number;
  /** 规整后的图层树 */
  tree: LayerNode[];
  /** 合成图（PSD 自带，或兜底解码器算出的）；可能为 null（此时必须逐层渲染） */
  compositeCanvas: CanvasImageSource | null;
  /** 图层总数（含组图层） */
  layerCount: number;
  /** 解析过程收集到的警告，用于诊断与界面提示 */
  warnings: string[];
  /** 解析耗时（毫秒） */
  parseMs: number;
  /** 实际使用的解码引擎 */
  engine: PsdEngine;
  /** 供 PsdInfoPanel 直接展示的元信息 */
  meta: PsdMeta;
}

/** 解析失败时抛出的错误，message 为中文可直接展示 */
export class PsdLoadError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PsdLoadError';
    this.cause = cause;
  }
}

let canvasInitialized = false;

/** 初始化 ag-psd 的 canvas 工厂，只执行一次 */
export function ensureCanvasInitialized(): void {
  if (canvasInitialized) return;
  initializeCanvas((width: number, height: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(width));
    canvas.height = Math.max(1, Math.floor(height));
    return canvas;
  });
  canvasInitialized = true;
}

/** 契约 §6 色彩模式编号 → 文本 */
const COLOR_MODE_NAMES: Readonly<Record<number, string>> = {
  0: 'Bitmap',
  1: 'Grayscale',
  2: 'Indexed',
  3: 'RGB',
  4: 'CMYK',
  7: 'Multichannel',
  8: 'Duotone',
  9: 'Lab',
};

/** 把 ag-psd 的 colorMode（可能是数字或字符串）统一成契约 §1.1 的文本取值 */
export function resolveColorMode(value: number | string | undefined | null): string {
  if (typeof value === 'number') return COLOR_MODE_NAMES[value] ?? `未知(${value})`;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '未知';
}

/** 文件头探测结果（只读 26 字节，不解析任何段落） */
export interface PsdHeaderPeek {
  colorMode: number;
  bitsPerChannel: number;
  width: number;
  height: number;
}

/** 读文件头判断该交给哪条引擎；数据不足或签名不符时返回 null（由 ag-psd 尝试） */
export function peekPsdHeader(buffer: ArrayBuffer): PsdHeaderPeek | null {
  if (buffer.byteLength < 26) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x38425053) return null; // '8BPS'
  return {
    width: view.getUint32(18, false),
    height: view.getUint32(14, false),
    bitsPerChannel: view.getUint16(22, false),
    colorMode: view.getUint16(24, false),
  };
}

/** 在指定函数执行期间收敛 console.warn/error，返回收集到的消息 */
function withSilencedConsole<T>(fn: () => T): { result: T; messages: string[] } {
  const messages: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;

  const capture =
    (original: typeof console.warn) =>
    (...args: unknown[]) => {
      messages.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
      if (import.meta.env.DEV) original.apply(console, args as never);
    };

  console.warn = capture(originalWarn) as typeof console.warn;
  console.error = capture(originalError) as typeof console.error;
  try {
    return { result: fn(), messages };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

/** readPsd 的选项：拿 canvas、跳过缩略图、图层与合成图都不跳过 */
const READ_OPTIONS = {
  skipThumbnail: true,
  useImageData: false,
  skipLayerImageData: false,
  skipCompositeImageData: false,
} as const;

/**
 * 解析 PSD 字节（自动选择引擎）。
 * @throws {PsdLoadError} 两条引擎都无法解析时抛出，message 为中文
 */
export function loadPsd(buffer: ArrayBuffer): LoadedPsd {
  ensureCanvasInitialized();

  const header = peekPsdHeader(buffer);
  const needsFallback = header ? requiresFallbackEngine(header.colorMode, header.bitsPerChannel) : false;

  if (header && needsFallback) {
    // 已知 ag-psd 处理不了：直接用内置解码器，避免它抛错后还要多跑一次
    return loadViaFallback(buffer, header);
  }

  try {
    return loadViaAgPsd(buffer);
  } catch (agPsdError) {
    // ag-psd 意外失败（例如它不认识的变体）时，只要文件头可读就再兜底试一次
    if (!header) {
      const reason = agPsdError instanceof Error ? agPsdError.message : String(agPsdError);
      throw new PsdLoadError(`PSD 解析失败：${reason || '文件可能已损坏'}`, agPsdError);
    }
    try {
      return loadViaFallback(buffer, header);
    } catch (fallbackError) {
      const reason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new PsdLoadError(`PSD 解析失败：${reason || '文件可能已损坏或使用了不支持的颜色模式'}`, fallbackError);
    }
  }
}

/* ------------------------------ 主引擎：ag-psd ------------------------------ */

function loadViaAgPsd(buffer: ArrayBuffer): LoadedPsd {
  const startedAt = performance.now();
  const silenced = withSilencedConsole(() => readPsd(buffer, READ_OPTIONS) as unknown as RawPsd);
  const psd = silenced.result;

  if (!psd || typeof psd !== 'object') {
    throw new PsdLoadError('PSD 解析失败：文件内容不是有效的 PSD 结构');
  }

  const width = typeof psd.width === 'number' && psd.width > 0 ? psd.width : 0;
  const height = typeof psd.height === 'number' && psd.height > 0 ? psd.height : 0;
  if (!width || !height) {
    throw new PsdLoadError('PSD 解析失败：无法读取画布尺寸，文件可能已损坏');
  }

  const tree = normalizeLayerTree(psd.children);
  const colorMode = resolveColorMode(psd.colorMode);
  const bitsPerChannel =
    typeof psd.bitsPerChannel === 'number' && psd.bitsPerChannel > 0 ? psd.bitsPerChannel : 8;
  const parseMs = Math.round(performance.now() - startedAt);
  const layerCount = countForest(tree);

  return {
    width,
    height,
    colorMode,
    bitsPerChannel,
    tree,
    compositeCanvas: psd.canvas ?? null,
    layerCount,
    warnings: silenced.messages,
    parseMs,
    engine: 'ag-psd',
    meta: { width, height, colorMode, bitsPerChannel, layerCount, parseMs, engine: 'ag-psd' },
  };
}

/* --------------------------- 兜底引擎：内置解码器 --------------------------- */

/** 把解码器的 RGBA 像素面转成 canvas，供渲染层用 drawImage 合成 */
function surfaceToCanvas(surface: DecodedSurface): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, surface.width);
  canvas.height = Math.max(1, surface.height);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // 用 createImageData 而不是 new ImageData(data, w, h)：
    // 前者对底层 buffer 类型没有额外约束，也避免依赖构造器重载。
    const image = ctx.createImageData(surface.width, surface.height);
    image.data.set(surface.data);
    ctx.putImageData(image, 0, 0);
  }
  return canvas;
}

/**
 * 把兜底解码器的图层转成渲染层认识的 RawLayer。
 *
 * 关键是产出与 ag-psd 相同的形状（`canvas` + 边界 + 混合模式 + children），
 * 这样 layerTree.ts / render.ts / PsdViewer 全都不需要改动。
 */
function toRawLayer(layer: DecodedLayer): RawLayer {
  return {
    name: layer.name,
    left: layer.left,
    top: layer.top,
    right: layer.right,
    bottom: layer.bottom,
    opacity: layer.opacity,
    hidden: layer.hidden,
    blendMode: layer.blendMode,
    clipping: layer.clipping,
    children: layer.children.length > 0 ? layer.children.map(toRawLayer) : undefined,
    // 组图层与「无像素通道」的图层（如调整层）没有像素面，保持 null，渲染时跳过
    canvas: layer.surface ? surfaceToCanvas(layer.surface) : null,
  };
}

function loadViaFallback(buffer: ArrayBuffer, _header: PsdHeaderPeek): LoadedPsd {
  let decoded;
  try {
    decoded = decodePsd(buffer);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PsdLoadError(reason || '内置解码器无法解析该文件', error);
  }

  const tree = normalizeLayerTree(decoded.layers.map(toRawLayer));
  const info = colorModeInfo(decoded.colorMode);
  const layerCount = decoded.layerCount > 0 ? decoded.layerCount : countForest(tree);

  return {
    width: decoded.width,
    height: decoded.height,
    colorMode: decoded.colorModeName,
    bitsPerChannel: decoded.bitsPerChannel,
    tree,
    compositeCanvas: surfaceToCanvas(decoded.composite),
    layerCount,
    warnings: decoded.warnings,
    parseMs: decoded.decodeMs,
    engine: 'fallback',
    meta: {
      width: decoded.width,
      height: decoded.height,
      colorMode: decoded.colorModeName,
      bitsPerChannel: decoded.bitsPerChannel,
      layerCount,
      parseMs: decoded.decodeMs,
      channels: decoded.channels,
      engine: 'fallback',
      approximate: info.fidelity === 'approximate',
      approxReason: info.note,
    },
  };
}

/** 判断 ArrayBuffer 是否以 8BPS 开头（契约 §3.6 文件头规则，前端提前给出友好提示） */
export function hasPsdSignature(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const head = new Uint8Array(buffer, 0, 4);
  return head[0] === 0x38 && head[1] === 0x42 && head[2] === 0x50 && head[3] === 0x53; // "8BPS"
}
