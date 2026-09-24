#!/usr/bin/env node
/**
 * 生成多色彩模式的示例 PSD / PNG 素材，用于端到端冒烟与解码器回归测试。
 *
 * 设计要点：
 * - **零依赖**：直接按 Adobe PSD 文件格式规范手写字节流，不依赖 ag-psd / canvas。
 *   这既让素材生成与实现解耦，也让它成为「PSD 结构理解是否正确」的独立参照物。
 * - 覆盖的维度：
 *     · 色彩模式：RGB / Grayscale / Indexed / CMYK / Multichannel / Duotone / Lab
 *     · 位深：8 / 16
 *     · 压缩：raw(0) / RLE(1)
 *     · 结构：扁平化 vs 含图层组 / 混合模式（用于图层树回归）
 * - 每个 PSD 同时导出一份「参考 PNG」，即该文件**按规范解码后应得的画面**。
 *   解码器测试拿自己的解码结果与它逐像素比对。
 *      · CMYK / Lab / Grayscale / Duotone / Multichannel：参考图 = 往返计算后的 RGB
 *      · Indexed：参考图 = 调色板量化后的画面（解码必须与它**完全一致**）
 * - 生成清单写入 `fixtures/manifest.json`，供测试与文档读取。
 *
 * 用法：`node tools/make-sample-psd.mjs`（或根目录 `npm run fixture`）
 * 自检：`npm run verify:fixtures`
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'fixtures');

/* ══════════════════════════════════════════════════════════════════════
   色彩模式表（编码值来自 PSD 文件头规范）
   ══════════════════════════════════════════════════════════════════════ */

export const COLOR_MODES = {
  0: { code: 0, name: 'Bitmap', channels: 1, bits: 1 },
  1: { code: 1, name: 'Grayscale', channels: 1, bits: 8 },
  2: { code: 2, name: 'Indexed', channels: 1, bits: 8 },
  3: { code: 3, name: 'RGB', channels: 3, bits: 8 },
  4: { code: 4, name: 'CMYK', channels: 4, bits: 8 },
  7: { code: 7, name: 'Multichannel', channels: 3, bits: 8 },
  8: { code: 8, name: 'Duotone', channels: 1, bits: 8 },
  9: { code: 9, name: 'Lab', channels: 3, bits: 8 },
};

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/* ══════════════════════════════════════════════════════════════════════
   二进制写入助手
   ══════════════════════════════════════════════════════════════════════ */

class ByteWriter {
  constructor() {
    this.parts = [];
    this.size = 0;
  }
  u8(v) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v & 0xff, 0);
    return this._push(b);
  }
  u16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v & 0xffff, 0);
    return this._push(b);
  }
  i16(v) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v | 0, 0);
    return this._push(b);
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0, 0);
    return this._push(b);
  }
  i32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v | 0, 0);
    return this._push(b);
  }
  ascii(s) {
    return this._push(Buffer.from(s, 'latin1'));
  }
  bytes(buf) {
    return this._push(Buffer.from(buf));
  }
  _push(buf) {
    this.parts.push(buf);
    this.size += buf.length;
    return this;
  }
  buffer() {
    return Buffer.concat(this.parts, this.size);
  }
}

/** Pascal 字符串：1 字节长度 + 内容，补齐到 4 字节倍数 */
function pascalString(text) {
  const raw = Buffer.from(text, 'latin1').subarray(0, 255);
  const total = 1 + raw.length;
  const out = Buffer.alloc(total + ((4 - (total % 4)) % 4));
  out.writeUInt8(raw.length, 0);
  raw.copy(out, 1);
  return out;
}

/** 'luni' 负载：4 字节码元数 + UTF-16BE（用于中文图层名） */
function unicodeStringPayload(text) {
  const units = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else units.push(cp);
  }
  const buf = Buffer.alloc(4 + units.length * 2);
  buf.writeUInt32BE(units.length, 0);
  units.forEach((u, i) => buf.writeUInt16BE(u, 4 + i * 2));
  return buf;
}

/* ══════════════════════════════════════════════════════════════════════
   PackBits (RLE) 编码
   规范：n(0..127) → 紧随其后 n+1 字节原样复制
          n(129..255) → 紧随 1 字节重复 (257-n) 次
          n = 128 → 空操作
   ══════════════════════════════════════════════════════════════════════ */

export function packbits(row) {
  const out = [];
  const n = row.length;
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && row[i + run] === row[i] && run < 128) run++;

    if (run >= 2) {
      out.push(256 - (run - 1), row[i]);
      i += run;
      continue;
    }

    // 字面量：最多 128 字节，遇到「连续 3 个相同字节」就停下让位给游程
    const start = i;
    let lit = 0;
    while (i < n && lit < 128) {
      if (lit > 0 && i + 2 < n && row[i] === row[i + 1] && row[i + 1] === row[i + 2]) break;
      i++;
      lit++;
    }
    out.push(lit - 1);
    for (let k = 0; k < lit; k++) out.push(row[start + k]);
  }
  return Buffer.from(out);
}

