import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { getConfig } from '@/api/projects';
import { useAuth } from '@/auth/AuthContext';
import { describeUploadAuthError } from '@/auth/errors';
import { buildLoginPath } from '@/auth/redirect';
import { resolveUploadAccess, resolveUploadAuthor } from '@/auth/uploadGate';
import { Spinner } from '@/components/Spinner';
import { TagInput } from '@/components/TagInput';
import { UploadDropzone } from '@/components/UploadDropzone';
import { UploadProgress } from '@/components/UploadProgress';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useObjectUrl } from '@/hooks/useObjectUrl';
import { useToast } from '@/hooks/useToast';
import { detectProvider, providerColorStyle, providerStyle } from '@/netdisk/providers';
import {
  ALLOWED_IMAGE_EXTENSIONS,
  DEFAULT_EXTRACT_CODE_MAX,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_NETDISK_URL_MAX,
  SOURCE_FILE_NAME_MAX,
  SOURCE_NOTE_MAX,
  formatBytes,
  hasErrors,
  parseTags,
  validateUploadFormWithHeader,
  type FieldErrors,
} from '@/upload/fieldRules';
import { isAbortError, isDuplicate, isPayloadTooLarge, uploadProject } from '@/upload/uploadProject';
import { previewAspectRatioStyle } from '@/utils/format';
import type { ServerConfig } from '@/types';

/** 自动识别的兜底中文名（链接为空时展示） */
const EMPTY_PROVIDER_LABEL = '未识别';

/**
 * 上传页（v2.0）：**上传 PNG + 填写网盘分享链接**。
 *
 * 与 v1 的关键差异：
 * - 不再解析 PSD：选中 PNG 后直接用 `URL.createObjectURL` 本地预览，
 *   再用 `<img onLoad>` 读出的自然尺寸让预览框按真实比例撑开（无需任何解析）。
 * - 网盘类型由服务端识别（契约 §6）；表单上只做**本地即时提示**，
 *   提交后一律以响应里的 `source.provider` / `source.providerLabel` 为准。
 */
