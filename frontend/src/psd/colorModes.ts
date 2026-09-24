/**
 * PSD 色彩模式的集中知识库（前端唯一真相来源）。
 *
 * 这里回答三个问题，界面与渲染层都依赖它：
 *   1. 这个模式叫什么、基色通道有几个？（用于展示与 alpha 判定）
 *   2. 预览的保真度如何？（exact / lossy / approximate —— 用于给用户准确的预期管理）
 *   3. 该走哪条解码引擎？（ag-psd 主引擎，还是自研兜底解码器）
 *
 * 保真度分级依据实测（详见 docs/ARCHITECTURE.md 的「色彩模式支持矩阵」）：
 *   · RGB / Grayscale / Indexed 8 位：ag-psd 与 Pillow 两套独立实现解码结果与参考图逐像素一致
 *   · CMYK：自研解码，与 Pillow 逐像素一致（MAE=0）；PSD 存的是**反相墨量**
 *   · Lab：自研解码，按 ICC PCS 的 D50 白点（Photoshop 的 Lab 基准）
 *   · Duotone：语义上需要双色调曲线才能还原，本版本按灰度近似
 *   · Multichannel：没有通用的 RGB 解释，本版本按前 3 个通道近似
 */
import type { PsdFidelity } from '@/types';

export interface ColorModeInfo {
  /** PSD 文件头里的编码值 */
  code: number;
  /** 规范/Photoshop 中的名称 */
  name: string;
  /**
   * 基色通道数（不含 alpha）。`null` 表示不固定 —— 只有 Multichannel 如此，
   * 它可以带任意多个专色通道，因此无法据此判断是否含 alpha。
   */
  baseChannels: number | null;
  /** 预览保真度 */
  fidelity: PsdFidelity;
  /** 需要向用户说明的近似/降级原因（中文）；保真度为 exact 时不存在 */
  note?: string;
}

const TABLE: ColorModeInfo[] = [
  {
    code: 0,
    name: 'Bitmap',
    baseChannels: 1,
    fidelity: 'exact',
  },
  {
    code: 1,
    name: 'Grayscale',
    baseChannels: 1,
    fidelity: 'exact',
  },
  {
    code: 2,
    name: 'Indexed',
    baseChannels: 1,
    fidelity: 'exact',
    note: '颜色被量化到 256 色调色板，与 Photoshop 显示一致。',
  },
  {
    code: 3,
    name: 'RGB',
    baseChannels: 3,
    fidelity: 'exact',
  },
  {
    code: 4,
    name: 'CMYK',
    baseChannels: 4,
    fidelity: 'lossy',
    note: '按印刷墨量换算为屏幕 RGB。未内嵌 ICC 特性文件时使用标准换算，与 Photoshop 的色彩管理结果可能有细微差异。',
  },
  {
    code: 7,
    name: 'Multichannel',
    baseChannels: null,
    fidelity: 'approximate',
    note: '多通道模式没有通用的 RGB 解释（常含专色通道），此处按前 3 个通道近似预览。',
  },
  {
    code: 8,
    name: 'Duotone',
    baseChannels: 1,
    fidelity: 'approximate',
    note: '双色调需要曲线数据才能还原专色油墨效果，此处按灰度近似预览。',
  },
  {
    code: 9,
    name: 'Lab',
    baseChannels: 3,
    fidelity: 'lossy',
    note: '按 ICC PCS 的 D50 白点换算到 sRGB。超出 sRGB 色域的颜色会被裁剪。',
  },
];

const BY_CODE = new Map(TABLE.map((info) => [info.code, info]));

/** 全部已收录的色彩模式（按编码升序） */
export const COLOR_MODES: readonly ColorModeInfo[] = TABLE;

/** 取色彩模式信息；未知编码返回一个保真度为 approximate 的占位项 */
export function colorModeInfo(code: number | null | undefined): ColorModeInfo {
  if (typeof code === 'number' && BY_CODE.has(code)) return BY_CODE.get(code)!;
  return {
    code: typeof code === 'number' ? code : -1,
    name: typeof code === 'number' ? `未知(${code})` : '未知',
    baseChannels: null,
    fidelity: 'approximate',
    note: '未收录的色彩模式，预览结果仅供参考。',
  };
}

/** 保真度分级 */
export function fidelityOf(code: number | null | undefined): PsdFidelity {
  return colorModeInfo(code).fidelity;
}

/**
 * 按**名称**反查色彩模式信息。
 *
 * 需要这个函数是因为两个来源的表示不同：
 *   · `Project.psd.colorMode`（后端契约字段）是字符串，如 "CMYK"
 *   · 前端解析结果的 `colorMode` 也是字符串（自研解码器/ag-psd 归一化后）
 * 大小写不敏感；同时兼容早期契约里把编码 7 写成 "Multicolor" 的历史。
 */
export function colorModeInfoByName(name: string | null | undefined): ColorModeInfo | null {
  if (!name) return null;
  const normalized = name.trim().toLowerCase();
  if (normalized === 'multicolor') return colorModeInfo(7); // 历史写法
  const aliases: Record<string, number> = {
    bitmap: 0,
    grayscale: 1,
    greyscale: 1,
    indexed: 2,
    rgb: 3,
    cmyk: 4,
    multichannel: 7,
    duotone: 8,
    lab: 9,
  };
  const code = aliases[normalized];
  return code === undefined ? null : colorModeInfo(code);
}

/** ag-psd 主引擎支持的色彩模式（8 位时） */
const NATIVE_SUPPORTED = new Set([1, 2, 3]);

/** ag-psd 是否能在 8 位下可靠解码该模式 */
export function isNativeSupported(code: number | null | undefined): boolean {
  return typeof code === 'number' && NATIVE_SUPPORTED.has(code);
}

/** 保真度对应的中文标签与语义色名，供界面统一渲染 */
export const FIDELITY_LABEL: Record<PsdFidelity, string> = {
  exact: '精确',
  lossy: '色彩换算',
  approximate: '近似预览',
};

/** 保真度 → CSS 类名后缀（样式定义在 styles/components.css） */
export const FIDELITY_TONE: Record<PsdFidelity, string> = {
  exact: 'ok',
  lossy: 'info',
  approximate: 'warn',
};
