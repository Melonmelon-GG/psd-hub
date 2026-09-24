/**
 * 分页控件：上一页 / 页码 / 下一页，页码多时用省略号折叠。
 * 状态由 URL query 驱动（见 GalleryPage），本组件只负责渲染与回调。
 */
export function Pagination({
  page,
  totalPages,
  onChange,
  disabled = false,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  disabled?: boolean;
}) {
  if (totalPages <= 1) return null;

  const safePage = Math.min(Math.max(1, page), totalPages);
  const items = buildPageItems(safePage, totalPages);

  return (
    <nav className="pagination" aria-label="分页导航">
      <button
        type="button"
        className="pagination__step"
        onClick={() => onChange(safePage - 1)}
        disabled={disabled || safePage <= 1}
        aria-label="上一页"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M10.3 3.3a1 1 0 0 1 0 1.4L6.9 8l3.4 3.3a1 1 0 0 1-1.4 1.4l-4-4a1 1 0 0 1 0-1.4l4-4a1 1 0 0 1 1.4 0Z" fill="currentColor" />
        </svg>
        <span className="pagination__step-text">上一页</span>
      </button>

      <ul className="pagination__list">
        {items.map((item, index) =>
          item === 'gap' ? (
            <li key={`gap-${index}`} className="pagination__gap" aria-hidden="true">
              …
            </li>
          ) : (
            <li key={item}>
              <button
                type="button"
                className={`pagination__page${item === safePage ? ' is-current' : ''}`}
                onClick={() => onChange(item)}
                disabled={disabled}
                aria-label={`第 ${item} 页`}
                aria-current={item === safePage ? 'page' : undefined}
              >
                {item}
              </button>
            </li>
          ),
        )}
      </ul>

      <button
        type="button"
        className="pagination__step"
        onClick={() => onChange(safePage + 1)}
        disabled={disabled || safePage >= totalPages}
        aria-label="下一页"
      >
        <span className="pagination__step-text">下一页</span>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M5.7 3.3a1 1 0 0 0 0 1.4L9.1 8l-3.4 3.3a1 1 0 1 0 1.4 1.4l4-4a1 1 0 0 0 0-1.4l-4-4a1 1 0 0 0-1.4 0Z" fill="currentColor" />
        </svg>
      </button>
    </nav>
  );
}

/** 生成页码序列：1 … 4 5 6 … 20，'gap' 表示省略号 */
export function buildPageItems(page: number, totalPages: number): Array<number | 'gap'> {
  const windowSize = 1; // 当前页两侧各展示几个
  const pages = new Set<number>([1, totalPages]);
  for (let i = page - windowSize; i <= page + windowSize; i += 1) {
    if (i >= 1 && i <= totalPages) pages.add(i);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  let previous = 0;
  for (const value of sorted) {
    if (previous && value - previous > 1) out.push('gap');
    out.push(value);
    previous = value;
  }
  return out;
}