/* ══════════════════════════════════════════════════════════════════════
   通道数据编码
   ══════════════════════════════════════════════════════════════════════ */

/** 8 位样本平面 → 指定位深的字节（16 位按 v*257 放大，保证 >>8 精确还原） */
function toBitDepth(samples8, bits) {
  if (bits === 8) return Buffer.from(samples8);
  if (bits === 16) {
    const out = Buffer.alloc(samples8.length * 2);
    for (let i = 0; i < samples8.length; i++) out.writeUInt16BE(samples8[i] * 257, i * 2);
    return out;
  }
  throw new Error(`不支持的位深：${bits}`);
}

/**
 * 单个通道的 channel image data（图层用）：2 字节压缩标志 + 数据。
 * RLE 时行长度表为 height 项（仅本通道）。
 */
function encodeLayerChannel(plane8, width, height, bits, compression) {
  const w = new ByteWriter();
  if (compression === 0) return w.u16(0).bytes(toBitDepth(plane8, bits)).buffer();

  const bytesPerRow = (width * bits) / 8;
  const samples = toBitDepth(plane8, bits);
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(packbits(samples.subarray(y * bytesPerRow, (y + 1) * bytesPerRow)));
  w.u16(1);
  for (const r of rows) w.u16(r.length);
  for (const r of rows) w.bytes(r);
  return w.buffer();
}

/**
 * 合成图像数据段：2 字节压缩标志 + 数据。
 * RLE 时行长度表为「通道优先」：先 channel0 的全部行，再 channel1 …
 */
function encodeComposite(planes8, width, height, bits, compression) {
  const w = new ByteWriter();
  if (compression === 0) {
    w.u16(0);
    for (const p of planes8) w.bytes(toBitDepth(p, bits));
    return w.buffer();
  }

  const bytesPerRow = (width * bits) / 8;
  const perChannel = planes8.map((p) => {
    const samples = toBitDepth(p, bits);
    const rows = [];
    for (let y = 0; y < height; y++) rows.push(packbits(samples.subarray(y * bytesPerRow, (y + 1) * bytesPerRow)));
    return rows;
  });

  w.u16(1);
  for (const rows of perChannel) for (const r of rows) w.u16(r.length);
  for (const rows of perChannel) for (const r of rows) w.bytes(r);
  return w.buffer();
}

/* ══════════════════════════════════════════════════════════════════════
   色彩转换
   ══════════════════════════════════════════════════════════════════════ */

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/**
 * sRGB → CIE XYZ（D50 白点）。
 *
 * 为什么用 D50：Photoshop 的 Lab 模式基于 ICC 的 PCS 照明体（D50）。若按 D65 处理，
 * Lab 文件解出来的画面会整体偏色（实测与 Pillow 的 Lab 解码相差 MAE≈66），
 * 因此这里与 Photoshop 对齐。矩阵取自 Lindbloom 的「sRGB with D50 white point」推荐值。
 */
function rgbToXyz(r, g, b) {
  const R = srgbToLinear(r / 255);
  const G = srgbToLinear(g / 255);
  const B = srgbToLinear(b / 255);
  return [
    R * 0.4360747 + G * 0.3850649 + B * 0.1430804,
    R * 0.2225045 + G * 0.7168786 + B * 0.0606169,
    R * 0.0139322 + G * 0.0971045 + B * 0.7141733,
  ];
}

/** CIE XYZ（D50）→ sRGB（0..255，已 clamp） */
export function xyzToRgb(X, Y, Z) {
  const R = X * 3.1338561 + Y * -1.6168667 + Z * -0.4906146;
  const G = X * -0.9787684 + Y * 1.9161415 + Z * 0.033454;
  const B = X * 0.0719453 + Y * -0.2289914 + Z * 1.4052427;
  return [clamp255(linearToSrgb(R) * 255), clamp255(linearToSrgb(G) * 255), clamp255(linearToSrgb(B) * 255)];
}

/** ICC PCS 照明体 D50（Photoshop Lab 的参考白） */
export const D50 = [0.9642, 1.0, 0.8249];
const labF = (t) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
export const labFInv = (t) => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29));

/**
 * RGB → 目标色彩模式的样本平面。
 * 返回 { planes, reference }：
 *   planes    = 该模式下的 8 位样本平面
 *   reference = 解码后**应当**得到的 RGBA（用于生成参考 PNG）
 */
