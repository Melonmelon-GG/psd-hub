import { blendModeLabel } from '@/psd/blendModes';
import type { LayerNode } from '@/psd/layerTree';
import { formatOpacityPercent } from '@/utils/format';

/**
 * 图层树面板：递归缩进展示，复选框切换显隐，显示不透明度与混合模式，
 * 点击图层名可高亮选中（与画布联动时可后续扩展定位框）。
 */
export function LayerPanel({
  tree,
  visibility,
  onToggle,
  selectedId,
  onSelect,
  onToggleAll,
  allVisible,
}: {
  tree: readonly LayerNode[];
  visibility: Readonly<Record<string, boolean>>;
  onToggle: (id: string, next: boolean) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggleAll: (next: boolean) => void;
  allVisible: boolean;
}) {
  return (
    <div className="layer-panel">
      <div className="layer-panel__head">
        <h3 className="layer-panel__title">
          图层
          <span className="layer-panel__count">{countNodes(tree)}</span>
        </h3>

        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => onToggleAll(!allVisible)}
        >
          {allVisible ? '全部隐藏' : '全部显示'}
        </button>
      </div>

      {tree.length === 0 ? (
        <p className="layer-panel__empty">该 PSD 没有可展示的图层。</p>
      ) : (
        <ul className="layer-panel__list" role="tree" aria-label="图层列表">
          {tree.map((node) => (
            <LayerTreeItem
              key={node.id}
              node={node}
              depth={0}
              visibility={visibility}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** 递归渲染单个图层（组会继续渲染子层） */
function LayerTreeItem({
  node,
  depth,
  visibility,
  onToggle,
  selectedId,
  onSelect,
}: {
  node: LayerNode;
  depth: number;
  visibility: Readonly<Record<string, boolean>>;
  onToggle: (id: string, next: boolean) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const checked = visibility[node.id] ?? !node.hidden;
  const isGroup = node.children.length > 0;
  const isSelected = selectedId === node.id;

  // 祖先被隐藏时，本层即使勾选也不会出现在画面上，用淡化提示
  const ancestorHidden = isAncestorHidden(node.id, visibility);

  return (
    <li className="layer-panel__item" role="treeitem" aria-expanded={isGroup ? true : undefined}>
      <div
        className={`layer-row${isSelected ? ' is-selected' : ''}${
          ancestorHidden ? ' is-dimmed' : ''
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <input
          id={`layer-toggle-${node.id}`}
          className="layer-row__checkbox"
          type="checkbox"
          checked={checked}
          disabled={ancestorHidden}
          onChange={(event) => onToggle(node.id, event.target.checked)}
        />

        <label
          className="layer-row__label"
          htmlFor={`layer-toggle-${node.id}`}
          title={`${node.name}（点击名称可选中）`}
        >
          <span className="layer-row__icon" aria-hidden="true">
            {isGroup ? (
              <svg viewBox="0 0 16 16" focusable="false">
                <path
                  d="M1.8 4.4c0-.9.7-1.6 1.6-1.6h2.5l1.3 1.6h5.4c.9 0 1.6.7 1.6 1.6v5.6c0 .9-.7 1.6-1.6 1.6H3.4c-.9 0-1.6-.7-1.6-1.6V4.4Z"
                  fill="currentColor"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" focusable="false">
                <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            )}
          </span>

          <span className="layer-row__name">{node.name}</span>
        </label>

        <button
          type="button"
          className="layer-row__select"
          aria-label={`选中图层 ${node.name}`}
          aria-pressed={isSelected}
          onClick={() => onSelect(isSelected ? null : node.id)}
        />

        <span className="layer-row__meta">
          {isGroup ? <span className="layer-row__badge">组 · {node.descendantCount}</span> : null}
          {node.clipping ? <span className="layer-row__badge layer-row__badge--clip">裁剪</span> : null}
          <span className="layer-row__opacity">{formatOpacityPercent(node.opacity)}</span>
          <span className="layer-row__blend">{blendModeLabel(node.blendMode)}</span>
        </span>
      </div>

      {isGroup ? (
        <ul className="layer-panel__list layer-panel__list--nested" role="group">
          {node.children.map((child) => (
            <LayerTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              visibility={visibility}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** 判断是否有祖先被隐藏 */
function isAncestorHidden(
  id: string,
  visibility: Readonly<Record<string, boolean>>,
): boolean {
  const segments = id.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    const ancestorId = segments.slice(0, i).join('/');
    if (!(visibility[ancestorId] ?? true)) return true;
  }
  return false;
}

/** 统计节点总数（含组） */
function countNodes(nodes: readonly LayerNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (node.children.length) total += countNodes(node.children);
  }
  return total;
}
