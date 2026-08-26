import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import { PRESENTATION_COLORS } from "../src/catalog/model-presentation-color.js";
import {
  EMPTY_STATUS,
  adminJson,
  dateText,
  genericErrorText,
  safeSourceUrl,
} from "./admin-shared.js";
import type { CategoryFacet, StatusMessage } from "./admin-shared.js";

interface ListingOverrides {
  manufacturerId: string | null;
  model: string | null;
  primaryCategoryId: string | null;
  presentationColor: string | null;
  updatedAt: string | null;
}

interface ListingProduct {
  id: number;
  shopKey: string;
  sourceId: string;
  sourceUrl: string;
  isActive: boolean;
  stockStatus: string;
  priceYen: number | null;
  title: string;
  rawManufacturer: string;
  manufacturer: string;
  manufacturerId: string;
  canonicalManufacturerId: string;
  rawModel: string;
  model: string;
  normalizedModel: string;
  rawCategory: string;
  category: string;
  primaryCategoryId: string;
  classificationStatus: string;
  presentationColor: string;
  lastSeenAt: string;
  lastChangedAt: string;
  lastActivityAt: string;
  overrides: ListingOverrides;
}

interface ListingListResponse {
  items: ListingProduct[];
  nextAfterId: number | null;
  hasMore: boolean;
}

interface ListingUpdateResponse {
  listing: ListingProduct;
  refreshedListings: number;
}

interface ListingFilters {
  q: string;
  shopKey: string;
  categoryId: string;
  scope: "active" | "all";
}

const EMPTY_FILTERS: ListingFilters = { q: "", shopKey: "", categoryId: "", scope: "active" };

interface EditDraft {
  manufacturerId: string;
  model: string;
  presentationColor: string;
  primaryCategoryId: string;
}

function listingErrorText(error: unknown): string {
  const value = genericErrorText(error);
  if (value === "listing_admin_manufacturer_not_verified") {
    return "指定したManufacturer IDは検証済みメーカーとして登録されていません。";
  }
  if (value === "listing_admin_category_invalid") {
    return "指定したカテゴリを登録商品へ設定できません。";
  }
  return value;
}

function priceText(value: number | null): string {
  return value == null ? "価格不明" : `¥${value.toLocaleString("ja-JP")}`;
}

function stockText(value: string): string {
  if (value === "in_stock") return "在庫あり";
  if (value === "sold_out") return "売切";
  return "不明";
}

function overrideLabels(product: ListingProduct): string[] {
  const labels: string[] = [];
  if (product.overrides.manufacturerId !== null) labels.push("メーカー");
  if (product.overrides.model !== null) labels.push("型番");
  if (product.overrides.primaryCategoryId !== null) labels.push("カテゴリ");
  if (product.overrides.presentationColor !== null) labels.push("色");
  return labels;
}

function StackCell({
  lines,
}: {
  lines: Array<{ text: string; strong?: boolean; className?: string }>;
}) {
  return (
    <td>
      <div className="listing-cell-stack">
        {lines.map((line, index) =>
          line.strong ? (
            <strong className={line.className || undefined} key={`${index}-${line.text}`}>
              {line.text}
            </strong>
          ) : (
            <small className={line.className || undefined} key={`${index}-${line.text}`}>
              {line.text}
            </small>
          ),
        )}
      </div>
    </td>
  );
}