export function encodeToMode(rgba, modeCode, palette) {
  const n = rgba.length / 4;
  const rgb = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
    alpha[i] = rgba[i * 4 + 3];
  }

  switch (modeCode) {
    case 3: {
      const planes = [];
      for (let c = 0; c < 3; c++) {
        const p = new Uint8Array(n);
        for (let i = 0; i < n; i++) p[i] = rgb[i * 3 + c];
        planes.push(p);
      }
      return { planes, reference: new Uint8Array(rgba) };
    }

    case 1:
    case 8: {
      // Grayscale / Duotone（Duotone 按灰度近似，解码端同样处理）
      const p = new Uint8Array(n);
      const ref = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const y = clamp255(0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]);
        p[i] = y;
        ref[i * 4] = ref[i * 4 + 1] = ref[i * 4 + 2] = y;
        ref[i * 4 + 3] = alpha[i];
      }
      return { planes: [p], reference: ref };
    }

    case 4: {
      // CMYK：PSD 存的是**反相墨量**（255 = 无墨，0 = 满墨）。
      // 反向转换即 R = stored_C * stored_K / 255（与 Pillow/libvips 的实现逐像素一致）。
      const c = new Uint8Array(n);
      const m = new Uint8Array(n);
      const y = new Uint8Array(n);
      const k = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const cInk = 1 - rgb[i * 3] / 255;
        const mInk = 1 - rgb[i * 3 + 1] / 255;
        const yInk = 1 - rgb[i * 3 + 2] / 255;
        const kInk = Math.min(cInk, mInk, yInk);
        const denom = 1 - kInk;
        c[i] = clamp255(255 * (1 - (denom <= 0 ? 0 : (cInk - kInk) / denom)));
        m[i] = clamp255(255 * (1 - (denom <= 0 ? 0 : (mInk - kInk) / denom)));
        y[i] = clamp255(255 * (1 - (denom <= 0 ? 0 : (yInk - kInk) / denom)));
        k[i] = clamp255(255 * (1 - kInk));
      }
      return { planes: [c, m, y, k], reference: new Uint8Array(rgba) };
    }

    case 9: {
      // Lab：L* 0..100 → 0..255，a*/b* -128..127 → 0..255
      const L = new Uint8Array(n);
      const A = new Uint8Array(n);
      const B = new Uint8Array(n);
      const ref = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const [X, Y, Z] = rgbToXyz(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
        const fx = labF(X / D50[0]);
        const fy = labF(Y / D50[1]);
        const fz = labF(Z / D50[2]);
        L[i] = clamp255(((116 * fy - 16) / 100) * 255);
        A[i] = clamp255(500 * (fx - fy) + 128);
        B[i] = clamp255(200 * (fy - fz) + 128);
        // 参考图 = 用存储值往返得到的 RGB（解码器必须与这套数学一致）
        const fy2 = ((L[i] / 255) * 100 + 16) / 116;
        const [r2, g2, b2] = xyzToRgb(
          labFInv(fy2 + (A[i] - 128) / 500) * D50[0],
          labFInv(fy2) * D50[1],
          labFInv(fy2 - (B[i] - 128) / 200) * D50[2],
        );
        ref[i * 4] = r2;
        ref[i * 4 + 1] = g2;
        ref[i * 4 + 2] = b2;
        ref[i * 4 + 3] = alpha[i];
      }
      return { planes: [L, A, B], reference: ref };
    }

    case 7: {
      // Multichannel：无通用转换规则，按 RGB 三通道直存，解码端按 RGB 解释（近似）
      const planes = [];
      for (let c = 0; c < 3; c++) {
        const p = new Uint8Array(n);
        for (let i = 0; i < n; i++) p[i] = rgb[i * 3 + c];
        planes.push(p);
      }
      return { planes, reference: new Uint8Array(rgba) };
    }

    case 2: {
      // Indexed：量化到调色板；参考图 = 量化后的画面（解码必须完全一致）
      const idx = new Uint8Array(n);
      const ref = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const k = nearestPaletteIndex(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], palette);
        idx[i] = k;
        ref[i * 4] = palette[k * 3];
        ref[i * 4 + 1] = palette[k * 3 + 1];
        ref[i * 4 + 2] = palette[k * 3 + 2];
        ref[i * 4 + 3] = alpha[i];
      }
      return { planes: [idx], reference: ref };
    }

    default:
      throw new Error(`素材生成器暂不支持色彩模式 ${modeCode}`);
  }
}

/** 6×6×6 网页安全色立方（216 色）+ 40 级灰阶，凑满 256 项调色板（**交错** RGB，便于程序内部使用） */
export function buildWebSafePalette() {
  const palette = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        palette[i * 3] = r * 51;
        palette[i * 3 + 1] = g * 51;
        palette[i * 3 + 2] = b * 51;
        i++;
      }
    }
  }
  for (let k = 0; k < 40; k++, i++) {
    const v = Math.round((k / 39) * 255);
    palette[i * 3] = palette[i * 3 + 1] = palette[i * 3 + 2] = v;
  }
  return palette;
}

