import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { fetchPsdBytes } from '@/api/projects';
import { LARGE_PSD_BYTES, url } from '@/config';
import { PsdLoadError, loadPsd, type LoadedPsd } from '@/psd/loadPsd';
import { collectLayerIds, createVisibilityMap } from '@/psd/layerTree';
import { canUseComposite, renderLayers } from '@/psd/render';
import { formatBytes } from '@/upload/fieldRules';

import { LayerPanel } from './LayerPanel';
import { PsdInfoPanel } from './PsdInfoPanel';
import { Spinner } from './Spinner';

/** 缩放范围 */
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

type Phase = 'confirm-large' | 'loading' | 'parsing' | 'ready' | 'error';

export interface PsdViewerProps {
  /** 契约 §1.1 的 psd.streamUrl（相对路径，浏览器内解析用，不计下载数） */
  streamUrl: string;
  /** PSD 字节数，用于大文件保护提示 */
  fileSize: number;
  fileName: string;
  /** 解析失败时通知父级回退到 PNG 预览 */
  onFallback?: (reason: string) => void;
}

/**
 * 可交互 PSD 查看器。
 *
 * 生命周期：confirm-large（大文件确认）→ loading（下载字节）→ parsing（解析）→ ready
 * 失败进入 error 并通知父级回退到 PNG 预览，绝不白屏。
 *
 * 内存策略：解析完成后立即释放原始 ArrayBuffer 引用；切换工程时由父级用 key 强制重建本组件，
 * 从而丢弃旧的 canvas。
 */
