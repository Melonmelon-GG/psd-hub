/**
 * ⚠️ v2.0 起本路线不再上传 PSD，此模块**保留仅供参考，当前无调用方**。
 *
 * 后端已改为「上传 PNG + 网盘分享链接」（docs/API.md v2.0）：
 * 上传只校验 PNG 魔数并从 IHDR 读宽高（见 routes/projects.ts + lib/png.ts 的 PNG_MAGIC）；
 * PSD/PSB 的文件头解析、色彩模式编码、通道数推导（hasAlpha）等逻辑**均不再被任何生产路径调用**。
 * 保留原因：前端仍留有浏览器端 PSD 解析代码（frontend/src/psd/**），
 * 若将来恢复在线预览，这些解析函数与 docs/COLOR-MODES.md 的结论可直接接回。
 * 请勿在新增代码中引用本模块；也不要删除（test/psdHeader.test.ts 仍在守护它的行为）。
 *
 * ---- 以下为原始说明 ----
 *
 * PSD/PSB 文件头解析（契约 §6）与 PNG 魔数/尺寸识别。
 *
 * PSD 头 26 字节，大端：
 *   0..4   签名 "8BPS"
 *   4..6   版本 1=PSD 2=PSB
 *   6..12  保留（必须全 0）
 *   12..14 通道数 1..56
 *   14..18 高度
 *   18..22 宽度
 *   22..24 位深 1/8/16/32
 *   24..26 色彩模式
 *
 * 后端只读头部，不解析图层段（layerCount 一律 null）。
 */

/**
 * 色彩模式：数值编码 → 名称（契约 v1.1 §6）。
 * 编码 7 = Multichannel（「多通道」）；v1.1 起不再写作 Multicolor。
 *
 * v2.0 起这些类型已不属于公开 API（`docs/API.md` v2.0 不再有 `Project.psd`），
 * 因此只在本遗留模块内定义，供将来接回在线预览时参考。
 */
export type ColorMode =
  | 'RGB'
  | 'Grayscale'
  | 'CMYK'
  | 'Lab'
  | 'Bitmap'
  | 'Indexed'
  | 'Multichannel'
  | 'Duotone';

/** PSD/PSB 版本标签：1 = PSD，2 = PSB（大型文档） */
export type PsdVersion = 'PSD' | 'PSB';

/** 每通道位深 */
export type BitsPerChannel = 1 | 8 | 16 | 32;

export const PSD_HEADER_SIZE = 26;
export const PSD_SIGNATURE = '8BPS';
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 色彩模式编码 → 名称（未收录的编码解析为 null）。
 * 注意：编码 7 的官方名称是 **Multichannel**（Photoshop 里叫「多通道」）；
 * 早期版本契约曾写作 "Multicolor"，自契约 v1.1 起统一为 Multichannel。
 */
export const COLOR_MODE_BY_CODE: Readonly<Record<number, ColorMode>> = {
  0: 'Bitmap',
  1: 'Grayscale',
  2: 'Indexed',
  3: 'RGB',
  4: 'CMYK',
  7: 'Multichannel',
  8: 'Duotone',
  9: 'Lab',
};

/**
 * 各色彩模式的**基色通道数**（不含可选的那 1 个 alpha 通道）。
 *
 * 为什么编码 7（Multichannel）刻意不在这里出现（→ baseChannelCount 返回 null）：
 * Multichannel 文档的通道数完全由用户决定，除基色通道外还可以有任意多个**专色通道**
 * （spot channel）与 alpha 通道；文件头里只有一个总通道数，没有任何字段能区分
 * "多出来的通道是专色还是 alpha"。因此这里给不出可信的基色通道数，
 * 也就无法判断 hasAlpha，只能返回 null（前端据此提示"近似预览"而不是谎报有无透明）。
 */
export const BASE_CHANNEL_COUNT_BY_MODE: Readonly<Record<number, number>> = {
  0: 1, // Bitmap：1 位黑白，单通道
  1: 1, // Grayscale
  2: 1, // Indexed：索引 + 256 色调色板，仍是单通道数据
  3: 3, // RGB
  4: 4, // CMYK
  8: 1, // Duotone：单通道 + 双色调曲线
  9: 3, // Lab
};

/** 文件头声明的合法通道数范围（规范 §PSD 头） */
export const CHANNELS_MIN = 1;
export const CHANNELS_MAX = 56;

/** 合法位深 */
export const SUPPORTED_BITS: readonly number[] = [1, 8, 16, 32];