/**
 * 把交错 RGB 调色板转成 PSD color mode data 段的字节序。
 *
 * ⚠️ 这里有个容易踩的坑：PSD 的 Indexed 调色板**不是** RGB 交错存放，
 * 而是**平面存放** —— 先 256 个 R，再 256 个 G，最后 256 个 B。
 * 这一点由 ag-psd 与 Pillow 两个独立实现交叉验证确认：
 * 按平面解读本文件即可复现两库读出的调色板数值。
 */
export function paletteToColorModeData(palette) {
  const out = Buffer.alloc(768);
  for (let i = 0; i < 256; i++) {
    out[i] = palette[i * 3];
    out[256 + i] = palette[i * 3 + 1];
    out[512 + i] = palette[i * 3 + 2];
  }
  return out;
}

function nearestPaletteIndex(r, g, b, palette) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 256; i++) {
    const dr = r - palette[i * 3];
    const dg = g - palette[i * 3 + 1];
    const db = b - palette[i * 3 + 2];
    const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/* ══════════════════════════════════════════════════════════════════════
   PSD 组装
   ══════════════════════════════════════════════════════════════════════ */

const CHANNEL_IDS = {
  RGB: [0, 1, 2, -1],
  CMYK: [0, 1, 2, 3, -1],
  Lab: [0, 1, 2, -1],
  Multichannel: [0, 1, 2, -1],
  Grayscale: [0, -1],
  Duotone: [0, -1],
  Indexed: [0],
};

function buildExtraData(layer) {
  const extra = new ByteWriter();
  extra.u32(0).u32(0); // 图层蒙版数据 / 混合范围均为空
  extra.bytes(pascalString(layer.latinName ?? 'Layer'));
  if (layer.unicodeName) {
    const payload = unicodeStringPayload(layer.unicodeName);
    extra.ascii('8BIM').ascii('luni').u32(payload.length).bytes(payload);
  }
  if (layer.sectionType) {
    const isFolder = layer.sectionType === 1 || layer.sectionType === 2;
    extra.ascii('8BIM').ascii('lsct').u32(isFolder ? 12 : 4).u32(layer.sectionType);
    if (isFolder) extra.ascii('8BIM').ascii('norm').u32(0);
  }
  return extra.buffer();
}

/**
 * 组装一个完整的 PSD 文件。
 *
 * @param {object} spec
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} spec.colorMode            色彩模式编码
 * @param {number} [spec.bitsPerChannel=8]   8 / 16
 * @param {number} [spec.compression=0]      0 raw / 1 RLE
 * @param {Buffer} [spec.colorModeData]      色彩模式数据段（Indexed 调色板等）
 * @param {Array}  [spec.layers]             图层，自上而下
 * @param {Uint8Array[]} spec.compositePlanes 合成图平面
 */
export function buildPsd(spec) {
  const {
    width,
    height,
    colorMode,
    bitsPerChannel = 8,
    compression = 0,
    colorModeData = Buffer.alloc(0),
    layers = [],
    compositePlanes,
  } = spec;

  const mode = COLOR_MODES[colorMode];
  if (!mode) throw new Error(`未知色彩模式编码：${colorMode}`);
  if (!compositePlanes || compositePlanes.length === 0) throw new Error('缺少合成图平面');

  /* ---------- 图层与蒙版信息段 ---------- */
  let layerInfo = Buffer.alloc(0);
  if (layers.length > 0) {
    const records = new ByteWriter();
    records.i16(layers.length);
    for (const layer of layers) {
      const { top, left, bottom, right } = layer.bounds;
      records.i32(top).i32(left).i32(bottom).i32(right);

      const channelIds = layer.channelIds ?? CHANNEL_IDS[mode.name];
      const blocks = layer.planes.map((plane, i) =>
        encodeLayerChannel(plane, Math.max(1, right - left), Math.max(1, bottom - top), bitsPerChannel, compression),
      );
      records.u16(blocks.length);
      blocks.forEach((block, i) => {
        records.i16(channelIds[i] ?? 0);
        records.u32(block.length);
      });

      records.ascii('8BIM').ascii((layer.blendKey ?? 'norm').padEnd(4, ' ').slice(0, 4));
      records.u8(layer.opacity ?? 255);
      records.u8(0); // 裁剪
      records.u8(0x08 | (layer.hidden ? 0x02 : 0)); // flags：bit1=隐藏, bit3=Photoshop 5.0+ 有效信息
      records.u8(0);
      const extra = buildExtraData(layer);
      records.u32(extra.length).bytes(extra);
      layer._blocks = blocks;
    }
    for (const layer of layers) for (const block of layer._blocks) records.bytes(block);
    layerInfo = records.buffer();
  }

  const layerAndMask = new ByteWriter();
  layerAndMask.u32(layerInfo.length).bytes(layerInfo).u32(0); // 全局图层蒙版信息为空
  const layerAndMaskBytes = layerAndMask.buffer();

  /* ---------- 文件头（26 字节） ---------- */
  const header = new ByteWriter();
  header.ascii('8BPS').u16(1).bytes(Buffer.alloc(6));
  header.u16(spec.compositeChannels ?? compositePlanes.length);
  header.u32(height).u32(width).u16(bitsPerChannel).u16(colorMode);

  /* ---------- 拼装 ---------- */
  const cm = new ByteWriter();
  cm.u32(colorModeData.length).bytes(colorModeData);
  const lmLen = new ByteWriter();
  lmLen.u32(layerAndMaskBytes.length);

  return Buffer.concat([
    header.buffer(),
    cm.buffer(),
    Buffer.alloc(4), // 图像资源段长度 = 0
    lmLen.buffer(),
    layerAndMaskBytes,
    encodeComposite(compositePlanes, width, height, bitsPerChannel, compression),
  ]);
}

/* ══════════════════════════════════════════════════════════════════════
   最小 PNG 编码器（导出参考图）
   ══════════════════════════════════════════════════════════════════════ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ══════════════════════════════════════════════════════════════════════
   画面内容
   ══════════════════════════════════════════════════════════════════════ */

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

/** 按 paint(x,y) → [r,g,b,a] 生成边界内的 RGBA */
function paintLayer(bounds, paint) {
  const w = bounds.right - bounds.left;
  const h = bounds.bottom - bounds.top;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(bounds.left + x, bounds.top + y);
      const i = (y * w + x) * 4;
      rgba[i] = clamp255(r);
      rgba[i + 1] = clamp255(g);
      rgba[i + 2] = clamp255(b);
      rgba[i + 3] = clamp255(a);
    }
  }
  return rgba;
}

