/**
 * 图层与蒙版信息段解析：图层记录 → 通道图像数据 → 图层树。
 *
 * 两个容易写错的点：
 * 1. **记录顺序**是「组的结束分隔符 → 组的子层 → 组的容器记录」，
 *    因此必须**从最后一条记录往前遍历**并用栈维护当前容器，
 *    得到的 children 顺序才是显示顺序（索引 0 = 最上层）。
 * 2. 通道图像数据在**全部记录之后**，按「记录顺序 × 记录内通道顺序」排列；
 *    且每个通道的数据块自成一体（自带 2 字节压缩标志）。
 */
import { renderRgba } from './color.ts';
import type { ByteReader } from './reader.ts';
import { readChannelPlane } from './samples.ts';
import { PsdDecodeError } from './types.ts';
import type { DecodedLayer, DecodedSurface } from './types.ts';

/** PSD 混合模式 key（定长 4 字节，可能含尾随空格）→ 带空格的 PSD 名称 */
export const PSD_BLEND_MODES: Readonly<Record<string, string>> = {
  pass: 'pass through',
  norm: 'normal',
  diss: 'dissolve',
  dark: 'darken',
  mul: 'multiply',
  idiv: 'color burn',
  lbrn: 'linear burn',
  dkCl: 'darker color',
  lite: 'lighten',
  scrn: 'screen',
  div: 'color dodge',
  lddg: 'linear dodge',
  lgCl: 'lighter color',
  over: 'overlay',
  sLit: 'soft light',
  hLit: 'hard light',
  vLit: 'vivid light',
  lLit: 'linear light',
  pLit: 'pin light',
  hMix: 'hard mix',
  diff: 'difference',
  smud: 'exclusion',
  fsub: 'subtract',
  fdiv: 'divide',
  hue: 'hue',
  sat: 'saturation',
  colr: 'color',
  lum: 'luminosity',
};

/** PSB 中长度字段为 8 字节的附加信息块 key */
const LONG_LENGTH_KEYS: ReadonlySet<string> = new Set([
  'LMsk',
  'Lr16',
  'Lr32',
  'Layr',
  'Mt16',
  'Mt32',
  'Mtrn',
  'Alph',
  'FMsk',
  'lnk2',
  'FEid',
  'FXid',
  'PxSD',
  'cinf',
]);

/** 混合模式 key → PSD 名称；未知 key 原样返回（去尾空格）并记录警告 */
export function resolveBlendMode(key: string, warnings: string[]): string {
  const trimmed = key.replace(/\0/g, '').trim();
  const mapped = PSD_BLEND_MODES[trimmed];
  if (mapped) return mapped;
  warnings.push(`未知混合模式 key「${key}」，已原样保留`);
  return trimmed;
}

/** 各色彩模式的颜色通道数（用于把通道 id 映射到平面下标） */
export function colorChannelCountForMode(colorMode: number): number {
  switch (colorMode) {
    case 3:
    case 7:
    case 9:
      return 3;
    case 4:
      return 4;
    default:
      return 1; // Bitmap / Grayscale / Indexed / Duotone
  }
}

export interface LayerParseContext {
  version: 1 | 2;
  colorMode: number;
  bitsPerChannel: number;
  /** Indexed 模式的交错调色板 */
  palette: Uint8Array | null;
  warnings: string[];
}

export interface LayerParseResult {
  /** 顶层图层数组（索引 0 = 最上层） */
  layers: DecodedLayer[];
  /** 图层总数（含组） */
  layerCount: number;
  /** 文件里的图层记录条数（含组分隔符，诊断用） */
  recordCount: number;
}

interface ChannelDescriptor {
  id: number;
  dataLength: number;
}

interface LayerRecord {
  name: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  channels: ChannelDescriptor[];
  blendMode: string;
  opacity: number;
  clipping: boolean;
  hidden: boolean;
  /** lsct 类型：1 = 打开的组、2 = 关闭的组、3 = 组结束分隔符；null = 普通图层 */
  sectionType: number | null;
  surface: DecodedSurface | null;
}

/** 单字节 Latin-1 解码（Pascal 图层名） */
function latin1(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return text;
}

/** UTF-16BE 解码（'luni' 附加信息块，中文图层名靠它） */
function utf16BeToString(bytes: Uint8Array): string {
  const units = bytes.length >> 1;
  let text = '';
  for (let i = 0; i < units; i++) text += String.fromCharCode((bytes[i * 2] << 8) | bytes[i * 2 + 1]);
  return text;
}

/** 名称规整：去掉尾部 \0 与空白；全空则回落默认名 */
function normalizeName(raw: string | null, fallbackIndex: number): string {
  if (raw) {
    const cleaned = raw.replace(/\0+$/g, '').trim();
    if (cleaned) return cleaned;
  }
  return `未命名图层 #${fallbackIndex + 1}`;
}

