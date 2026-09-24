/** 加载指示器；size 控制尺寸，label 供屏幕阅读器播报 */
export function Spinner({
  size = 'md',
  label = '加载中',
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  className?: string;
}) {
  return (
    <span className={`spinner spinner--${size}${className ? ` ${className}` : ''}`} role="status">
      <span className="spinner__ring" aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

/** 骨架块：用于列表/大图的占位 */
export function Skeleton({
  width,
  height,
  radius = 'md',
  className,
}: {
  width?: string;
  height?: string;
  radius?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <span
      className={`skeleton skeleton--${radius}${className ? ` ${className}` : ''}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