/**
 * 简易 alpha-over 合成，最后压平到白底。
 *
 * 注意：**隐藏图层不参与合成** —— Photoshop 保存的合成图就是「可见图层的烘焙结果」，
 * 这一点对上层「显示所有已显示图层、忽略被隐藏图层」的语义至关重要。
 */
function composite(width, height, layersBottomUp) {
  const acc = new Uint8Array(width * height * 4);
  for (const { bounds, rgba, hidden } of layersBottomUp) {
    if (hidden) continue;
    const w = bounds.right - bounds.left;
    for (let y = 0; y < bounds.bottom - bounds.top; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4;
        const sa = rgba[si + 3] / 255;
        if (sa === 0) continue;
        const di = ((bounds.top + y) * width + (bounds.left + x)) * 4;
        const da = acc[di + 3] / 255;
        const outA = sa + da * (1 - sa);
        if (outA <= 0) continue;
        for (let c = 0; c < 3; c++) acc[di + c] = clamp255((rgba[si + c] * sa + acc[di + c] * da * (1 - sa)) / outA);
        acc[di + 3] = clamp255(outA * 255);
      }
    }
  }
  const flat = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = acc[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) flat[i * 4 + c] = clamp255(acc[i * 4 + c] * a + 255 * (1 - a));
    flat[i * 4 + 3] = 255;
  }
  return flat;
}

