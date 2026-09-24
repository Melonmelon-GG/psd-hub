import { formatBytes } from '@/upload/fieldRules';
import { FIDELITY_LABEL, FIDELITY_TONE, colorModeInfoByName } from '@/psd/colorModes';
import type { PsdMeta } from '@/types';

/**
 * PSD 元信息面板：画布尺寸、色彩模式（含保真度标注）、通道数、位深、图层总数、解析耗时、解码引擎。
 *
 * 注意两种来源的区别：
 * - 本面板的 `meta` 来自**前端本地解析**（ag-psd 主引擎或自研兜底解码器），
 *   其中 bitsPerChannel、channels、图层数是实际解析出来的值。
 * - `Project.psd.*`（契约 §1.1）来自**后端文件头解析**，layerCount 恒为 null。
 *   两者在 UI 上分开展示，不做混合。
 *
 * 「保真度」是这个面板的核心信息：CMYK / Lab 需要色彩空间换算，Duotone / Multichannel
 * 只能近似，用户有权知道预览与 Photoshop 的差距在哪。
 */
export function PsdInfoPanel({
  meta,
  fileSize,
  fileName,
}: {
  meta: PsdMeta;
  fileSize?: number | null;
  fileName?: string | null;
}) {
  // meta.colorMode 是解析结果的文本；尽力反查它的保真度分级
  const info = colorModeInfoByName(meta.colorMode);
  const fidelity = info?.fidelity ?? 'exact';
  const tone = FIDELITY_TONE[fidelity];
  const note = meta.approxReason ?? info?.note;

  return (
    <div className="psd-info">
      <h3 className="psd-info__title">PSD 元信息</h3>

      <dl className="psd-info__list">
        <div className="psd-info__row">
          <dt>画布尺寸</dt>
          <dd>
            {meta.width} × {meta.height} px
          </dd>
        </div>

        <div className="psd-info__row">
          <dt>色彩模式</dt>
          <dd>
            <span className="psd-info__mode">{meta.colorMode}</span>
            <span className={`psd-badge psd-badge--${tone}`} title={note ?? '与 Photoshop 解码结果一致'}>
              {FIDELITY_LABEL[fidelity]}
            </span>
          </dd>
        </div>

        {typeof meta.channels === 'number' ? (
          <div className="psd-info__row">
            <dt>通道数</dt>
            <dd>{meta.channels} 个</dd>
          </div>
        ) : null}

        <div className="psd-info__row">
          <dt>位深</dt>
          <dd>{meta.bitsPerChannel} 位/通道</dd>
        </div>

        <div className="psd-info__row">
          <dt>图层总数</dt>
          <dd>{meta.layerCount} 个</dd>
        </div>

        {meta.engine ? (
          <div className="psd-info__row">
            <dt>解码引擎</dt>
            <dd>{meta.engine === 'ag-psd' ? 'ag-psd' : '内置解码器'}</dd>
          </div>
        ) : null}

        <div className="psd-info__row">
          <dt>解析耗时</dt>
          <dd>{meta.parseMs} ms</dd>
        </div>

        {typeof fileSize === 'number' ? (
          <div className="psd-info__row">
            <dt>文件体积</dt>
            <dd>{formatBytes(fileSize)}</dd>
          </div>
        ) : null}

        {fileName ? (
          <div className="psd-info__row">
            <dt>文件名</dt>
            <dd className="psd-info__filename" title={fileName}>
              {fileName}
            </dd>
          </div>
        ) : null}
      </dl>

      {note ? (
        <p className={`psd-info__note psd-info__note--${tone}`}>
          <strong>{FIDELITY_LABEL[fidelity]}：</strong>
          {note}
        </p>
      ) : null}
    </div>
  );
}
