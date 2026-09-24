import { useMemo, useState, type KeyboardEvent } from 'react';

import { TAG_MAX_LENGTH, TAGS_MAX_COUNT, parseTags, validateTags } from '@/upload/fieldRules';

/**
 * 标签输入：输入框内以回车/逗号/中文逗号成词，退格删除最后一个。
 * 去重（大小写不敏感）与数量、长度上限均与契约 §3.6 对齐。
 */
export function TagInput({
  value,
  onChange,
  id = 'tags',
  disabled = false,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  id?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const check = useMemo(() => validateTags(value), [value]);

  const commit = (raw: string) => {
    const next = parseTags([...value, raw]);
    const result = validateTags(next);

    if (next.length > TAGS_MAX_COUNT) {
      setError(result.message ?? null);
      return;
    }
    if (raw.trim().length > TAG_MAX_LENGTH) {
      setError(`单个标签最多 ${TAG_MAX_LENGTH} 个字符`);
      return;
    }

    setError(null);
    onChange(next);
    setDraft('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      event.preventDefault();
      if (draft.trim()) commit(draft);
      return;
    }
    if (event.key === 'Backspace' && !draft && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
      setError(null);
    }
  };

  const remove = (tag: string) => {
    onChange(value.filter((item) => item !== tag));
    setError(null);
  };

  return (
    <div className="tag-input">
      <div
        className={`tag-input__field${error || !check.ok ? ' has-error' : ''}`}
        onClick={(event) => {
          // 点击空白区域聚焦输入框
          const input = (event.currentTarget as HTMLElement).querySelector('input');
          input?.focus();
        }}
      >
        {value.map((tag) => (
          <span key={tag} className="tag tag--removable">
            {tag}
            <button
              type="button"
              className="tag__remove"
              aria-label={`移除标签 ${tag}`}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                remove(tag);
              }}
            >
              <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                <path
                  d="M3.1 3.1a.7.7 0 0 1 1 0L6 5l1.9-1.9a.7.7 0 1 1 1 1L7 6l1.9 1.9a.7.7 0 1 1-1 1L6 7 4.1 8.9a.7.7 0 0 1-1-1L5 6 3.1 4.1a.7.7 0 0 1 0-1Z"
                  fill="currentColor"
                />
              </svg>
            </button>
          </span>
        ))}

        <input
          id={id}
          className="tag-input__control"
          type="text"
          value={draft}
          disabled={disabled || value.length >= TAGS_MAX_COUNT}
          placeholder={value.length === 0 ? '输入标签后回车，例如：UI、科幻' : ''}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (draft.trim()) commit(draft);
          }}
          aria-describedby={`${id}-hint`}
          aria-invalid={Boolean(error) || !check.ok}
        />
      </div>

      <p id={`${id}-hint`} className={`field__hint${error ? ' field__hint--error' : ''}`}>
        {error ?? `最多 ${TAGS_MAX_COUNT} 个标签，每个不超过 ${TAG_MAX_LENGTH} 个字符；已添加 ${value.length} 个。`}
      </p>
    </div>
  );
}