/** RGB 展示场景（保留既有测试依赖：1200×800、9 条图层记录、含图层组与 screen 混合） */
function buildShowcaseScene(width, height) {
  const full = { top: 0, left: 0, bottom: height, right: width };

  const background = {
    name: '背景 · 渐变',
    latin: 'Background Gradient',
    bounds: full,
    blendKey: 'norm',
    rgba: paintLayer(full, (x, y) => {
      const [r, g, b] = mix([26, 20, 48], [58, 30, 92], (x / width) * 0.55 + (y / height) * 0.45);
      return [r, g, b, 255];
    }),
  };
  const circle = {
    name: '圆形 · 珊瑚',
    latin: 'Circle Coral',
    bounds: full,
    blendKey: 'norm',
    rgba: paintLayer(full, (x, y) => {
      const d = Math.hypot(x - width * 0.28, y - height * 0.42);
      return [255, 122, 108, Math.max(0, Math.min(1, (Math.min(width, height) * 0.26 - d) / 6)) * 255];
    }),
  };
  const circle2 = {
    name: '圆形 · 青蓝',
    latin: 'Circle Cyan',
    bounds: full,
    blendKey: 'norm',
    rgba: paintLayer(full, (x, y) => {
      const d = Math.hypot(x - width * 0.44, y - height * 0.58);
      return [86, 214, 232, Math.max(0, Math.min(1, (Math.min(width, height) * 0.22 - d) / 6)) * 200];
    }),
  };
  const stripeBounds = { top: Math.round(height * 0.6), left: 0, bottom: height, right: Math.round(width * 0.5) };
  const stripes = {
    name: '斜条纹',
    latin: 'Diagonal Stripes',
    bounds: stripeBounds,
    blendKey: 'norm',
    rgba: paintLayer(stripeBounds, (x, y) => (Math.floor((x + y) / 26) % 2 === 0 ? [255, 255, 255, 90] : [255, 255, 255, 0])),
  };
  const glow = {
    name: '高光 · 滤色',
    latin: 'Glow Screen',
    bounds: full,
    blendKey: 'scrn',
    opacity: 200,
    rgba: paintLayer(full, (x, y) => {
      const d = Math.hypot(x - width * 0.78, y - height * 0.24);
      return [180, 220, 255, Math.max(0, 1 - d / (Math.min(width, height) * 0.45)) * 160];
    }),
  };

  const gb = {
    top: Math.round(height * 0.66),
    left: Math.round(width * 0.08),
    bottom: Math.round(height * 0.94),
    right: Math.round(width * 0.92),
  };
  const titleBounds = { top: gb.top + 10, left: gb.left + 10, bottom: gb.top + 74, right: gb.left + 560 };
  const titleBar = {
    name: '标题文字占位',
    latin: 'Title Placeholder',
    bounds: titleBounds,
    blendKey: 'norm',
    rgba: paintLayer(titleBounds, (x, y) => {
      const lx = x - (gb.left + 10);
      const ly = y - (gb.top + 10);
      return ly > 8 && ly < 50 && lx < 540 ? [244, 244, 255, 235] : [0, 0, 0, 0];
    }),
  };
  const subBounds = { top: gb.top + 74, left: gb.left + 10, bottom: gb.top + 104, right: gb.left + 380 };
  const subtitleBar = {
    name: '副标题文字占位',
    latin: 'Subtitle Placeholder',
    bounds: subBounds,
    blendKey: 'norm',
    rgba: paintLayer(subBounds, (x, y) => {
      const lx = x - (gb.left + 10);
      const ly = y - (gb.top + 74);
      return ly > 4 && ly < 20 && lx < 360 ? [190, 196, 230, 200] : [0, 0, 0, 0];
    }),
  };

  const groupOpen = { name: '文字组', latin: 'Text Group', bounds: gb, sectionType: 1, isGroup: true };
  const groupClose = { name: '</图层组>', latin: '</Layer group>', bounds: { top: 0, left: 0, bottom: 0, right: 0 }, sectionType: 3, isGroup: true };

  // 组的结束分隔符在子层之前、容器记录在子层之后（与 ag-psd 写入口径一致）
  const ordered = [glow, groupClose, titleBar, subtitleBar, groupOpen, stripes, circle2, circle, background];
  return { ordered, bottomUp: [background, circle, circle2, stripes, titleBar, subtitleBar, glow] };
}

/** 色卡场景：覆盖各种色彩模式下的色彩还原能力 */
function buildColorChartScene(width, height) {
  const patches = [
    [0, 0, 0], [255, 255, 255], [230, 40, 40], [40, 170, 90],
    [40, 90, 220], [240, 200, 40], [30, 190, 200], [200, 60, 190],
    [128, 128, 128], [12, 12, 12], [245, 245, 245], [100, 60, 30],
    [255, 128, 0], [0, 128, 128], [110, 30, 120], [220, 220, 190],
  ];
  const cols = 4;
  const rows = 4;
  const cw = width / cols;
  const ch = height / rows;
  const full = { top: 0, left: 0, bottom: height, right: width };

  const chart = {
    name: '色卡',
    latin: 'Color Chart',
    bounds: full,
    blendKey: 'norm',
    rgba: paintLayer(full, (x, y) => {
      const cx = Math.min(cols - 1, Math.floor(x / cw));
      const cy = Math.min(rows - 1, Math.floor(y / ch));
      const p = patches[cy * cols + cx] ?? [0, 0, 0];
      const k = 0.7 + 0.3 * ((x % cw) / cw);
      return [p[0] * k, p[1] * k, p[2] * k, 255];
    }),
  };
  const badgeBounds = { top: Math.round(height * 0.62), left: Math.round(width * 0.62), bottom: height, right: width };
  const badge = {
    name: '角标',
    latin: 'Badge',
    bounds: badgeBounds,
    blendKey: 'norm',
    rgba: paintLayer(badgeBounds, (x, y) => {
      const d = Math.hypot(x - width * 0.86, y - height * 0.84);
      return [255, 255, 255, Math.max(0, Math.min(1, (Math.min(width, height) * 0.14 - d) / 4)) * 200];
    }),
  };

  return { ordered: [badge, chart], bottomUp: [chart, badge] };
}

/* ══════════════════════════════════════════════════════════════════════
   素材输出
   ══════════════════════════════════════════════════════════════════════ */

