import { Link } from 'react-router-dom';

import { useDocumentTitle } from '@/hooks/useDocumentTitle';

/** 404 页面 */
export function NotFoundPage() {
  useDocumentTitle('页面不存在');

  return (
    <div className="page not-found">
      <div className="not-found__code" aria-hidden="true">
        404
      </div>
      <h1 className="not-found__title">找不到这个页面</h1>
      <p className="not-found__text">
        你访问的地址不存在，可能链接输入有误，或对应的工程已被删除。
      </p>
      <div className="not-found__actions">
        <Link to="/" className="btn btn--primary">
          返回工程列表
        </Link>
        <Link to="/upload" className="btn btn--secondary">
          上传一个作品
        </Link>
      </div>
    </div>
  );
}