export interface PsdHeader {
  /** 1 = PSD，2 = PSB */
  version: 1 | 2;
  /**
   * 文件头声明的通道数（原始 uint16，原样透传不做钳制）。
   * 合法范围 1..56（见 CHANNELS_MIN/CHANNELS_MAX）；越界值只能说明文件头损坏，
   * 此时 deriveHasAlpha 会返回 null。
   */
  channels: number;
  width: number;
  height: number;
  bitsPerChannel: BitsPerChannel | null;
  /** 色彩模式名称（未收录编码为 null） */
  colorMode: ColorMode | null;
  /** 色彩模式的原始数值编码（偏移 24），即使未收录也保留，供 deriveHasAlpha 使用 */
  colorModeCode: number;
}

/** 版本编码 → 契约 §1.1 的标签（1 = PSD，2 = PSB 大型文档；其它编码为 null） */
export function versionLabel(version: number | null | undefined): 'PSD' | 'PSB' | null {
  if (version === 1) return 'PSD';
  if (version === 2) return 'PSB';
  return null;
}

/** 通道数是否为合法值（1..56 的整数） */
export function isValidChannelCount(channels: number | null | undefined): channels is number {
  return (
    typeof channels === 'number' &&
    Number.isInteger(channels) &&
    channels >= CHANNELS_MIN &&
    channels <= CHANNELS_MAX
  );
}

/**
 * 色彩模式编码 → 基色通道数（不含可选 alpha）。
 * 未收录编码、以及基色通道数不固定的 Multichannel(7) → null。
 */
export function baseChannelCount(colorMode: number | null | undefined): number | null {
  if (typeof colorMode !== 'number') return null;
  return BASE_CHANNEL_COUNT_BY_MODE[colorMode] ?? null;
}

/**
 * 由「文件头通道数 + 色彩模式」推导合成图是否带 alpha 通道（契约 §6）。
 *
 * 规则：通道数 = 基色通道数 + 可选 1 个 alpha 通道
 *   channels > 基色通道数 → true；channels === 基色通道数 → false。
 * 返回 null 的三种情况：
 *   1. channels 缺失或越界（0 / 57…）——文件头不可信，无法判定；
 *   2. colorMode 缺失或未收录——查不到基色通道数；
 *   3. colorMode = 7（Multichannel）——**多出来的通道既可能是专色也可能是 alpha**，
 *      文件头没有任何字段可以区分这两者，任何推断都是猜的，所以一律 null。
 */
export function deriveHasAlpha(channels: number | null, colorMode: number | null): boolean | null {
  if (!isValidChannelCount(channels)) return null;
  const base = baseChannelCount(colorMode);
  if (base === null) return null;
  return channels > base;
}

/** 前 4 字节是否为 8BPS */
export function isPsdBuffer(buffer: Uint8Array | null | undefined): boolean {
  if (!buffer || buffer.length < 4) return false;
  return Buffer.from(buffer).toString('latin1', 0, 4) === PSD_SIGNATURE;
}

/** 前 8 字节是否为 PNG 魔数 */
export function isPngBuffer(buffer: Uint8Array | null | undefined): boolean {
  if (!buffer || buffer.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (buffer[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/**
 * 解析 26 字节 PSD 头。
 * 签名错误、保留字节非 0、版本非 1/2、长度不足 → null。
 * 位深/色彩模式非法时仅对应字段为 null，不影响整体解析。
 * 通道数原样透传（不做 1..56 钳制），越界判定交给 isValidChannelCount / deriveHasAlpha。
 */
export function parsePsdHeader(buffer: Uint8Array | null | undefined): PsdHeader | null {
  if (!buffer || buffer.length < PSD_HEADER_SIZE) return null;
  if (!isPsdBuffer(buffer)) return null;

  for (let i = 6; i < 12; i += 1) {
    if (buffer[i] !== 0) return null;
  }

  const view = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const version = view.readUInt16BE(4);
  if (version !== 1 && version !== 2) return null;

  const channels = view.readUInt16BE(12);
  const height = view.readUInt32BE(14);
  const width = view.readUInt32BE(18);
  const bits = view.readUInt16BE(22);
  const mode = view.readUInt16BE(24);

  return {
    version,
    channels,
    width,
    height,
    bitsPerChannel: SUPPORTED_BITS.includes(bits) ? (bits as BitsPerChannel) : null,
    colorMode: COLOR_MODE_BY_CODE[mode] ?? null,
    colorModeCode: mode,
  };
}

/** 从 PNG 的 IHDR 读取宽高（需要至少 24 字节） */
export function parsePngSize(buffer: Uint8Array | null | undefined): { width: number; height: number } | null {
  if (!buffer || buffer.length < 24) return null;
  if (!isPngBuffer(buffer)) return null;
  const view = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}