/** 解析图层记录（元信息部分，通道数据在全部记录之后统一读） */
function readLayerRecord(info: ByteReader, ctx: LayerParseContext, index: number): LayerRecord {
  const top = info.i32('图层上边界');
  const left = info.i32('图层左边界');
  const bottom = info.i32('图层下边界');
  const right = info.i32('图层右边界');

  const channelCount = info.u16('图层通道数');
  if (channelCount > 64) {
    throw new PsdDecodeError(
      `图层 #${index + 1} 声明了 ${channelCount} 个通道，超出合理范围（≤ 64）`,
      'INVALID_STRUCTURE',
    );
  }

  const channels: ChannelDescriptor[] = [];
  for (let c = 0; c < channelCount; c++) {
    channels.push({ id: info.i16('通道 id'), dataLength: info.u32('通道数据长度') });
  }

  const signature = info.ascii4('混合模式签名');
  if (signature !== '8BIM' && signature !== '8B64') {
    ctx.warnings.push(`图层 #${index + 1} 的混合模式签名异常（'${signature}'），已按规范继续解析`);
  }
  const blendMode = resolveBlendMode(info.ascii4('混合模式 key'), ctx.warnings);

  const opacityByte = info.u8('不透明度');
  const clippingByte = info.u8('裁剪标记');
  const flags = info.u8('图层标志');
  info.u8('填充字节');

  const extraLength = info.u32('附加数据长度');
  const extra = info.sub(extraLength, '图层附加数据');

  // 图层蒙版数据 / 混合范围数据：本解码器直接跳过
  const maskLength = extra.u32('图层蒙版数据长度');
  extra.skip(maskLength, '图层蒙版数据');
  const rangeLength = extra.u32('混合范围长度');
  extra.skip(rangeLength, '混合范围数据');

  const pascalLength = extra.u8('Pascal 图层名长度');
  const pascalBytes = extra.bytes(pascalLength, 'Pascal 图层名');
  const pascalPadding = (4 - ((1 + pascalLength) % 4)) % 4;
  extra.skip(pascalPadding, 'Pascal 图层名填充');
  const latinName = latin1(pascalBytes);

  let unicodeName: string | null = null;
  let sectionType: number | null = null;

  // 附加图层信息块：'8BIM' + key + 长度 + 数据（长度奇数时再补 1 字节）
  while (extra.remaining >= 12) {
    const blockSignature = extra.ascii4('附加信息块签名');
    if (blockSignature !== '8BIM' && blockSignature !== '8B64') {
      ctx.warnings.push(`图层 #${index + 1} 的附加信息块签名异常（'${blockSignature}'），已停止解析其附加数据`);
      break;
    }
    const key = extra.ascii4('附加信息块 key');
    const length = LONG_LENGTH_KEYS.has(key)
      ? extra.u64(`附加信息块 ${key} 长度`)
      : extra.u32(`附加信息块 ${key} 长度`);
    const block = extra.sub(length, `附加信息块 ${key}`);
    if (length % 2 === 1) extra.skip(1, `附加信息块 ${key} 填充`);

    if (key === 'luni') {
      if (block.remaining >= 4) {
        const units = block.u32('Unicode 名称码元数');
        const byteCount = Math.min(units * 2, block.remaining);
        unicodeName = utf16BeToString(block.bytes(byteCount, 'Unicode 名称'));
      }
    } else if (key === 'lsct') {
      if (block.remaining >= 4) sectionType = block.u32('分组类型');
    }
  }

  return {
    name: normalizeName(unicodeName ?? latinName, index),
    top,
    left,
    bottom,
    right,
    channels,
    blendMode,
    opacity: Math.min(1, Math.max(0, opacityByte / 255)),
    clipping: clippingByte !== 0,
    hidden: (flags & 0x02) !== 0,
    sectionType,
    surface: null,
  };
}

