import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { ApiError } from '@/api/client';
import { SORT_OPTIONS, getTags, listProjects, normalizeSort } from '@/api/projects';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Pagination } from '@/components/Pagination';
import { ProjectCard } from '@/components/ProjectCard';
import { Skeleton, Spinner } from '@/components/Spinner';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { PROVIDER_FILTER_OPTIONS, normalizeProviderFilter, providerStyle } from '@/netdisk/providers';
import type { Paginated, Project, TagCount } from '@/types';

/** 每页数量（契约 §3.3 pageSize 上限 48） */
const PAGE_SIZE = 12;

/**
 * 列表页：搜索（防抖）+ 标签筛选 + 排序 + 分页，全部状态同步到 URL query，
 * 因此刷新与浏览器前进/后退都能还原视图。
 */
export function GalleryPage() {
  useDocumentTitle();

  const [searchParams, setSearchParams] = useSearchParams();

  // URL 是唯一真相来源
  const query = searchParams.get('q') ?? '';
  const activeTag = searchParams.get('tag') ?? '';
  const activeProvider = normalizeProviderFilter(searchParams.get('provider'));
  const sort = normalizeSort(searchParams.get('sort'));
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);

  // 搜索框的本地回显 + 防抖后写回 URL
  const [searchInput, setSearchInput] = useState(query);
  const debouncedSearch = useDebouncedValue(searchInput, 350);
  const lastPushedRef = useRef(query);

  const [data, setData] = useState<Paginated<Project> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  /** 重试计数：仅用于强制重新拉取列表 */
  const [retryNonce, setRetryNonce] = useState(0);

  /** 更新 query（值为 null/'' 表示删除该键） */
  const updateParams = useCallback(
    (patch: Record<string, string | number | null>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === '') next.delete(key);
            else next.set(key, String(value));
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // 浏览器前进/后退时把 URL 的 q 同步回输入框
  useEffect(() => {
    if (query !== lastPushedRef.current) {
      lastPushedRef.current = query;
      setSearchInput(query);
    }
  }, [query]);

  // 防抖后的输入写回 URL（并重置页码）
  useEffect(() => {
    if (debouncedSearch === query) return;
    lastPushedRef.current = debouncedSearch;
    updateParams({ q: debouncedSearch || null, page: null });
  }, [debouncedSearch, query, updateParams]);

  // 拉取标签聚合（失败不阻塞列表）
  useEffect(() => {
    const controller = new AbortController();
    getTags(controller.signal)
      .then((result) => setTags(result))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.warn('标签加载失败：', err);
      });
    return () => controller.abort();
  }, []);

  // 拉取列表
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    listProjects(
      {
        q: query || undefined,
        tag: activeTag || undefined,
        provider: activeProvider ?? undefined,
        sort,
        page,
        pageSize: PAGE_SIZE,
      },
      controller.signal,
    )
      .then((result) => {
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err);
        setLoading(false);
      });

    return () => controller.abort();
  }, [query, activeTag, activeProvider, sort, page, retryNonce]);

  const hasFilter = query !== '' || activeTag !== '' || activeProvider !== null;
  const total = data?.total ?? 0;

  /** 顶部筛选条摘要有无内容 */
  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (query) parts.push(`关键词「${query}」`);
    if (activeTag) parts.push(`标签「${activeTag}」`);
    if (activeProvider) parts.push(`网盘「${providerStyle(activeProvider).label}」`);
    if (parts.length === 0) return null;
    return parts.join(' · ');
  }, [query, activeTag, activeProvider]);

  return (
    <div className="page gallery-page">
      <header className="page__head">
        <div className="page__head-text">
          <h1 className="page__title">全部工程</h1>
          <p className="page__subtitle">
            {loading ? '正在加载…' : hasFilter ? `筛选出 ${total} 个工程` : `共 ${total} 个工程`}
          </p>
        </div>

        <Link to="/upload" className="btn btn--primary">
          上传我的作品
        </Link>
      </header>

      <section className="gallery-toolbar" aria-label="筛选与排序">
        <div className="gallery-toolbar__search">
          <label className="visually-hidden" htmlFor="gallery-search">
            搜索工程
          </label>
          <span className="gallery-toolbar__search-icon" aria-hidden="true">
            <svg viewBox="0 0 18 18" focusable="false">
              <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.9" />
              <path d="M12 12l3.4 3.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
          </span>
          <input
            id="gallery-search"
            className="input gallery-toolbar__input"
            type="search"
            value={searchInput}
            placeholder="搜索标题、说明、作者、标签或文件名"
            onChange={(event) => setSearchInput(event.target.value)}
          />
          {searchInput ? (
            <button
              type="button"
              className="gallery-toolbar__clear"
              aria-label="清空搜索"
              onClick={() => setSearchInput('')}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M4.2 4.2a.75.75 0 0 1 1.06 0L8 6.94l2.74-2.74a.75.75 0 1 1 1.06 1.06L9.06 8l2.74 2.74a.75.75 0 1 1-1.06 1.06L8 9.06l-2.74 2.74a.75.75 0 0 1-1.06-1.06L6.94 8 4.2 5.26a.75.75 0 0 1 0-1.06Z"
                  fill="currentColor"
                />
              </svg>
            </button>
          ) : null}
        </div>

        <div className="gallery-toolbar__filters">
          <div className="gallery-toolbar__sort">
            <label className="visually-hidden" htmlFor="gallery-provider">
              网盘来源
            </label>
            <select
              id="gallery-provider"
              className="select"
              value={activeProvider ?? ''}
              onChange={(event) =>
                updateParams({ provider: event.target.value || null, page: null })
              }
            >
              <option value="">全部网盘</option>
              {PROVIDER_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="gallery-toolbar__sort">
            <label className="visually-hidden" htmlFor="gallery-sort">
              排序方式
            </label>
            <select
              id="gallery-sort"
              className="select"
              value={sort}
              onChange={(event) => updateParams({ sort: event.target.value, page: null })}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {tags.length > 0 ? (
        <section className="gallery-tags" aria-label="标签筛选">
          <button
            type="button"
            className={`tag tag--interactive${activeTag === '' ? ' is-active' : ''}`}
            onClick={() => updateParams({ tag: null, page: null })}
            aria-pressed={activeTag === ''}
          >
            全部
          </button>
          {tags.slice(0, 20).map((item) => (
            <button
              key={item.name}
              type="button"
              className={`tag tag--interactive${activeTag === item.name ? ' is-active' : ''}`}
              onClick={() =>
                updateParams({ tag: activeTag === item.name ? null : item.name, page: null })
              }
              aria-pressed={activeTag === item.name}
            >
              {item.name}
              <span className="tag__count">{item.count}</span>
            </button>
          ))}
        </section>
      ) : null}

      {filterSummary ? (
        <p className="gallery-summary">
          当前筛选：{filterSummary}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setSearchInput('');
              updateParams({ q: null, tag: null, provider: null, page: null });
            }}
          >
            清除筛选
          </button>
        </p>
      ) : null}

      {/* 三态：loading / error / empty / list */}
      {loading && !data ? (
        <div className="project-grid" aria-busy="true">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="project-card project-card--skeleton">
              <Skeleton height="200px" radius="lg" />
              <div className="project-card__body">
                <Skeleton height="20px" width="70%" />
                <Skeleton height="14px" width="100%" />
                <Skeleton height="14px" width="45%" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <ErrorState
          error={error}
          title={error instanceof ApiError && error.code === 'NETWORK_ERROR' ? '无法连接后端' : '列表加载失败'}
          retrying={loading}
          onRetry={() => setRetryNonce((value) => value + 1)}
        />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          title={hasFilter ? '没有匹配的工程' : '还没有任何工程'}
          description={
            hasFilter
              ? '换个关键词或清除筛选条件再试试。'
              : '成为第一个上传作品的人吧。'
          }
          action={
            hasFilter ? (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => {
                  setSearchInput('');
                  updateParams({ q: null, tag: null, provider: null, page: null });
                }}
              >
                清除筛选
              </button>
            ) : (
              <Link to="/upload" className="btn btn--primary">
                上传我的作品
              </Link>
            )
          }
        />
      ) : (
        <>
          {loading ? (
            <p className="gallery-loading">
              <Spinner size="sm" label="正在刷新列表" />
              正在刷新…
            </p>
          ) : null}

          <div className={`project-grid${loading ? ' is-refreshing' : ''}`}>
            {data?.items.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>

          <Pagination
            page={data?.page ?? page}
            totalPages={data?.totalPages ?? 1}
            disabled={loading}
            onChange={(next) => {
              updateParams({ page: next > 1 ? next : null });
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        </>
      )}
    </div>
  );
}
