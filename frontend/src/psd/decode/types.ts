/**
 * 自研 PSD 兜底解码引擎的公共类型。
 *
 * 该模块**纯逻辑、零依赖、不触碰 DOM**：既可在浏览器中直接跑，也可在 Node 下测试，
 * 便于用 `tools/fixtures/*.rgba` 做逐像素回归。
 */

/** RGBA 像素面：行优先，`data.length === width * height * 4` */
export interface DecodedSurface {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** 解码出的图层节点（组与叶子共用同一结构） */
export interface DecodedLayer {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** 0..1（文件里是 0..255） */
  opacity: number;
  hidden: boolean;
  /** PSD 名称形式，带空格，例如 'normal' / 'screen' / 'multiply' / 'pass through' */
  blendMode: string;
  clipping: boolean;
  /** 记录里出现的通道 id（含被跳过的蒙版通道），便于诊断 */
  channelIds: number[];
  /** 组图层的子层；叶子为空数组。索引 0 = 最上层（显示顺序） */
  children: DecodedLayer[];
  /** 叶子图层的 RGBA；组图层与「无通道数据」的图层为 null */
  surface: DecodedSurface | null;
}

/** 合成图像数据段的压缩方式 */
export type CompressionName = 'raw' | 'rle';

export interface DecodeResult {
  width: number;
  height: number;
  version: 1 | 2;
  colorMode: number;
  /** 'RGB' / 'CMYK' / 'Lab' / 'Multichannel' / 'Duotone' / 'Grayscale' / 'Indexed' / 'Bitmap' */
  colorModeName: string;
  bitsPerChannel: number;
  /** 文件头声明的通道数（合成图像数据段里的平面数） */
  channels: number;
  compression: CompressionName;
  composite: DecodedSurface;
  /** 图层树（顶层数组，索引 0 = 最上层） */
  layers: DecodedLayer[];
  /** 图层总数（含组） */
  layerCount: number;
  /** Indexed 模式：交错 RGB 调色板，长度 768；其它模式为 null */
  palette: Uint8Array | null;
  /** 中文警告（近似实现、结构异常等） */
  warnings: string[];
  /** 解码耗时（毫秒） */
  decodeMs: number;
}

/**
 * 解码失败错误。`code` 为稳定的机器可读标识，`message` 为可直接展示的中文说明。
 *
 * 常见 code：
 * - `INVALID_INPUT`：入参不是字节
 * - `INVALID_SIGNATURE`：文件签名不是 '8BPS'
 * - `UNSUPPORTED_VERSION`：版本不是 1（PSD）/ 2（PSB）
 * - `INVALID_HEADER`：保留字段非 0、通道数越界等文件头错误
 * - `INVALID_DIMENSION`：宽高非法或超限
 * - `SIZE_LIMIT`：像素面内存超限
 * - `UNSUPPORTED_BITS`：位深不是 1/8/16/32
 * - `UNSUPPORTED_COLOR_MODE`：色彩模式不在支持集合内
 * - `UNSUPPORTED_COMPRESSION`：压缩方式不是 0（raw）/ 1（RLE）
 * - `INVALID_STRUCTURE`：段长度/结构与规范不自洽
 * - `TRUNCATED`：任何越界读取（数据不足）
 * - `RLE_OVERFLOW`：PackBits 解出的字节数超过该行应有长度
 */
export class PsdDecodeError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'PsdDecodeError';
    this.code = code;
  }
}