/** 读取一个记录的通道图像数据；组与蒙版通道只跳过不物化 */
function readRecordSurface(reader: ByteReader, record: LayerRecord, ctx: LayerParseContext): DecodedSurface | null {
  const width = record.right - record.left;
  const height = record.bottom - record.top;
  const isGroup = record.sectionType !== null;
  const usable = !isGroup && width > 0 && height > 0 && width <= 30000 && height <= 30000;

  if (!isGroup && !usable) {
    ctx.warnings.push(`图层「${record.name}」边界非法（${width}×${height}），已跳过其画面数据`);
  }

  const maxPlanes = colorChannelCountForMode(ctx.colorMode);
  const planes: (Uint8Array | null)[] = usable ? new Array<Uint8Array | null>(maxPlanes).fill(null) : [];
  let alpha: Uint8Array | null = null;
  let colorPlaneCount = 0;

  for (const channel of record.channels) {
    if (channel.dataLength < 2) {
      ctx.warnings.push(`图层「${record.name}」的通道 ${channel.id} 数据长度为 ${channel.dataLength}，已跳过`);
      continue;
    }
    const blockReader = reader.sub(channel.dataLength, `图层「${record.name}」通道 ${channel.id} 数据`);
    if (!usable) continue;

    if (channel.id === -2 || channel.id === -3) continue; // 用户蒙版 / 真实用户蒙版：不是颜色通道
    if (channel.id === -1) {
      alpha = readChannelPlane(blockReader, width, height, ctx.bitsPerChannel, ctx.version, `图层「${record.name}」透明度`);
      continue;
    }
    if (channel.id >= 0 && channel.id < maxPlanes) {
      planes[channel.id] = readChannelPlane(
        blockReader,
        width,
        height,
        ctx.bitsPerChannel,
        ctx.version,
        `图层「${record.name}」通道 ${channel.id}`,
      );
      colorPlaneCount = Math.max(colorPlaneCount, channel.id + 1);
      continue;
    }
    ctx.warnings.push(`图层「${record.name}」包含无法识别的通道 id ${channel.id}，已跳过`);
  }

  if (!usable) return null;

  if (colorPlaneCount === 0) {
    ctx.warnings.push(`图层「${record.name}」没有颜色通道数据，已跳过其画面数据`);
    return null;
  }

  const dense: Uint8Array[] = [];
  for (let i = 0; i < colorPlaneCount; i++) dense.push(planes[i] ?? new Uint8Array(width * height));

  const data = renderRgba({
    colorMode: ctx.colorMode,
    width,
    height,
    planes: dense,
    alpha,
    palette: ctx.palette,
  });

  return { width, height, data };
}

/** 统计树中节点总数（含组） */
export function countLayerNodes(layers: readonly DecodedLayer[]): number {
  let total = 0;
  const stack: DecodedLayer[] = [...layers];
  while (stack.length > 0) {
    const node = stack.pop() as DecodedLayer;
    total++;
    for (const child of node.children) stack.push(child);
  }
  return total;
}

/**
 * 由记录数组建树。
 *
 * 文件顺序是「分隔符 → 子层 → 容器」，因此**倒序遍历**：
 * type 3 → 出栈；type 1/2 → 建空 children、并入栈；其它 → 归入当前栈顶。
 */
function buildLayerTree(records: readonly LayerRecord[], warnings: string[]): DecodedLayer[] {
  const topLevel: DecodedLayer[] = [];
  const stack: DecodedLayer[][] = [topLevel];

  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];

    if (record.sectionType === 3) {
      if (stack.length > 1) stack.pop();
      else warnings.push('图层组的结束分隔符多于图层组，已忽略多余的结束分隔符');
      continue;
    }

    const node: DecodedLayer = {
      name: record.name,
      left: record.left,
      top: record.top,
      right: record.right,
      bottom: record.bottom,
      opacity: record.opacity,
      hidden: record.hidden,
      blendMode: record.blendMode,
      clipping: record.clipping,
      channelIds: record.channels.map((channel) => channel.id),
      children: [],
      surface: record.surface,
    };

    stack[stack.length - 1].unshift(node);
    if (record.sectionType === 1 || record.sectionType === 2) stack.push(node.children);
  }

  if (stack.length > 1) warnings.push('文件中的图层组未正常闭合，剩余子层已并入其父组');
  return topLevel;
}

/**
 * 解析「图层与蒙版信息段」（读取器需限定为该段的子读取器）。
 */
export function parseLayerAndMaskSection(reader: ByteReader, ctx: LayerParseContext): LayerParseResult {
  const layerInfoLength = ctx.version === 2 ? reader.u64('图层信息长度') : reader.u32('图层信息长度');
  if (layerInfoLength === 0) return { layers: [], layerCount: 0, recordCount: 0 };

  const info = reader.sub(layerInfoLength, '图层信息');

  const rawCount = info.i16('图层数');
  const count = Math.abs(rawCount);
  const records: LayerRecord[] = [];
  for (let i = 0; i < count; i++) records.push(readLayerRecord(info, ctx, i));

  // 通道图像数据：按「记录顺序 × 记录内通道顺序」紧随所有记录之后
  for (const record of records) record.surface = readRecordSurface(info, record, ctx);

  const layers = buildLayerTree(records, ctx.warnings);
  return { layers, layerCount: countLayerNodes(layers), recordCount: count };
}
