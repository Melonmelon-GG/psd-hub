/** 页脚：站点说明与契约提示 */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="site-footer__text">
          柒世纪视频组平面工程分享平台 · 上传 PNG 展示图并附上网盘分享链接，与同好分享你的工程。
        </p>
        <p className="site-footer__text site-footer__text--muted">
          展示图由上传方提供；源文件保存在上传方自己的网盘里，本站只登记分享链接并跳转。
        </p>
      </div>
    </footer>
  );
}
