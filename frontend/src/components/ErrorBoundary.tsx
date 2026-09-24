import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 全局错误边界：捕获渲染期异常，避免整页白屏。
 * 注意：React 的错误边界不捕获事件处理器与异步错误，那些由各页面的 try/catch + Toast 处理。
 */
interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义兜底 UI；不传则用内置 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** 出错时的副作用（例如上报） */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('页面渲染异常：', error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary__card">
          <h1 className="error-boundary__title">页面出错了</h1>
          <p className="error-boundary__text">
            渲染过程中发生异常，你可以重试，或返回列表页继续浏览。
          </p>
          <pre className="error-boundary__detail">{error.message}</pre>
          <div className="error-boundary__actions">
            <button type="button" className="btn btn--primary" onClick={this.reset}>
              重试
            </button>
            <a className="btn btn--secondary" href="/">
              返回列表
            </a>
          </div>
        </div>
      </div>
    );
  }
}