function alphaPlane(rgba) {
  const n = rgba.length / 4;
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = rgba[i * 4 + 3];
  return a;
}

function emitVariant({
  fileName,
  scene,
  colorMode,
  bitsPerChannel = 8,
  compression = 0,
  withLayers = true,
  palette = buildWebSafePalette(),
  hidden = [],
}) {
  const { ordered, bottomUp } = scene;
  const mode = COLOR_MODES[colorMode];
  const hiddenSet = new Set(hidden);
  const solid = ordered.filter((l) => !l.isGroup);
  const width = Math.max(...solid.map((l) => l.bounds.right));
  const height = Math.max(...solid.map((l) => l.bounds.bottom));

  const encodedLayers = [];
  if (withLayers) {
    for (const layer of ordered) {
      if (layer.isGroup) {
        encodedLayers.push({
          name: layer.name,
          latinName: layer.latin,
          unicodeName: /[^\x00-\xff]/.test(layer.name) ? layer.name : undefined,
          bounds: layer.bounds,
          sectionType: layer.sectionType,
          blendKey: 'pass',
          opacity: 255,
          hidden: hiddenSet.has(layer.name),
          planes: Array.from({ length: mode.channels + 1 }, () => new Uint8Array(0)),
        });
        continue;
      }
      const { planes } = encodeToMode(layer.rgba, colorMode, palette);
      planes.push(alphaPlane(layer.rgba));
      encodedLayers.push({
        name: layer.name,
        latinName: layer.latin,
        unicodeName: /[^\x00-\xff]/.test(layer.name) ? layer.name : undefined,
        bounds: layer.bounds,
        blendKey: layer.blendKey,
        opacity: layer.opacity ?? 255,
        hidden: hiddenSet.has(layer.name),
        planes,
      });
    }
  }

  // 合成图必须忽略隐藏图层 —— 这正是 Photoshop 的行为，也是上层「只展示已显示图层」的依据
  const flat = composite(
    width,
    height,
    bottomUp.map((l) => ({ ...l, hidden: hiddenSet.has(l.name) })),
  );
  const { planes: compositePlanes, reference } = encodeToMode(flat, colorMode, palette);

  const psd = buildPsd({
    width,
    height,
    colorMode,
    bitsPerChannel,
    compression,
    colorModeData: colorMode === 2 ? paletteToColorModeData(palette) : Buffer.alloc(0),
    layers: encodedLayers,
    compositePlanes,
  });

  writeFileSync(join(OUT_DIR, `${fileName}.psd`), psd);
  writeFileSync(join(OUT_DIR, `${fileName}.png`), encodePng(width, height, reference));
  // 同时导出裸 RGBA：解码器测试可以零依赖地逐像素比对（不需要 PNG 解码器）
  writeFileSync(join(OUT_DIR, `${fileName}.rgba`), Buffer.from(reference.buffer, reference.byteOffset, reference.length));

  return {
    file: `${fileName}.psd`,
    reference: `${fileName}.png`,
    rawReference: `${fileName}.rgba`,
    width,
    height,
    colorMode,
    colorModeName: mode.name,
    bitsPerChannel,
    compression: compression === 0 ? 'raw' : 'rle',
    channels: compositePlanes.length,
    layerRecords: encodedLayers.length,
    bytes: psd.length,
  };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = [];

  /* ---------- RGB 主素材（既有测试依赖：1200×800 / 9 条图层记录 / 组 / screen）---------- */
  const showcase = buildShowcaseScene(1200, 800);
  manifest.push(
    emitVariant({ fileName: 'sample-ui', scene: showcase, colorMode: 3, compression: 0 }),
    emitVariant({ fileName: 'sample-ui-rle', scene: showcase, colorMode: 3, compression: 1 }),
    // 含隐藏图层的变体：用于回归「带隐藏图层的工程不能被降级渲染」这个缺陷。
    // 隐藏的两层分别是组内的「副标题文字占位」与独立的「斜条纹」。
    emitVariant({
      fileName: 'sample-ui-hidden',
      scene: showcase,
      colorMode: 3,
      compression: 1,
      hidden: ['斜条纹', '副标题文字占位'],
    }),
  );

  /* ---------- 小尺寸 RGB（既有测试依赖：320×200 / 圆点 + 背景）---------- */
  const miniBounds = { top: 0, left: 0, bottom: 200, right: 320 };
  const miniDot = {
    name: '圆点',
    latin: 'Dot',
    bounds: miniBounds,
    blendKey: 'norm',
    rgba: paintLayer(miniBounds, (x, y) => [255, 210, 90, Math.max(0, Math.min(1, (60 - Math.hypot(x - 160, y - 100)) / 4)) * 255]),
  };
  const miniBg = {
    name: '背景',
    latin: 'Background',
    bounds: miniBounds,
    blendKey: 'norm',
    rgba: paintLayer(miniBounds, (x, y) => [...mix([20, 24, 40], [70, 60, 120], y / 200), 255]),
  };
  manifest.push(
    emitVariant({ fileName: 'sample-mini', scene: { ordered: [miniDot, miniBg], bottomUp: [miniBg, miniDot] }, colorMode: 3, compression: 0 }),
  );

  /* ---------- 竖版画布（手机 UI 稿的常见形态）----------
   * 用途：验证「预览图必须按原始画布比例生成」。1080×2340 的比例是 0.4615，
   * 与 9:16（0.5625）明显不同，任何「写死比例」的实现都会在这里露馅。 */
  manifest.push(
    emitVariant({ fileName: 'sample-portrait', scene: buildShowcaseScene(1080, 2340), colorMode: 3, compression: 1 }),
  );

  /* ---------- 色卡场景：覆盖各色彩模式 ---------- */
  const chart = buildColorChartScene(640, 480);
  manifest.push(
    emitVariant({ fileName: 'sample-cmyk-raw', scene: chart, colorMode: 4, compression: 0 }),
    emitVariant({ fileName: 'sample-cmyk-rle', scene: chart, colorMode: 4, compression: 1 }),
    emitVariant({ fileName: 'sample-cmyk-16', scene: chart, colorMode: 4, bitsPerChannel: 16, compression: 1 }),
    emitVariant({ fileName: 'sample-cmyk-flat', scene: chart, colorMode: 4, compression: 1, withLayers: false }),
    emitVariant({ fileName: 'sample-lab', scene: chart, colorMode: 9, compression: 1 }),
    emitVariant({ fileName: 'sample-multichannel', scene: chart, colorMode: 7, compression: 1 }),
    emitVariant({ fileName: 'sample-duotone', scene: chart, colorMode: 8, compression: 1 }),
    emitVariant({ fileName: 'sample-gray', scene: chart, colorMode: 1, compression: 1 }),
    emitVariant({ fileName: 'sample-indexed', scene: chart, colorMode: 2, compression: 1, withLayers: false }),
    emitVariant({ fileName: 'sample-rgb16', scene: chart, colorMode: 3, bitsPerChannel: 16, compression: 1 }),
  );

  writeFileSync(
    join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), generator: 'tools/make-sample-psd.mjs', fixtures: manifest }, null, 2),
    'utf8',
  );

  writeFileSync(
    join(OUT_DIR, 'README.md'),
    [
      '# 测试素材（自动生成，请勿手改）',
      '',
      '由 `node tools/make-sample-psd.mjs` 生成。每个 `.psd` 都配：',
      '',
      '- `<名>.png` —— 该文件**按规范解码后应得的画面**（人眼可看，用于交叉验证工具）',
      '- `<名>.rgba` —— 同一画面的**裸 RGBA 字节**（宽×高×4，行优先），解码器测试用它零依赖逐像素比对',
      '',
      '| 文件 | 色彩模式 | 位深 | 压缩 | 图层记录 | 尺寸 | 参考图 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...manifest.map(
        (f) =>
          `| \`${f.file}\` | ${f.colorModeName}(${f.colorMode}) | ${f.bitsPerChannel} | ${f.compression} | ${f.layerRecords} | ${f.width}×${f.height} | \`${f.reference}\` |`,
      ),
      '',
      '> `sample-duotone.psd` 的 color mode data 段为空（本生成器不实现双色调曲线），',
      '> 解码端按灰度近似；这是**结构近似**素材，不代表 Photoshop 的完整导出。',
      '',
      '## 校验',
      '',
      '```bash',
      'npm --prefix tools run verify      # 文件头结构 + 用 ag-psd 交叉比对（能力范围内）',
      'python tools/pillow-crosscheck.py  # 用 Pillow 独立交叉验证（需 pip install Pillow）',
      '```',
      '',
      '这两个工具抓出过两处真实缺陷，细节见 `docs/ARCHITECTURE.md`：',
      '',
      '1. CMYK 通道存的是**反相墨量**（255 = 无墨），换算 `R = S_C × S_K / 255`；',
      '2. Indexed 调色板是**平面**存放（256R + 256G + 256B），不是 RGB 交错。',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`[fixture] 已生成 ${manifest.length} 组素材 → ${resolve(OUT_DIR)}`);
  for (const f of manifest) {
    console.log(
      `  ${f.file.padEnd(26)} ${f.colorModeName.padEnd(12)} ${String(f.bitsPerChannel).padStart(2)}bit ` +
        `${f.compression.padEnd(3)} ${String(f.layerRecords).padStart(2)}层 ${String(f.width).padStart(4)}×${String(f.height).padEnd(4)} ${(f.bytes / 1024).toFixed(0)} KB`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