export function ListingAdmin() {
  const [status, setStatus] = useState<StatusMessage>(EMPTY_STATUS);
  const [categories, setCategories] = useState<CategoryFacet[]>([]);
  const filterableCategories = useMemo(
    () => categories.filter((category) => category.filterable),
    [categories],
  );
  const classifiableCategories = useMemo(
    () => categories.filter((category) => category.classifiable),
    [categories],
  );

  const [draft, setDraft] = useState<ListingFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<ListingFilters>(EMPTY_FILTERS);
  const [items, setItems] = useState<ListingProduct[]>([]);
  const [currentAfterId, setCurrentAfterId] = useState(0);
  const [nextAfterId, setNextAfterId] = useState<number | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);

  const [editing, setEditing] = useState<ListingProduct | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({
    manufacturerId: "",
    model: "",
    presentationColor: "",
    primaryCategoryId: "",
  });
  const [saving, setSaving] = useState(false);
  const editDialogRef = useRef<HTMLDialogElement>(null);

  const loadListings = useCallback(
    async (filters: ListingFilters, afterId: number, nextHistory: number[]) => {
      setBusy(true);
      setStatus({ text: "登録商品を読み込んでいます…", kind: "info" });
      const params = new URLSearchParams({ scope: filters.scope, limit: "50" });
      if (filters.q.trim()) params.set("q", filters.q.trim());
      if (filters.shopKey.trim()) params.set("shopKey", filters.shopKey.trim().toLowerCase());
      if (filters.categoryId) params.set("categoryId", filters.categoryId);
      if (afterId) params.set("afterId", String(afterId));
      try {
        const response = await adminJson<ListingListResponse>(`/api/admin/listings?${params}`);
        setItems(response.items);
        setCurrentAfterId(afterId);
        setNextAfterId(response.nextAfterId);
        setHistory(nextHistory);
        setReady(true);
        const hasFilters = Boolean(
          filters.q.trim() ||
          filters.shopKey.trim() ||
          filters.categoryId ||
          filters.scope !== "active",
        );
        setStatus({
          text: hasFilters ? "検索条件を反映しました。" : "登録商品を表示しています。",
          kind: "success",
        });
      } catch (error) {
        setItems([]);
        setNextAfterId(null);
        setStatus({
          text: `登録商品の取得に失敗しました: ${listingErrorText(error)}`,
          kind: "error",
        });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setStatus({ text: "管理データを読み込んでいます…", kind: "info" });
      try {
        const meta = await adminJson<{ categoryFacets: CategoryFacet[] }>("/api/meta");
        if (cancelled) return;
        setCategories(meta.categoryFacets);
        await loadListings(EMPTY_FILTERS, 0, []);
      } catch (error) {
        if (!cancelled) {
          setBusy(false);
          setStatus({
            text: `管理画面の初期化に失敗しました: ${listingErrorText(error)}`,
            kind: "error",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadListings]);

  useEffect(() => {
    const dialog = editDialogRef.current;
    if (!dialog) return;
    if (editing && !dialog.open) dialog.showModal();
    if (!editing && dialog.open) dialog.close();
  }, [editing]);

  const classifiableCategoryId = (primaryCategoryId: string) =>
    categories.some((category) => category.id === primaryCategoryId && category.classifiable)
      ? primaryCategoryId
      : "";

  const openEdit = (product: ListingProduct) => {
    setEditing(product);
    setEditDraft({
      manufacturerId: product.canonicalManufacturerId || product.manufacturerId || "",
      model: product.model || "",
      presentationColor: product.presentationColor || "",
      primaryCategoryId: classifiableCategoryId(product.primaryCategoryId),
    });
  };

  const initialEditDraft: EditDraft | null = editing
    ? {
        manufacturerId: (
          editing.canonicalManufacturerId ||
          editing.manufacturerId ||
          ""
        ).toLowerCase(),
        model: editing.model || "",
        presentationColor: editing.presentationColor || "",
        primaryCategoryId: classifiableCategoryId(editing.primaryCategoryId),
      }
    : null;
  const editDirty = Boolean(
    initialEditDraft &&
    (editDraft.manufacturerId.trim().toLowerCase() !== initialEditDraft.manufacturerId ||
      editDraft.model.trim() !== initialEditDraft.model ||
      editDraft.presentationColor.trim() !== initialEditDraft.presentationColor ||
      (editDraft.primaryCategoryId !== "" &&
        editDraft.primaryCategoryId !== initialEditDraft.primaryCategoryId)),
  );

  const closeEdit = (force = false) => {
    if (!force && editDirty && !window.confirm("未保存の変更を破棄しますか？")) return;
    setEditing(null);
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setApplied(draft);
    void loadListings(draft, 0, []);
  };

  const saveEditing = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || !initialEditDraft || saving || !editDirty) return;
    const input: {
      manufacturerId?: string;
      model?: string;
      presentationColor?: string;
      primaryCategoryId?: string;
    } = {};
    const manufacturerId = editDraft.manufacturerId.trim().toLowerCase();
    const model = editDraft.model.trim();
    const presentationColor = editDraft.presentationColor.trim();
    const primaryCategoryId = editDraft.primaryCategoryId;
    if (manufacturerId !== initialEditDraft.manufacturerId) input.manufacturerId = manufacturerId;
    if (model !== initialEditDraft.model) input.model = model;
    if (presentationColor !== initialEditDraft.presentationColor) {
      input.presentationColor = presentationColor;
    }
    if (primaryCategoryId && primaryCategoryId !== initialEditDraft.primaryCategoryId) {
      input.primaryCategoryId = primaryCategoryId;
    }

    setSaving(true);
    try {
      const response = await adminJson<ListingUpdateResponse>(`/api/admin/listings/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      closeEdit(true);
      setStatus({
        text: `listing #${response.listing.id} を保存し、検索・Product Identityを再投影しました。`,
        kind: "success",
      });
      await loadListings(applied, currentAfterId, history);
    } catch (error) {
      setStatus({ text: `保存に失敗しました: ${listingErrorText(error)}`, kind: "error" });
    } finally {
      setSaving(false);
    }
  };

  const hasDraftFilters = Boolean(
    draft.q.trim() || draft.shopKey.trim() || draft.categoryId || draft.scope !== "active",
  );
  const sourceUrl = editing ? safeSourceUrl(editing.sourceUrl) : null;

  return (
    <section
      id="listings-pane"
      className="admin-pane"
      role="tabpanel"
      aria-labelledby="admin-tab-listings"
    >
      <div className="admin-pane-heading">
        <div>
          <p className="eyebrow">LISTING OPERATIONS</p>
          <h2>登録商品 管理</h2>
          <p>
            販売店から取得したlistingのメーカー・型番・カテゴリ・色を、永続的な手動補正として修正します。
          </p>
        </div>
      </div>
      <p className="status-message" role="status" aria-live="polite" data-kind={status.kind}>
        {status.text}
      </p>

      {ready ? (
        <>
          <section className="panel workspace-panel" aria-labelledby="listing-search-heading">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">LISTING WORKSPACE</p>
                <h2 id="listing-search-heading">登録商品を検索・編集</h2>
                <p>商品名・型番・メーカー・色・店舗・カテゴリで対象listingを絞り込めます。</p>
              </div>
              <span className="keyboard-hint">
                <kbd>Enter</kbd> で検索
              </span>
            </div>
            <form className="search-grid listing-search-grid" onSubmit={submitSearch}>
              <label className="search-field search-field-wide">
                <span>商品を検索</span>
                <input
                  id="listings-listing-query"
                  type="search"
                  placeholder="商品名 / 型番 / メーカー / 色 / source id"
                  autoComplete="off"
                  value={draft.q}
                  disabled={busy}
                  onChange={({ currentTarget: { value: nextValue } }) =>
                    setDraft((value) => ({ ...value, q: nextValue }))
                  }
                />
              </label>
              <label className="search-field">
                <span>店舗</span>
                <input
                  id="listings-shop-key"
                  type="text"
                  placeholder="audiounion"
                  autoComplete="off"
                  value={draft.shopKey}
                  disabled={busy}
                  onChange={({ currentTarget: { value: nextValue } }) =>
                    setDraft((value) => ({ ...value, shopKey: nextValue }))
                  }
                />
              </label>
              <label className="search-field">
                <span>カテゴリ</span>
                <select
                  id="listings-category-filter"
                  value={draft.categoryId}
                  disabled={busy}
                  onChange={({ currentTarget: { value: nextValue } }) =>
                    setDraft((value) => ({ ...value, categoryId: nextValue }))
                  }
                >
                  <option value="">すべてのカテゴリ</option>
                  {filterableCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="search-field">
                <span>掲載状態</span>
                <select
                  id="listings-listing-scope"
                  value={draft.scope}
                  disabled={busy}
                  onChange={({ currentTarget: { value: nextValue } }) =>
                    setDraft((value) => ({
                      ...value,
                      scope: nextValue === "all" ? "all" : "active",
                    }))
                  }
                >
                  <option value="active">掲載中のみ</option>
                  <option value="all">全履歴</option>
                </select>
              </label>
              <div className="search-actions">
                <button
                  className="tertiary-button"
                  type="button"
                  disabled={busy || !hasDraftFilters}
                  onClick={() => {
                    setDraft(EMPTY_FILTERS);
                    setApplied(EMPTY_FILTERS);
                    void loadListings(EMPTY_FILTERS, 0, []);
                  }}
                >
                  条件をクリア
                </button>
                <button type="submit" disabled={busy}>
                  検索
                </button>
              </div>
            </form>
          </section>

          <section
            className={`panel table-panel${busy ? " is-loading" : ""}`}
            aria-label="登録商品一覧"
            aria-busy={busy}
          >
            <div className="table-toolbar">
              <div>
                <p className="eyebrow">RESULTS</p>
                <h2>登録商品一覧</h2>
              </div>
              <p className="result-summary" aria-live="polite">
                {items.length ? `${items.length.toLocaleString("ja-JP")}件を表示` : "該当 0件"}
              </p>
            </div>
            <div className="table-wrap">
              <table className="listing-table">
                <thead>
                  <tr>
                    <th>ID / 店舗</th>
                    <th>商品</th>
                    <th>メーカー</th>
                    <th>型番 / 色</th>
                    <th>カテゴリ</th>
                    <th>価格 / 在庫</th>
                    <th>最終確認</th>
                    <th>補正</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((product) => {
                    const labels = overrideLabels(product);
                    return (
                      <tr key={product.id}>
                        <StackCell
                          lines={[
                            { text: `#${product.id}`, strong: true },
                            { text: product.shopKey },
                            { text: product.sourceId, className: "listing-muted" },
                          ]}
                        />
                        <td>
                          <span className="listing-title">{product.title}</span>
                          {!product.isActive ? (
                            <small className="listing-muted">掲載終了</small>
                          ) : null}
                        </td>
                        <StackCell
                          lines={[
                            { text: product.manufacturer || "—", strong: true },
                            {
                              text:
                                product.canonicalManufacturerId ||
                                product.manufacturerId ||
                                "ID未解決",
                            },
                            { text: product.rawManufacturer || "—", className: "raw-value" },
                          ]}
                        />
                        <StackCell
                          lines={[
                            { text: product.model || "—", strong: true },
                            { text: product.presentationColor ? `色: ${product.presentationColor}` : "色: —" },
                            { text: product.normalizedModel || "normalized未解決" },
                            { text: product.rawModel || "—", className: "raw-value" },
                          ]}
                        />
                        <StackCell
                          lines={[
                            { text: product.category || "—", strong: true },
                            { text: product.primaryCategoryId || "未分類" },
                            { text: product.rawCategory || "—", className: "raw-value" },
                          ]}
                        />
                        <td>
                          <div className="listing-cell-stack">
                            <span className="listing-price">{priceText(product.priceYen)}</span>
                            <span className="listing-status-badge" data-state={product.stockStatus}>
                              {stockText(product.stockStatus)}
                            </span>
                          </div>
                        </td>
                        <StackCell lines={[{ text: dateText(product.lastSeenAt), strong: true }]} />
                        <td>
                          <span
                            className="override-badge"
                            data-active={labels.length ? "true" : "false"}
                            title={
                              product.overrides.updatedAt
                                ? `最終補正: ${dateText(product.overrides.updatedAt)}`
                                : undefined
                            }
                          >
                            {labels.length ? labels.join(" / ") : "なし"}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => openEdit(product)}
                          >
                            編集
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!items.length ? (
              <p className="empty-state">
                <strong>条件に一致する登録商品がありません。</strong>
                <span>検索条件を減らすか、全履歴へ切り替えて再検索してください。</span>
              </p>
            ) : null}
            <div className="pagination-bar">
              <span>ページ {history.length + 1}</span>
              <nav className="pagination" aria-label="登録商品ページング">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy || !history.length}
                  onClick={() => {
                    const previous = history.at(-1);
                    if (previous !== undefined)
                      void loadListings(applied, previous, history.slice(0, -1));
                  }}
                >
                  ← 前へ
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy || nextAfterId === null}
                  onClick={() => {
                    if (nextAfterId !== null)
                      void loadListings(applied, nextAfterId, [...history, currentAfterId]);
                  }}
                >
                  次へ →
                </button>
              </nav>
            </div>
          </section>
        </>
      ) : null}

      <dialog
        ref={editDialogRef}
        onClose={() => setEditing(null)}
        onCancel={(event) => {
          if (editDirty) {
            event.preventDefault();
            closeEdit();
          }
        }}
      >
        {editing ? (
          <form className="edit-form" onSubmit={(event) => void saveEditing(event)}>
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">EDIT LISTING</p>
                <h2>登録商品を修正</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="編集画面を閉じる"
                onClick={() => closeEdit()}
              >
                ×
              </button>
            </div>
            <div className="identity-card listing-identity-card">
              <span>変更対象</span>
              <p className="identity">{editing.title}</p>
              <p className="identity-note">
                {editing.shopKey} / {editing.sourceId} / listing #{editing.id}
              </p>
              {sourceUrl ? (
                <a className="source-link" href={sourceUrl} target="_blank" rel="noreferrer">
                  販売店の商品ページを開く ↗
                </a>
              ) : null}
            </div>
            <div className="source-evidence">
              <strong>販売店の取得値</strong>
              <dl>
                <div>
                  <dt>メーカー</dt>
                  <dd>{editing.rawManufacturer || "—"}</dd>
                </div>
                <div>
                  <dt>型番</dt>
                  <dd>{editing.rawModel || "—"}</dd>
                </div>
                <div>
                  <dt>カテゴリ</dt>
                  <dd>{editing.rawCategory || "—"}</dd>
                </div>
              </dl>
            </div>
            <label>
              <span>Canonical Manufacturer ID</span>
              <input
                type="text"
                maxLength={100}
                autoComplete="off"
                value={editDraft.manufacturerId}
                onChange={({ currentTarget: { value: nextValue } }) =>
                  setEditDraft((value) => ({ ...value, manufacturerId: nextValue }))
                }
              />
              <small>例: luxman。空欄にするとメーカー未解決として固定します。</small>
            </label>
            <label>
              <span>型番</span>
              <input
                type="text"
                maxLength={200}
                autoComplete="off"
                value={editDraft.model}
                onChange={({ currentTarget: { value: nextValue } }) =>
                  setEditDraft((value) => ({ ...value, model: nextValue }))
                }
              />
              <small>検索とProduct Identityに使う正規化後の型番です。</small>
            </label>
            <label>
              <span>表示色 / 仕上げ</span>
              <input
                type="text"
                maxLength={100}
                autoComplete="off"
                list="listing-presentation-colors"
                placeholder="ブラック / シルバー / ブラック/ゴールド"
                value={editDraft.presentationColor}
                onChange={({ currentTarget: { value: nextValue } }) =>
                  setEditDraft((value) => ({ ...value, presentationColor: nextValue }))
                }
              />
              <datalist id="listing-presentation-colors">
                {PRESENTATION_COLORS.map((color) => (
                  <option key={color.id} value={color.name} />
                ))}
              </datalist>
              <small>
                Catalogの標準色辞書へ正規化します。2色仕上げは「ブラック/ゴールド」のように / で区切れます。空欄は色なしとして固定します。
              </small>
            </label>
            <label>
              <span>主カテゴリ</span>
              <select
                required
                value={editDraft.primaryCategoryId}
                onChange={({ currentTarget: { value: nextValue } }) =>
                  setEditDraft((value) => ({
                    ...value,
                    primaryCategoryId: nextValue,
                  }))
                }
              >
                <option value="">未分類（未選択）</option>
                {classifiableCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="edit-impact">
              <strong>保存時の処理</strong>
              <p>
                手動補正を永続化し、検索インデックス → Product Identity →
                製品グループの順で再投影します。次回クロールでも補正は保持されます。
              </p>
            </div>
            <div className="read-only-note">
              タイトル・価格・在庫・商品URLは販売店の一次情報として保持するため、この画面では変更できません。
            </div>
            <p className="edit-change-status" data-dirty={editDirty ? "true" : "false"}>
              {editDirty ? "未保存の変更があります。" : "変更すると保存できます。"}
            </p>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => closeEdit()}>
                キャンセル
              </button>
              <button type="submit" disabled={busy || saving || !editDirty}>
                {saving ? "保存中…" : "変更を保存"}
              </button>
            </div>
          </form>
        ) : null}
      </dialog>
    </section>
  );
}
