/**
 * 标签展示列表。
 * interactive=true 时渲染成按钮（用于标签筛选），否则为纯展示。
 */
export function TagList({
  tags,
  activeTag,
  onSelect,
  size = 'md',
  emptyText,
}: {
  tags: readonly string[];
  activeTag?: string | null;
  onSelect?: (tag: string) => void;
  size?: 'sm' | 'md';
  emptyText?: string;
}) {
  if (tags.length === 0) {
    return emptyText ? <p className="tag-list__empty">{emptyText}</p> : null;
  }

  return (
    <ul className={`tag-list tag-list--${size}`}>
      {tags.map((tag) => {
        const isActive = activeTag === tag;
        return (
          <li key={tag}>
            {onSelect ? (
              <button
                type="button"
                className={`tag tag--interactive${isActive ? ' is-active' : ''}`}
                onClick={() => onSelect(tag)}
                aria-pressed={isActive}
              >
                {tag}
              </button>
            ) : (
              <span className="tag">{tag}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
