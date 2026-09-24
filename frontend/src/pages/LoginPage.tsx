import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { describeAuthError } from '@/auth/errors';
import { sanitizeRedirect } from '@/auth/redirect';
import { useAuth } from '@/auth/AuthContext';
import { Spinner } from '@/components/Spinner';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

/**
 * 登录页（契约 §8.1）。
 *
 * 三条要点：
 * 1. 账号是**主站的账号**（柒世纪视频组），本站不建自己的账号体系，页面上要说清楚，
 *    否则用户会以为是新注册一个号；
 * 2. `?redirect=` 回来后必须防开放重定向，只接受站内相对路径（见 auth/redirect.ts）；
 * 3. 401 与 403 文案不同：401 是账号密码错，403 是「账号有效但不是社团成员」。
 */
export function LoginPage() {
  useDocumentTitle('登录');

  const navigate = useNavigate();
  const { status, login } = useAuth();
  const [searchParams] = useSearchParams();

  const [cn, setCn] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * 是否刚刚在**本页**登录成功。
   * 登录成功后 status 会变成 authenticated，下面的「已登录就回首页」effect 会立刻想跳首页；
   * 而这时我们其实要跳到 `?redirect=` 指定的页面。用一个 ref 把这一次的自动跳转屏蔽掉，
   * 避免两个导航互相打架（谁后执行谁生效 → 不确定）。
   */
  const justLoggedInRef = useRef(false);

  /** 登录成功后的落地页（已做站内校验） */
  const redirect = sanitizeRedirect(searchParams.get('redirect'));

  // 已登录用户不该停在登录页：直接回首页（契约要求）
  useEffect(() => {
    if (status === 'authenticated' && !justLoggedInRef.current) navigate('/', { replace: true });
  }, [status, navigate]);

  // 自动聚焦用户名，键盘用户少按一次 Tab
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (submitting) return;

      const trimmedCn = cn.trim();
      if (!trimmedCn || !password) {
        // 契约 §8.1：凭据为空是 400 BAD_REQUEST，本地先拦一次省一趟请求
        setError('请填写用户名和密码。');
        return;
      }

      setSubmitting(true);
      setError('');
      justLoggedInRef.current = true;
      try {
        await login(trimmedCn, password);
        // 密码不留在内存里
        setPassword('');
        navigate(redirect, { replace: true });
      } catch (err) {
        // 登录失败：解除屏蔽，登录态仍会由 Provider 维护
        justLoggedInRef.current = false;
        setError(describeAuthError(err).message);
      } finally {
        setSubmitting(false);
      }
    },
    [cn, password, login, navigate, redirect, submitting],
  );

  // 校验本地令牌期间（启动时）先不渲染表单，避免已登录用户看到一闪而过的登录框
  if (status === 'loading') {
    return (
      <div className="page login-page">
        <div className="card login-card">
          <div className="login-card__loading">
            <Spinner label="正在校验登录状态…" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page login-page">
      <div className="card login-card">
        <h1 className="login-card__title">登录</h1>
        <p className="login-card__lead">
          账号与主站（<strong>柒世纪视频组</strong>）通用：请使用你在主站的用户名与密码登录，
          无需在此另外注册。只有社团成员才能上传作品。
        </p>

        <form className="login-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="login-cn">
              用户名
            </label>
            <input
              id="login-cn"
              ref={inputRef}
              className={`input${error ? ' has-error' : ''}`}
              type="text"
              name="cn"
              value={cn}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={80}
              placeholder="主站用户名"
              onChange={(event) => setCn(event.target.value)}
              disabled={submitting}
              aria-describedby="login-cn-hint"
            />
            <p id="login-cn-hint" className="field__hint">
              即主站登录时使用的用户名。
            </p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="login-password">
              密码
            </label>
            <input
              id="login-password"
              className={`input${error ? ' has-error' : ''}`}
              type="password"
              name="password"
              value={password}
              autoComplete="current-password"
              maxLength={200}
              placeholder="主站密码"
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              aria-describedby="login-password-hint"
            />
            <p id="login-password-hint" className="field__hint">
              密码只用于本次登录换取令牌，本站不保存、不落库、不记日志。
            </p>
          </div>

          {error ? (
            <p className="login-form__error" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="btn btn--primary btn--block btn--lg"
            disabled={submitting}
          >
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>

        <p className="login-card__foot">
          <Link to="/">返回首页</Link>
          <span className="login-card__foot-sep" aria-hidden="true">
            ·
          </span>
          <a href="https://7thcv.cn" rel="noreferrer noopener">
            前往主站 7thcv.cn
          </a>
        </p>
      </div>
    </div>
  );
}
