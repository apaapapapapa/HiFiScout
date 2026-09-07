import { useEffect, useId, useRef, useState } from "react";
import {
  ADMIN_MANUFACTURER_PAGE_SIZE,
  isAdminManufacturerPage,
  type AdminManufacturerOption,
  type AdminManufacturerPage,
} from "../src/api/admin-manufacturer-contracts.js";
import { adminJson, genericErrorText } from "./admin-shared.js";

interface ManufacturerPickerProps {
  value: string;
  valueLabel?: string;
  onChange: (value: string, name?: string) => void;
  disabled?: boolean;
  clearLabel?: string;
  customLabel?: string;
}

/** The search text and selected identity stay separate, including on failed/stale requests. */
export function AdminManufacturerPicker({
  value,
  valueLabel,
  onChange,
  disabled = false,
  clearLabel = "メーカー条件を解除",
  customLabel,
}: ManufacturerPickerProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [afterId, setAfterId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<AdminManufacturerPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<AdminManufacturerOption | null>(null);
  const generation = useRef(0);
  const name = selection?.id === value ? selection.name : valueLabel || value;

  useEffect(() => {
    if (!open) return;
    const version = ++generation.current;
    const controller = new AbortController();
    setPage(null);
    setError("");
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        q: query,
        afterId,
        limit: String(ADMIN_MANUFACTURER_PAGE_SIZE),
      });
      void adminJson<unknown>(`/api/admin/manufacturers?${params}`, { signal: controller.signal })
        .then((response) => {
          if (!isAdminManufacturerPage(response))
            throw new Error("メーカー候補の応答を確認できませんでした。");
          if (generation.current === version && !controller.signal.aborted) setPage(response);
        })
        .catch((reason: unknown) => {
          if (generation.current === version && !controller.signal.aborted)
            setError(genericErrorText(reason));
        })
        .finally(() => {
          if (generation.current === version && !controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, afterId, attempt]);

  return (
    <fieldset className="admin-manufacturer-picker" disabled={disabled}>
      <legend>メーカー</legend>
      <p className="manufacturer-selection" aria-live="polite">
        {value ? (
          <>
            選択中: <strong>{name}</strong> <code>{value}</code>
          </>
        ) : (
          "メーカーは未選択です。"
        )}
      </p>
      {value ? (
        <button type="button" className="tertiary-button" onClick={() => onChange("")}>
          {clearLabel}
        </button>
      ) : null}
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>メーカー名から選ぶ</summary>
        <label htmlFor={`${id}-query`}>メーカー候補を検索</label>
        <input
          id={`${id}-query`}
          type="search"
          maxLength={100}
          autoComplete="off"
          placeholder="例: ラックスマン / LUXMAN"
          value={query}
          onChange={(event) => {
            setPage(null);
            setQuery(event.currentTarget.value);
            setAfterId("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />
        <small>名称・ID・検証済みの別名で検索できます。候補を選ぶとメーカーを設定します。</small>
        {loading ? <p role="status">メーカー候補を読み込んでいます…</p> : null}
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              メーカー候補を再読み込み
            </button>
          </div>
        ) : null}
        {page?.items.length ? (
          <>
            <label htmlFor={`${id}-options`}>メーカー候補</label>
            <select
              id={`${id}-options`}
              size={Math.min(6, page.items.length + 1)}
              value={value}
              onChange={(event) => {
                const selected = page.items.find((item) => item.id === event.currentTarget.value);
                if (selected) {
                  setSelection(selected);
                  onChange(selected.id, selected.name);
                }
              }}
            >
              {!page.items.some((item) => item.id === value) ? (
                <option value={value} disabled>
                  {value ? `${name} (${value}) — 選択中` : "候補を選択してください"}
                </option>
              ) : null}
              {page.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.id})
                </option>
              ))}
            </select>
            <div className="manufacturer-page-actions">
              {afterId ? (
                <button
                  type="button"
                  onClick={() => {
                    setPage(null);
                    setAfterId("");
                  }}
                >
                  候補の先頭に戻る
                </button>
              ) : null}
              {page.hasMore ? (
                <button
                  type="button"
                  onClick={() => {
                    setPage(null);
                    setAfterId(page.nextAfterId!);
                  }}
                >
                  次のメーカー候補
                </button>
              ) : null}
            </div>
          </>
        ) : page ? (
          <p role="status">一致する検証済みメーカーがありません。検索語を変えてください。</p>
        ) : null}
      </details>
      {customLabel ? (
        <details className="manufacturer-custom">
          <summary>{customLabel}</summary>
          <label htmlFor={`${id}-custom`}>メーカー名またはIDを直接指定</label>
          <input
            id={`${id}-custom`}
            type="text"
            maxLength={100}
            value={value}
            autoComplete="off"
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          <small>
            既存のID・別名を指定する補助入力です。検証済み候補の選択を優先してください。
          </small>
        </details>
      ) : null}
    </fieldset>
  );
}