export function PsdViewer({ streamUrl, fileSize, fileName, onFallback }: PsdViewerProps) {
  const isLargeFile = fileSize > LARGE_PSD_BYTES;

  const [phase, setPhase] = useState<Phase>(isLargeFile ? 'confirm-large' : 'loading');
  const [loaded, setLoaded] = useState<LoadedPsd | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [showCheckerboard, setShowCheckerboard] = useState(true);

  /** 用户是否手动调整过图层显隐（调整过就必须逐层渲染，不能走合成图快速路径） */
  const [touchedLayers, setTouchedLayers] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  /** fit 模式下窗口尺寸变化需要重新计算缩放 */
  const [fitMode, setFitMode] = useState(true);

  const viewportRef = useRef<HTMLDivElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  /** 记录组件是否已卸载，避免异步回调里 setState */
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  /** 用 ref 持有回调，保证 parse 的引用稳定，避免 useEffect 反复触发 */
  const onFallbackRef = useRef(onFallback);
  useEffect(() => {
    onFallbackRef.current = onFallback;
  }, [onFallback]);

  const streamUrlRef = useRef(streamUrl);
  useEffect(() => {
    streamUrlRef.current = streamUrl;
  }, [streamUrl]);

  /* ------------------------------ 加载与解析 ------------------------------ */

  const parse = useCallback(async () => {
    setPhase('loading');
    setErrorMessage(null);
    setWarning(null);

    const controller = new AbortController();

    try {
      const buffer = await fetchPsdBytes(streamUrlRef.current, controller.signal);
      if (disposedRef.current) return;

      setPhase('parsing');
      // 让出一帧，确保骨架屏能先绘制出来（readPsd 是同步的，会占用主线程）
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (disposedRef.current) return;

      const result = loadPsd(buffer);
      if (disposedRef.current) return;

      setLoaded(result);
      setVisibility(createVisibilityMap(result.tree));
      setTouchedLayers(false);
      setPhase('ready');

      if (result.warnings.length > 0) {
        setWarning(`PSD 中有 ${result.warnings.length} 处内容未被完全支持，已按可用信息渲染。`);
      }

      // buffer 到此不再需要，交给 GC；result 只保留 canvas 与图层树
    } catch (error) {
      if (disposedRef.current) return;

      // 用户主动取消（组件卸载）不提示
      if (error instanceof DOMException && error.name === 'AbortError') return;

      const message =
        error instanceof PsdLoadError
          ? error.message
          : error instanceof Error
            ? `无法加载 PSD：${error.message}`
            : '无法加载 PSD：未知错误';

      setErrorMessage(message);
      setPhase('error');
      onFallbackRef.current?.(message);
    }
  }, []);

  // 进入 loading 相位（首次挂载或用户确认大文件后）自动开始解析
  useEffect(() => {
    if (phase !== 'loading') return;
    void parse();
  }, [phase, parse]);

  /* ------------------------------ 视口尺寸观测 ------------------------------ */

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;

    const update = () => {
      setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    };
    update();

    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [phase]);

  /* ------------------------------ 合成与绘制 ------------------------------ */

  /** 计算适应窗口的缩放比 */
  const fitZoom = useMemo(() => {
    if (!loaded || viewportSize.width === 0 || viewportSize.height === 0) return 1;
    const padding = 32;
    const scaleX = (viewportSize.width - padding) / loaded.width;
    const scaleY = (viewportSize.height - padding) / loaded.height;
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY)));
  }, [loaded, viewportSize]);

  // fit 模式跟随窗口变化
  useEffect(() => {
    if (fitMode) setZoom(fitZoom);
  }, [fitMode, fitZoom]);

  // 合成图层树并绘制到可见 canvas
  useEffect(() => {
    if (!loaded || phase !== 'ready') return;

    const display = displayCanvasRef.current;
    if (!display) return;

    const composed = renderLayers(loaded.tree, {
      width: loaded.width,
      height: loaded.height,
      visibility,
      compositeCanvas: loaded.compositeCanvas,
      forceLayerRender: touchedLayers || !canUseComposite(loaded.tree, visibility, loaded.compositeCanvas, false),
    });

    display.width = loaded.width;
    display.height = loaded.height;
    const ctx = display.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, display.width, display.height);
      ctx.drawImage(composed, 0, 0);
    }
  }, [loaded, visibility, touchedLayers, phase]);

  /* ------------------------------ 交互 ------------------------------ */

  const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

  const zoomBy = useCallback(
    (factor: number) => {
      setFitMode(false);
      setZoom((current) => clampZoom(current * factor));
    },
    [],
  );

  const handleFit = useCallback(() => {
    setFitMode(true);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleActualSize = useCallback(() => {
    setFitMode(false);
    setZoom(1);
  }, []);

  const handleReset = useCallback(() => {
    setFitMode(true);
    setPan({ x: 0, y: 0 });
    if (loaded) setVisibility(createVisibilityMap(loaded.tree));
    setTouchedLayers(false);
    setSelectedLayerId(null);
  }, [loaded]);

  // 滚轮缩放（必须以非 passive 监听才能 preventDefault）
  useEffect(() => {
    const element = viewportRef.current;
    if (!element || phase !== 'ready') return undefined;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setFitMode(false);
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setZoom((current) => clampZoom(current * factor));
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [phase]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (phase !== 'ready') return;
    // 只响应左键/中键
    if (event.button !== 0 && event.button !== 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    draggingRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = draggingRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan({
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = draggingRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    draggingRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (phase !== 'ready') return;
    const step = event.shiftKey ? 80 : 24;

    switch (event.key) {
      case 'ArrowLeft':
        setPan((p) => ({ ...p, x: p.x + step }));
        break;
      case 'ArrowRight':
        setPan((p) => ({ ...p, x: p.x - step }));
        break;
      case 'ArrowUp':
        setPan((p) => ({ ...p, y: p.y + step }));
        break;
      case 'ArrowDown':
        setPan((p) => ({ ...p, y: p.y - step }));
        break;
      case '+':
      case '=':
        zoomBy(ZOOM_STEP);
        break;
      case '-':
        zoomBy(1 / ZOOM_STEP);
        break;
      case '0':
        handleFit();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  /* ------------------------------ 图层操作 ------------------------------ */

  const toggleLayer = useCallback((id: string, next: boolean) => {
    setVisibility((prev) => ({ ...prev, [id]: next }));
    setTouchedLayers(true);
  }, []);

  const allLayerIds = useMemo(() => (loaded ? collectLayerIds(loaded.tree) : []), [loaded]);

  const allVisible = useMemo(() => {
    if (!loaded) return true;
    return allLayerIds.every((id) => visibility[id] ?? true);
  }, [loaded, allLayerIds, visibility]);

  const toggleAllLayers = useCallback(
    (next: boolean) => {
      setVisibility((prev) => {
        const draft = { ...prev };
        for (const id of allLayerIds) draft[id] = next;
        return draft;
      });
      setTouchedLayers(true);
    },
    [allLayerIds],
  );

  /* ------------------------------ 各相位渲染 ------------------------------ */

  if (phase === 'confirm-large') {
    return (
      <div className="psd-viewer__gate">
        <div className="psd-viewer__gate-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" focusable="false">
            <path
              d="M24 8v18m0-18-7 7m7-7 7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M12 30v6a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
        </div>
        <h3 className="psd-viewer__gate-title">文件较大，解析可能耗时</h3>
        <p className="psd-viewer__gate-text">
          《{fileName}》体积为 {formatBytes(fileSize)}，浏览器解析需要占用较多内存与时间，
          期间页面可能短暂无响应。你可以继续解析，或直接查看 PNG 预览。
        </p>
        <div className="psd-viewer__gate-actions">
          <button type="button" className="btn btn--primary" onClick={() => setPhase('loading')}>
            继续解析
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => onFallback?.('用户选择直接查看 PNG 预览')}
          >
            查看 PNG 预览
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'loading' || phase === 'parsing') {
    return (
      <div className="psd-viewer__skeleton" aria-busy="true">
        <div className="psd-viewer__skeleton-canvas" aria-hidden="true" />
        <div className="psd-viewer__skeleton-status">
          <Spinner size="sm" label={phase === 'loading' ? '正在下载 PSD' : '正在解析 PSD'} />
          <span>{phase === 'loading' ? '正在下载 PSD 文件…' : '正在解析 PSD 图层…'}</span>
          <span className="psd-viewer__skeleton-hint">{formatBytes(fileSize)}</span>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="psd-viewer__error" role="alert">
        <div className="psd-viewer__error-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" focusable="false">
            <circle cx="24" cy="24" r="17" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <path d="M24 15v12" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
            <circle cx="24" cy="33" r="2" fill="currentColor" />
          </svg>
        </div>
        <h3 className="psd-viewer__error-title">无法在浏览器中预览该 PSD</h3>
        <p className="psd-viewer__error-text">{errorMessage}</p>
        <p className="psd-viewer__error-hint">
          常见原因：文件使用了 CMYK / 16 位以上色彩模式，或文件已损坏。你仍可直接查看 PNG 预览或下载原始 PSD。
        </p>
        <div className="psd-viewer__error-actions">
          <button type="button" className="btn btn--primary" onClick={() => setPhase('loading')}>
            重新解析
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => onFallback?.(errorMessage ?? '解析失败')}
          >
            返回 PNG 预览
          </button>
        </div>
      </div>
    );
  }

  /* phase === 'ready' */
  return (
    <div className="psd-viewer">
      <div className="psd-viewer__toolbar" role="toolbar" aria-label="PSD 查看器工具栏">
        <div className="psd-viewer__toolbar-group">
          <button type="button" className="btn btn--ghost btn--sm" onClick={handleFit} title="适应窗口（快捷键 0）">
            适应窗口
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={handleActualSize} title="按 100% 显示">
            100%
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--icon"
            onClick={() => zoomBy(ZOOM_STEP)}
            aria-label="放大"
            title="放大（快捷键 +）"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M8 3.4a.9.9 0 0 1 .9.9v2.8h2.8a.9.9 0 0 1 0 1.8H8.9v2.8a.9.9 0 0 1-1.8 0V8.9H4.3a.9.9 0 0 1 0-1.8h2.8V4.3a.9.9 0 0 1 .9-.9Z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--icon"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            aria-label="缩小"
            title="缩小（快捷键 -）"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M3.4 7.1h9.2a.9.9 0 0 1 0 1.8H3.4a.9.9 0 0 1 0-1.8Z" fill="currentColor" />
            </svg>
          </button>
          <span className="psd-viewer__zoom" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={handleReset} title="重置视图与图层">
            重置
          </button>
        </div>

        <div className="psd-viewer__toolbar-group">
          <label className="psd-viewer__switch">
            <input
              type="checkbox"
              checked={showCheckerboard}
              onChange={(event) => setShowCheckerboard(event.target.checked)}
            />
            <span>棋盘格背景</span>
          </label>

          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => toggleAllLayers(!allVisible)}
          >
            {allVisible ? '全部图层关' : '全部图层开'}
          </button>
        </div>
      </div>

      {warning ? <p className="psd-viewer__warning">{warning}</p> : null}

      <div className="psd-viewer__body">
        <div
          ref={viewportRef}
          className={`psd-viewer__viewport${showCheckerboard ? ' checkerboard' : ''}${
            dragging ? ' is-dragging' : ''
          }`}
          tabIndex={0}
          role="application"
          aria-label="PSD 预览画布，可拖拽平移，滚轮或加减号缩放"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={handleKeyDown}
        >
          <canvas
            ref={displayCanvasRef}
            className="psd-viewer__canvas"
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              transformOrigin: 'center center',
              imageRendering: zoom >= 2 ? 'pixelated' : 'auto',
            }}
            aria-label={`${fileName} 的图层合成预览`}
            role="img"
          />
        </div>

        <aside className="psd-viewer__aside">
          <PsdInfoPanel
            meta={loaded?.meta ?? {
              width: loaded?.width ?? 0,
              height: loaded?.height ?? 0,
              colorMode: loaded?.colorMode ?? '未知',
              bitsPerChannel: loaded?.bitsPerChannel ?? 8,
              layerCount: loaded?.layerCount ?? 0,
              parseMs: loaded?.parseMs ?? 0,
            }}
            fileSize={fileSize}
            fileName={fileName}
          />

          <LayerPanel
            tree={loaded?.tree ?? []}
            visibility={visibility}
            onToggle={toggleLayer}
            selectedId={selectedLayerId}
            onSelect={setSelectedLayerId}
            onToggleAll={toggleAllLayers}
            allVisible={allVisible}
          />

          <p className="psd-viewer__source">
            由浏览器本地解析，不计入下载次数。原始文件：
            <a className="link" href={url(streamUrl)} target="_blank" rel="noreferrer">
              查看/下载
            </a>
          </p>
        </aside>
      </div>
    </div>
  );
}