export function UploadPage() {
  useDocumentTitle('上传工程');

  const navigate = useNavigate();
  const toast = useToast();
  const { status: authStatus, user, logout } = useAuth();

  /* ------------------------------ 服务端配置 ------------------------------ */
  const [config, setConfig] = useState<ServerConfig | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getConfig(controller.signal)
      .then(setConfig)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.warn('获取服务端配置失败，使用本地默认下限：', err);
      });
    return () => controller.abort();
  }, []);

  /**
   * 契约 §8.4：`loginEnabled` 是 v2.1 新增字段，后端并行开发中可能**暂时缺失**。
   * 字段缺失（或 /api/config 请求失败）时一律按 `false` 处理 → 退回 v2.0 旧行为：
   * 不强制登录、作者可自由填写。这样后端还没落地时本地开发不会被门禁卡死。
   */
  const loginEnabled = config?.loginEnabled === true;

  /**
   * 上传门禁判定（纯函数，见 auth/uploadGate.ts）：
   * 未登录/非成员 → 整页替换为引导卡片；已登录成员 → author 锁定为登录用户名。
   */
  const access = useMemo(
    () => resolveUploadAccess({ loginEnabled, status: authStatus, user }),
    [loginEnabled, authStatus, user],
  );

  const maxBytes = config?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const maxLabel = config?.maxUploadLabel ?? formatBytes(DEFAULT_MAX_UPLOAD_BYTES);
  const allowedExtensions = config?.acceptedImageExtensions?.length
    ? config.acceptedImageExtensions
    : ALLOWED_IMAGE_EXTENSIONS;
  const netdiskUrlMaxLength = config?.netdiskUrlMaxLength ?? DEFAULT_NETDISK_URL_MAX;
  const extractCodeMaxLength = config?.extractCodeMaxLength ?? DEFAULT_EXTRACT_CODE_MAX;

  /* ------------------------------ 表单状态 ------------------------------ */
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState('');
  const [tags, setTags] = useState<string[]>([]);

  const [netdiskUrl, setNetdiskUrl] = useState('');
  const [extractCode, setExtractCode] = useState('');
  const [sourceFileName, setSourceFileName] = useState('');
  const [sourceNote, setSourceNote] = useState('');

  /**
   * 实际提交/展示的作者名。
   * 登录已启用且为社团成员时，它恒等于登录用户名（输入框只读）；
   * 降级到旧行为时，它就是用户自己填的内容。
   */
  const effectiveAuthor = resolveUploadAuthor(access, author);

  /** PNG 的真实像素尺寸（`<img onLoad>` 读出），用于预览框比例 */
  const [imageNatural, setImageNatural] = useState<{ width: number; height: number } | null>(null);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ loaded: 0, total: 0, ratio: null as number | null });
  const abortRef = useRef<AbortController | null>(null);

  /** 本地即时预览：object URL 由 hook 负责在更换/卸载时 revoke */
  const imageUrl = useObjectUrl(imageFile);

  // 换图后旧的尺寸信息作废，避免新图沿用旧比例
  useEffect(() => {
    setImageNatural(null);
  }, [imageFile]);

  /* ------------------------------ 网盘类型即时提示 ------------------------------ */
  // ⚠️ 只是**本地**识别，用于表单即时反馈；最终结果以服务端 source.provider 为准（契约 §1.3）。
  const localProvider = useMemo(() => detectProvider(netdiskUrl), [netdiskUrl]);
  const localProviderStyle = providerStyle(localProvider);
  const hasNetdiskInput = netdiskUrl.trim().length > 0;

  /* ------------------------------ 校验与提交 ------------------------------ */

  /** 标签已在 TagInput 内完成解析与去重，这里按契约 §3.6 再规整一次 */
  const effectiveTags = useMemo(() => parseTags(tags), [tags]);

  const runValidation = useCallback(async (): Promise<FieldErrors> => {
    return validateUploadFormWithHeader({
      image: imageFile,
      netdiskUrl,
      title,
      description,
      author: effectiveAuthor,
      tags: effectiveTags,
      extractCode,
      sourceFileName,
      sourceNote,
      maxBytes,
      maxLabel,
      allowedExtensions,
      extractCodeMaxLength,
      netdiskUrlMaxLength,
    });
  }, [
    imageFile,
    netdiskUrl,
    title,
    description,
    effectiveAuthor,
    effectiveTags,
    extractCode,
    sourceFileName,
    sourceNote,
    maxBytes,
    maxLabel,
    allowedExtensions,
    extractCodeMaxLength,
    netdiskUrlMaxLength,
  ]);

  // 提交过一次后，后续修改实时校验
  useEffect(() => {
    if (!submitted) return;
    let cancelled = false;
    void runValidation().then((errors) => {
      if (!cancelled) setFieldErrors(errors);
    });
    return () => {
      cancelled = true;
    };
  }, [submitted, runValidation]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);

    const errors = await runValidation();
    setFieldErrors(errors);
    if (hasErrors(errors) || !imageFile) {
      toast.error('请先修正表单中标出的问题');
      return;
    }

    await submit({ allowDuplicate: false });
  };

  const submit = async ({ allowDuplicate }: { allowDuplicate: boolean }) => {
    if (!imageFile) return;

    setUploading(true);
    setProgress({ loaded: 0, total: imageFile.size, ratio: 0 });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const item = await uploadProject(
        {
          image: imageFile,
          netdiskUrl,
          title,
          description,
          // 契约 §8.3：登录态下服务端会用令牌里的 cn 覆盖该字段；
          // 仍然照常放进表单（无害，且自动化旁路 UPLOAD_TOKEN 时以表单值为准）。
          author: effectiveAuthor,
          tags: effectiveTags,
          extractCode,
          sourceFileName,
          sourceNote,
          allowDuplicate,
        },
        {
          signal: controller.signal,
          tokenRequired: config?.uploadTokenRequired ?? true,
          onProgress: (value) => setProgress(value),
        },
      );

      toast.success('上传成功！');
      navigate(`/p/${item.id}`);
    } catch (error) {
      handleUploadError(error);
    } finally {
      setUploading(false);
      abortRef.current = null;
    }
  };

  const handleUploadError = (error: unknown) => {
    if (isAbortError(error)) {
      toast.info('已取消上传');
      return;
    }

    if (isDuplicate(error)) {
      const existingId = error instanceof ApiError ? error.existingId : undefined;
      toast.warning('这张 PNG 已存在（内容完全相同）', {
        duration: 0,
        action: existingId
          ? {
              label: '查看已有工程',
              variant: 'primary',
              onClick: () => navigate(`/p/${existingId}`),
            }
          : {
              // 没有 existingId 时退化为「仍然上传」
              label: '仍然上传',
              variant: 'secondary',
              onClick: () => void submit({ allowDuplicate: true }),
            },
      });

      if (existingId) {
        // 同时提供「仍然上传」入口，需要用户显式确认
        toast.info('如果确认要重复上传，点击下方按钮忽略重复检查', {
          duration: 0,
          action: {
            label: '仍然上传（忽略重复）',
            variant: 'secondary',
            onClick: () => void submit({ allowDuplicate: true }),
          },
        });
      }
      return;
    }

    if (isPayloadTooLarge(error)) {
      toast.error(`图片体积超过服务端上限（${maxLabel}），请压缩后重试。`);
      return;
    }

    if (error instanceof ApiError && error.code === 'UNSUPPORTED_MEDIA_TYPE') {
      toast.error('服务端未接受该文件：请确认上传的是标准 PNG（扩展名 .png、文件头为 PNG 魔数）。');
      return;
    }

    if (error instanceof ApiError && (error.code === 'UNAUTHORIZED' || error.code === 'NOT_A_MEMBER')) {
      // 401/403 的语义区分见 auth/errors.ts：
      // 401 = 未登录/令牌失效（登录启用时提示重新登录，否则是上传令牌问题）；403 = 非社团成员
      const message = describeUploadAuthError(error, loginEnabled);
      if (loginEnabled && error.code === 'UNAUTHORIZED') {
        // 令牌已被服务端拒绝（过期/吊销）：清掉本地登录态，否则页头还显示着用户名
        logout();
        toast.error(message, {
          duration: 0,
          action: {
            label: '去登录',
            variant: 'primary',
            onClick: () => navigate(buildLoginPath('/upload')),
          },
        });
      } else {
        toast.error(message);
      }
      return;
    }

    if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
      const retryAfter = error.details?.retryAfter;
      toast.error(
        retryAfter ? `请求过于频繁，请 ${String(retryAfter)} 秒后重试。` : '请求过于频繁，请稍后重试。',
      );
      return;
    }

    toast.error(error instanceof Error ? error.message : '上传失败，请稍后重试');
  };

  const cancelUpload = () => abortRef.current?.abort();

  /* ------------------------------ 渲染 ------------------------------ */

  // accept 同时给出扩展名与 MIME（部分系统只认其中一种）
  const acceptAttr = [
    ...allowedExtensions,
    ...(config?.acceptedImageTypes?.length ? config.acceptedImageTypes : ['image/png']),
  ].join(',');

  /* --------------------- 契约 §8：登录门禁（未登录/非成员不给填） --------------------- */

  // 登录态尚在校验中：先渲染占位，避免「去登录 → 已登录」的闪烁
  if (access.pending) {
    return (
      <div className="page upload-page">
        <div className="card upload-gate">
          <div className="upload-gate__pending">
            <Spinner label="正在校验登录状态…" />
          </div>
        </div>
      </div>
    );
  }

  if (access.requiresLogin) {
    const notMember = access.gateReason === 'not-member';
    return (
      <div className="page upload-page">
        <div className="card upload-gate">
          <span className="upload-gate__icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" focusable="false">
              <rect
                x="11"
                y="21"
                width="26"
                height="19"
                rx="4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
              />
              <path
                d="M17 21v-4.5a7 7 0 0 1 14 0V21"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <circle cx="24" cy="30" r="2.6" fill="currentColor" />
            </svg>
          </span>

          <h1 className="upload-gate__title">
            {notMember ? '该账号不是社团成员' : '上传作品需要先登录'}
          </h1>

          <p className="upload-gate__text">
            {notMember
              ? '这个账号可以登录，但不是柒世纪视频组的社团成员，因此无法上传作品。请改用社团成员账号登录。'
              : '只有社团成员才能上传作品。本站不单独建账号，请使用主站（柒世纪视频组）的账号登录后再来上传。'}
          </p>

          <Link className="btn btn--primary btn--lg" to={buildLoginPath('/upload')}>
            {notMember ? '换个账号登录' : '去登录'}
          </Link>

          <p className="upload-gate__hint">
            账号与主站（柒世纪视频组）通用；登录后作者名会自动使用你的用户名。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page upload-page">
      <header className="page__head">
        <div className="page__head-text">
          <h1 className="page__title">上传工程</h1>
          <p className="page__subtitle">
            上传一张 PNG 作为展示图，再附上网盘分享链接
            {config ? `；支持 ${allowedExtensions.join(' / ')}，单张最大 ${maxLabel}` : `（最大 ${maxLabel}）`}。
            源文件（PSD 等）请放在你自己的网盘里，这里只做展示与跳转。
          </p>
        </div>
      </header>

      <form className="upload-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <div className="upload-form__main">
          {/* ------------------------- 图片区 ------------------------- */}
          <section className="card">
            <h2 className="card__title">
              1. 选择展示图（PNG）
              <span className="card__required">必填</span>
            </h2>

            <UploadDropzone
              inputId="image-file"
              accept={acceptAttr}
              file={imageFile}
              onFile={setImageFile}
              error={fieldErrors.image}
              disabled={uploading}
              title="拖拽 PNG 图片到此处"
              hint={`仅支持 ${allowedExtensions.join(' / ')}（文件头需为 PNG 魔数），最大 ${maxLabel}。`}
            />

            {imageFile && imageNatural ? (
              <p className="upload-status upload-status--ok" role="status">
                已选择 {imageFile.name}（{imageNatural.width} × {imageNatural.height}），
                可在右侧确认显示效果。
              </p>
            ) : null}
          </section>

          {/* ------------------------- 说明区 ------------------------- */}
          <section className="card">
            <h2 className="card__title">
              2. 填写工程信息
              <span className="card__required">标题必填</span>
            </h2>

            <div className="field">
              <label className="field__label" htmlFor="title">
                标题
              </label>
              <input
                id="title"
                className={`input${fieldErrors.title ? ' has-error' : ''}`}
                type="text"
                value={title}
                maxLength={160}
                placeholder="例如：深色风格 App 首页 UI 稿"
                onChange={(event) => setTitle(event.target.value)}
                aria-invalid={Boolean(fieldErrors.title)}
                aria-describedby="title-hint"
                disabled={uploading}
              />
              <p id="title-hint" className={`field__hint${fieldErrors.title ? ' field__hint--error' : ''}`}>
                {fieldErrors.title ?? `必填，最多 120 个字符（当前 ${title.trim().length}）。`}
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="description">
                说明
              </label>
              <textarea
                id="description"
                className={`textarea${fieldErrors.description ? ' has-error' : ''}`}
                value={description}
                rows={7}
                placeholder="介绍这个工程的用途、设计思路、可复用素材等。支持换行，不解析 Markdown。"
                onChange={(event) => setDescription(event.target.value)}
                aria-invalid={Boolean(fieldErrors.description)}
                aria-describedby="description-hint"
                disabled={uploading}
              />
              <p
                id="description-hint"
                className={`field__hint${fieldErrors.description ? ' field__hint--error' : ''}`}
              >
                {fieldErrors.description ?? `选填，最多 5000 个字符（当前 ${description.length}）。`}
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="author">
                作者
              </label>
              <input
                id="author"
                className={`input${fieldErrors.author ? ' has-error' : ''}`}
                type="text"
                value={effectiveAuthor}
                maxLength={80}
                placeholder={access.authorLocked ? '' : '留空则显示为「匿名作者」'}
                onChange={(event) => setAuthor(event.target.value)}
                aria-invalid={Boolean(fieldErrors.author)}
                aria-describedby="author-hint"
                disabled={uploading}
                // 契约 §8.3：登录态下作者名由服务端强制取令牌里的 cn，客户端改不了也不该假装能改
                readOnly={access.authorLocked}
              />
              <p id="author-hint" className={`field__hint${fieldErrors.author ? ' field__hint--error' : ''}`}>
                {access.authorLocked
                  ? '作者将使用你的登录用户名，不可修改。'
                  : (fieldErrors.author ?? `选填，最多 60 个字符（当前 ${effectiveAuthor.trim().length}）。`)}
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tags">
                标签
              </label>
              <TagInput id="tags" value={tags} onChange={setTags} disabled={uploading} />
              {fieldErrors.tags ? (
                <p className="field__hint field__hint--error">{fieldErrors.tags}</p>
              ) : null}
            </div>
          </section>

          {/* ------------------------- 网盘区 ------------------------- */}
          <section className="card">
            <h2 className="card__title">
              3. 网盘分享链接
              <span className="card__required">必填</span>
            </h2>

            <div className="field">
              <label className="field__label" htmlFor="netdisk-url">
                分享链接
              </label>
              <input
                id="netdisk-url"
                className={`input${fieldErrors.netdiskUrl ? ' has-error' : ''}`}
                type="url"
                inputMode="url"
                value={netdiskUrl}
                maxLength={netdiskUrlMaxLength}
                placeholder="https://pan.baidu.com/s/xxxx"
                onChange={(event) => setNetdiskUrl(event.target.value)}
                aria-invalid={Boolean(fieldErrors.netdiskUrl)}
                aria-describedby="netdisk-url-hint"
                disabled={uploading}
              />
              <p
                id="netdisk-url-hint"
                className={`field__hint${fieldErrors.netdiskUrl ? ' field__hint--error' : ''}`}
              >
                {fieldErrors.netdiskUrl ??
                  `必填，需以 http:// 或 https:// 开头，最多 ${netdiskUrlMaxLength} 个字符。`}
              </p>

              {/* 本地即时提示：帮用户当场发现粘错链接；最终类型以服务端返回为准（契约 §1.3） */}
              {hasNetdiskInput ? (
                <p className="netdisk-detect" role="status">
                  <span
                    className={`netdisk-badge netdisk-badge--${localProvider}`}
                    style={providerColorStyle(localProvider)}
                    aria-hidden="true"
                  >
                    {localProviderStyle.icon}
                  </span>
                  已识别为：
                  <strong className="netdisk-detect__label">{localProviderStyle.label}</strong>
                  <span className="netdisk-detect__note">
                    （本地预览，最终以服务端识别结果为准）
                  </span>
                </p>
              ) : (
                <p className="netdisk-detect netdisk-detect--idle">
                  <span className="netdisk-badge netdisk-badge--other" aria-hidden="true">
                    {providerStyle('other').icon}
                  </span>
                  尚未填写链接（{EMPTY_PROVIDER_LABEL}）
                </p>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="extract-code">
                提取码
              </label>
              <input
                id="extract-code"
                className={`input${fieldErrors.extractCode ? ' has-error' : ''}`}
                type="text"
                value={extractCode}
                maxLength={extractCodeMaxLength}
                placeholder="例如 abcd（没有就留空）"
                onChange={(event) => setExtractCode(event.target.value)}
                aria-invalid={Boolean(fieldErrors.extractCode)}
                aria-describedby="extract-code-hint"
                disabled={uploading}
              />
              <p
                id="extract-code-hint"
                className={`field__hint${fieldErrors.extractCode ? ' field__hint--error' : ''}`}
              >
                {fieldErrors.extractCode ?? `选填，最多 ${extractCodeMaxLength} 个字符。`}
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="source-file-name">
                源文件名
              </label>
              <input
                id="source-file-name"
                className={`input${fieldErrors.sourceFileName ? ' has-error' : ''}`}
                type="text"
                value={sourceFileName}
                maxLength={SOURCE_FILE_NAME_MAX + 20}
                placeholder="例如 深色UI稿.psd"
                onChange={(event) => setSourceFileName(event.target.value)}
                aria-invalid={Boolean(fieldErrors.sourceFileName)}
                aria-describedby="source-file-name-hint"
                disabled={uploading}
              />
              <p
                id="source-file-name-hint"
                className={`field__hint${fieldErrors.sourceFileName ? ' field__hint--error' : ''}`}
              >
                {fieldErrors.sourceFileName ??
                  `选填，网盘里那个源文件的文件名，最多 ${SOURCE_FILE_NAME_MAX} 个字符（当前 ${sourceFileName.trim().length}）。`}
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="source-note">
                备注
              </label>
              <input
                id="source-note"
                className={`input${fieldErrors.sourceNote ? ' has-error' : ''}`}
                type="text"
                value={sourceNote}
                maxLength={SOURCE_NOTE_MAX + 20}
                placeholder="例如 含分层源文件"
                onChange={(event) => setSourceNote(event.target.value)}
                aria-invalid={Boolean(fieldErrors.sourceNote)}
                aria-describedby="source-note-hint"
                disabled={uploading}
              />
              <p
                id="source-note-hint"
                className={`field__hint${fieldErrors.sourceNote ? ' field__hint--error' : ''}`}
              >
                {fieldErrors.sourceNote ??
                  `选填，最多 ${SOURCE_NOTE_MAX} 个字符（当前 ${sourceNote.trim().length}）。`}
              </p>
            </div>
          </section>
        </div>

        {/* ------------------------- 侧边：预览确认 + 提交 ------------------------- */}
        <aside className="upload-form__aside">
          <div className="card card--sticky">
            <h2 className="card__title">提交前确认</h2>

            {/* 预览框比例跟随 PNG 真实尺寸；CSS 的 3:2 只在图片尚未加载时兜底 */}
            <div className="preview-box checkerboard" style={previewAspectRatioStyle(imageNatural?.width, imageNatural?.height)}>
              {imageUrl ? (
                <img
                  className="preview-box__image"
                  src={imageUrl}
                  alt="展示图预览"
                  onLoad={(event) => {
                    const el = event.currentTarget;
                    if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                      setImageNatural({ width: el.naturalWidth, height: el.naturalHeight });
                    }
                  }}
                />
              ) : (
                <div className="preview-box__placeholder">
                  <span>选择 PNG 后将在此处预览</span>
                </div>
              )}
            </div>

            <dl className="preview-summary">
              <div className="preview-summary__row">
                <dt>标题</dt>
                <dd>{title.trim() || <span className="text-muted">未填写</span>}</dd>
              </div>
              <div className="preview-summary__row">
                <dt>作者</dt>
                <dd>
                  {effectiveAuthor.trim() || '匿名作者'}
                  {access.authorLocked ? (
                    <span className="preview-summary__note">（登录用户名）</span>
                  ) : null}
                </dd>
              </div>
              <div className="preview-summary__row">
                <dt>展示图</dt>
                <dd>
                  {imageFile ? (
                    `${imageFile.name}（${formatBytes(imageFile.size)}）`
                  ) : (
                    <span className="text-muted">未选择</span>
                  )}
                </dd>
              </div>
              <div className="preview-summary__row">
                <dt>网盘</dt>
                <dd>
                  {hasNetdiskInput ? (
                    <span className="netdisk-detect netdisk-detect--inline">
                      <span
                        className={`netdisk-badge netdisk-badge--${localProvider}`}
                        style={providerColorStyle(localProvider)}
                        aria-hidden="true"
                      >
                        {localProviderStyle.icon}
                      </span>
                      {localProviderStyle.label}
                    </span>
                  ) : (
                    <span className="text-muted">未填写</span>
                  )}
                </dd>
              </div>
              <div className="preview-summary__row">
                <dt>提取码</dt>
                <dd>{extractCode.trim() || '无'}</dd>
              </div>
              <div className="preview-summary__row">
                <dt>标签</dt>
                <dd>{effectiveTags.length > 0 ? effectiveTags.join('、') : '无'}</dd>
              </div>
            </dl>

            {uploading ? (
              <UploadProgress progress={progress} fileName={imageFile?.name} onCancel={cancelUpload} />
            ) : (
              <button type="submit" className="btn btn--primary btn--block btn--lg">
                上传并发布
              </button>
            )}

            <p className="field__hint">
              上传即表示你确认对该工程拥有分享权利。PNG 会以原始字节保存；
              源文件由你的网盘托管，本站只登记分享链接，访问者点击「前往网盘下载」时经由本站跳转并计数。
            </p>
          </div>
        </aside>
      </form>
    </div>
  );
}
