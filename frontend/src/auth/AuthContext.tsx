/**
 * 登录态上下文（契约 §8）。
 *
 * 令牌是**无状态 JWT**，服务端没有 logout 端点，所以：
 * - `logout()` 只清本地存储；
 * - 启动时若本地有令牌，调一次 `GET /api/auth/me` 校验并恢复用户信息，
 *   失败（过期 / 无效 / 非成员）就清空回到 anonymous —— 不做任何本地解码，
 *   因为前端拿不到主站签名密钥，自己解出来的东西不可信。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { fetchMe, login as loginRequest } from '@/api/auth';
import type { AuthUser } from '@/types';

import {
  clearAuthStorage,
  getAuthToken,
  getStoredUser,
  setAuthToken,
  setStoredUser,
} from './storage';
import type { AuthStatus } from './uploadGate';

export type { AuthStatus };

export interface AuthContextValue {
  /** loading：正在校验本地令牌；anonymous：未登录；authenticated：已登录 */
  status: AuthStatus;
  user: AuthUser | null;
  token: string | null;
  /** 登录成功返回用户信息；失败抛 ApiError，由页面翻译成文案（见 auth/errors.ts） */
  login: (cn: string, password: string) => Promise<AuthUser>;
  /** 清空本地登录态（契约无 logout 端点） */
  logout: () => void;
  /** 重新向服务端确认当前用户（/api/auth/me） */
  refresh: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/** 消费登录态：必须在 <AuthProvider> 内使用 */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth 必须在 <AuthProvider> 内部使用');
  }
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // 初始状态直接从 localStorage 推导：有令牌就是 loading（待校验），没有就是 anonymous
  const [token, setToken] = useState<string | null>(() => getAuthToken() || null);
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser());
  const [status, setStatus] = useState<AuthStatus>(() =>
    getAuthToken() ? 'loading' : 'anonymous',
  );

  /** 组件卸载后不再 setState */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** 清空登录态（内存 + 存储） */
  const clear = useCallback(() => {
    clearAuthStorage();
    setToken(null);
    setUser(null);
    setStatus('anonymous');
  }, []);

  /**
   * 启动时恢复登录态。
   * 只在挂载时跑一次：这里不把 `refresh` 放进依赖，避免每次刷新用户都重新校验。
   */
  useEffect(() => {
    const stored = getAuthToken();
    if (!stored) {
      setStatus('anonymous');
      return;
    }

    let cancelled = false;
    setStatus('loading');

    fetchMe()
      .then((me) => {
        if (cancelled || !mounted.current) return;
        // 服务端可能回一个没有 isMember 的对象（后端还在并行开发），一律按「非成员」从严处理
        const nextUser: AuthUser = { cn: me.cn, isMember: me.isMember === true };
        setStoredUser(nextUser);
        setToken(stored);
        setUser(nextUser);
        setStatus('authenticated');
      })
      .catch(() => {
        // 令牌无效/过期/非成员/主站不可达 —— 一律回到未登录，让用户重新登录
        if (cancelled || !mounted.current) return;
        clearAuthStorage();
        setToken(null);
        setUser(null);
        setStatus('anonymous');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (cn: string, password: string): Promise<AuthUser> => {
    // 契约 §8.1：本服务把凭据转发给主站；成功则把令牌原样返回
    const result = await loginRequest(cn, password);
    const nextUser: AuthUser = { cn: result.cn, isMember: result.isMember === true };

    setAuthToken(result.token);
    setStoredUser(nextUser);
    setToken(result.token);
    setUser(nextUser);
    setStatus('authenticated');

    return nextUser;
  }, []);

  const logout = useCallback(() => {
    clear();
  }, [clear]);

  const refresh = useCallback(async (): Promise<void> => {
    const current = getAuthToken();
    if (!current) {
      clear();
      return;
    }

    setStatus('loading');
    try {
      const me = await fetchMe();
      const nextUser: AuthUser = { cn: me.cn, isMember: me.isMember === true };
      setStoredUser(nextUser);
      setToken(current);
      setUser(nextUser);
      setStatus('authenticated');
    } catch (error) {
      clear();
      throw error;
    }
  }, [clear]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, token, login, logout, refresh }),
    [status, user, token, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
