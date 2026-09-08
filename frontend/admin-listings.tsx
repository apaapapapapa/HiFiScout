import { AdminChangeHistoryPanel } from "./admin-change-history.js";
import { AdminBulkEdit } from "./admin-bulk-edit.js";
import { AdminListingDiagnosisPanel } from "./admin-listing-diagnosis.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AdminManufacturerPicker } from "./admin-manufacturer-picker.js";
import { AdminEditDiff, type AdminEditDiffRow } from "./admin-edit-diff.js";
import {
  canonicalAdminPresentationColor,
  type PresentationColorDefinition,
} from "../src/api/admin-listing-contracts.js";
import { AdminOfferFacts } from "./admin-offer-facts.js";
import { AdminOfferFactReplay } from "./admin-offer-fact-replay.js";

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

export function ListingAdmin({
  view = "listings",
  active = true,
  search = "",
  revision = 0,
}: {
  view?: "listings" | "maintenance";
  active?: boolean;
  search?: string;
  revision?: number;
}) {
  const [metaReady, setMetaReady] = useState(false);
  const [metaError, setMetaError] = useState("");
  const [metaAttempt, setMetaAttempt] = useState(0);
  const loadedSearch = useRef<{ search: string; revision: number } | null>(null);
  const searchRequest = useRef(0);
  const [replayVisited, setReplayVisited] = useState(view === "maintenance");
  const [status, setStatus] = useState<StatusMessage>(EMPTY_STATUS);
  const [categories, setCategories] = useState<CategoryFacet[]>([]);
  const [presentationColors, setPresentationColors] = useState<
    readonly PresentationColorDefinition[]
  >([]);
  const [shops, setShops] = useState<{ key: string; name: string }[]>([]);
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
  const [selected, setSelected] = useState<number[]>([]);
  const [bulkItems, setBulkItems] = useState<ListingProduct[] | null>(null);
  const [currentAfterId, setCurrentAfterId] = useState(0);
  const [nextAfterId, setNextAfterId] = useState<number | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [busy, setBusy] = useState(true);

  const [editing, setEditing] = useState<ListingProduct | null>(null);
  const [editManufacturerName, setEditManufacturerName] = useState("");
  const [historyTarget, setHistoryTarget] = useState<number | null>(null);
  const [diagnosing, setDiagnosing] = useState<number | null>(null);
  const [factsEditing, setFactsEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({
    manufacturerId: "",
    model: "",
    presentationColor: "",
    primaryCategoryId: "",
  });
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const editDialogRef = useRef<HTMLDialogElement>(null);

  const loadListings = useCallback(
    async (filters: ListingFilters, afterId: number, nextHistory: number[]) => {
      const request = ++searchRequest.current;
      setBusy(true);
      setSelected([]);
      setStatus({ text: "登録商品を読み込んでいます…", kind: "info" });
      const params = new URLSearchParams({ scope: filters.scope, limit: "50" });
      if (filters.q.trim()) params.set("q", filters.q.trim());
      if (filters.shopKey.trim()) params.set("shopKey", filters.shopKey.trim().toLowerCase());
      if (filters.categoryId) params.set("categoryId", filters.categoryId);
      if (afterId) params.set("afterId", String(afterId));
      try {
        const response = await adminJson<ListingListResponse>(`/api/admin/listings?${params}`);
        if (request !== searchRequest.current) return;
        setItems(response.items);
        setCurrentAfterId(afterId);
        setNextAfterId(response.nextAfterId);
        setHistory(nextHistory);
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
        return true;
      } catch (error) {
        if (request !== searchRequest.current) return;
        setItems([]);
        setNextAfterId(null);
        setStatus({
          text: `登録商品の取得に失敗しました: ${listingErrorText(error)}`,
          kind: "error",
        });
        return false;
      } finally {
        if (request === searchRequest.current) setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setMetaError("");
      try {
        const meta = await adminJson<{
          categoryFacets: CategoryFacet[];
          presentationColors?: PresentationColorDefinition[];
          shops?: { key: string; name: string }[];
        }>("/api/meta");
        if (cancelled) return;
        setCategories(meta.categoryFacets);
        setPresentationColors(meta.presentationColors ?? []);
        setShops([...(meta.shops ?? [])].sort((a, b) => a.name.localeCompare(b.name, "ja")));
        setMetaReady(true);
      } catch (error) {
        if (!cancelled) {
          setMetaError(listingErrorText(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metaAttempt]);

  useEffect(() => {
    if (!active || !metaReady) return;
    if (view === "maintenance") {
      setReplayVisited(true);
      return;
    }
    const previous = loadedSearch.current;
    if (previous?.search === search && previous.revision === revision) return;
    loadedSearch.current = { search, revision };
    const params = new URLSearchParams(search);
    const filters: ListingFilters =
      previous?.search === search
        ? applied
        : {
            q: params.get("q")?.trim() || "",
            shopKey: params.get("shopKey")?.trim() || "",
            categoryId: params.get("categoryId") || "",
            scope: params.get("scope") === "all" ? "all" : "active",
          };
    setDraft(filters);
    setApplied(filters);
    void loadListings(filters, 0, []);
  }, [active, metaReady, view, search, revision, applied, loadListings]);

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
    setEditError("");
    setEditing(product);
    setEditManufacturerName(product.manufacturer);
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
  const editChanges: AdminEditDiffRow[] = [];
  const canonicalColor = canonicalAdminPresentationColor(
    editDraft.presentationColor.trim(),
    presentationColors,
  );
  const invalidColor =
    initialEditDraft !== null &&
    editDraft.presentationColor.trim() !== initialEditDraft.presentationColor &&
    canonicalColor === null;
  if (initialEditDraft) {
    const manufacturerId = editDraft.manufacturerId.trim().toLowerCase();
    if (manufacturerId !== initialEditDraft.manufacturerId)
      editChanges.push({
        field: "メーカー",
        before: initialEditDraft.manufacturerId,
        after: manufacturerId
          ? `${editManufacturerName || manufacturerId} (${manufacturerId})`
          : "メーカー未解決として固定",
      });
    if (editDraft.model.trim() !== initialEditDraft.model)
      editChanges.push({
        field: "型番",
        before: initialEditDraft.model,
        after: editDraft.model.trim() || "型番未解決として固定",
      });
    if (editDraft.presentationColor.trim() !== initialEditDraft.presentationColor)
      editChanges.push({
        field: "表示色 / 仕上げ",
        before: initialEditDraft.presentationColor,
        after:
          canonicalColor === null ? "入力を確認してください" : canonicalColor || "色なしとして固定",
      });
    if (
      editDraft.primaryCategoryId &&
      editDraft.primaryCategoryId !== initialEditDraft.primaryCategoryId
    )
      editChanges.push({
        field: "主カテゴリ",
        before:
          categories.find((category) => category.id === initialEditDraft.primaryCategoryId)?.name ||
          "未分類",
        after:
          categories.find((category) => category.id === editDraft.primaryCategoryId)?.name ||
          editDraft.primaryCategoryId,
      });
  }

  const closeEdit = (force = false) => {
    if (!force && saving) return;
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
    if (!editing || !initialEditDraft || saving || !editDirty || invalidColor) return;
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

    setEditError("");
    setSaving(true);
    try {
      const response = await adminJson<ListingUpdateResponse>(`/api/admin/listings/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      closeEdit(true);
      const refreshed = await loadListings(applied, currentAfterId, history);
      setStatus({
        text: refreshed
          ? `登録商品 #${response.listing.id} を保存しました。検索結果にも反映しました。`
          : `登録商品 #${response.listing.id} は保存済みです。一覧を読み込めなかったため、もう一度検索してください。`,
        kind: refreshed ? "success" : "error",
      });
    } catch (error) {
      setEditError(`保存に失敗しました: ${listingErrorText(error)}`);
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
    <section id="listings-pane" className="admin-pane" aria-label="登録商品の作業">
      {!metaReady ? (
        <div className="panel admin-load-state" role={metaError ? "alert" : "status"}>
          <p>{metaError || "作業画面を準備しています…"}</p>
          {metaError ? (
            <button type="button" onClick={() => setMetaAttempt((attempt) => attempt + 1)}>
              もう一度読み込む
            </button>
          ) : null}
        </div>
      ) : null}
      <div hidden={view !== "listings"}>
        <p className="status-message" role="status" aria-live="polite" data-kind={status.kind}>
          {status.text}
        </p>

        {metaReady ? (
          <>
            <section className="panel workspace-panel" aria-labelledby="listing-search-heading">
              <div className="panel-heading">
                <div>
                  <h2 id="listing-search-heading">登録商品を検索・編集</h2>
                  <p>商品名・型番・メーカー・色・店舗・カテゴリで対象商品を絞り込めます。</p>
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
                    placeholder="例：LUXMAN D-1000 ブラック"
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
                  <select
                    id="listings-shop-key"
                    value={draft.shopKey}
                    disabled={busy}
                    onChange={({ currentTarget: { value: nextValue } }) =>
                      setDraft((value) => ({ ...value, shopKey: nextValue }))
                    }
                  >
                    <option value="">すべての店舗</option>
                    {draft.shopKey && !shops.some((shop) => shop.key === draft.shopKey) ? (
                      <option value={draft.shopKey}>{draft.shopKey}</option>
                    ) : null}
                    {shops.map((shop) => (
                      <option key={shop.key} value={shop.key}>
                        {shop.name}
                      </option>
                    ))}
                  </select>
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
              <div className="table-toolbar">
                <label>
                  <input
                    type="checkbox"
                    checked={items.length > 0 && selected.length === items.length}
                    disabled={busy || !items.length}
                    onChange={(event) =>
                      setSelected(event.currentTarget.checked ? items.map((item) => item.id) : [])
                    }
                  />
                  このページの全商品を選択
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || !selected.length}
                  onClick={() => setBulkItems(items.filter((item) => selected.includes(item.id)))}
                >
                  選択した{selected.length}件を一括修正
                </button>
              </div>
              <div className="table-wrap">
                <table className="listing-table">
                  <thead>
                    <tr>
                      <th>選択</th>
                      <th>商品 / 販売店</th>
                      <th>メーカー・型番</th>
                      <th>カテゴリ / 補正</th>
                      <th>価格 / 在庫</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((product) => {
                      const labels = overrideLabels(product);
                      return (
                        <tr key={product.id}>
                          <td data-label="選択">
                            <input
                              type="checkbox"
                              aria-label={`商品 #${product.id} を選択`}
                              disabled={busy}
                              checked={selected.includes(product.id)}
                              onChange={(event) => {
                                const checked = event.currentTarget.checked;
                                setSelected((ids) =>
                                  checked
                                    ? [...ids, product.id]
                                    : ids.filter((id) => id !== product.id),
                                );
                              }}
                            />
                          </td>
                          <td data-label="商品 / 販売店" className="listing-product-cell">
                            <div className="listing-cell-stack">
                              <button
                                type="button"
                                className="admin-text-button listing-title"
                                onClick={() => openEdit(product)}
                              >
                                {product.title}
                              </button>
                              <small>
                                {shops.find((shop) => shop.key === product.shopKey)?.name ??
                                  product.shopKey}{" "}
                                · #{product.id}
                              </small>
                              <small>最終確認 {dateText(product.lastSeenAt)}</small>
                              {!product.isActive ? <small>掲載終了</small> : null}
                            </div>
                          </td>
                          <td data-label="メーカー・型番">
                            <div className="listing-cell-stack">
                              <strong>{product.manufacturer || "メーカー未確定"}</strong>
                              <span>{product.model || "型番未確定"}</span>
                              <small>色: {product.presentationColor || "未設定"}</small>
                            </div>
                          </td>
                          <td data-label="カテゴリ / 補正">
                            <div className="listing-cell-stack">
                              <span className="category-badge">{product.category || "未分類"}</span>
                              {labels.length ? (
                                <span
                                  className="override-badge"
                                  title={
                                    product.overrides.updatedAt
                                      ? `最終補正: ${dateText(product.overrides.updatedAt)}`
                                      : undefined
                                  }
                                >
                                  補正済み · {labels.join(" / ")}
                                </span>
                              ) : (
                                <small>自動判定</small>
                              )}
                            </div>
                          </td>
                          <td data-label="価格 / 在庫">
                            <div className="listing-cell-stack">
                              <span className="listing-price">{priceText(product.priceYen)}</span>
                              <span
                                className="listing-status-badge"
                                data-state={product.stockStatus}
                              >
                                {stockText(product.stockStatus)}
                              </span>
                            </div>
                          </td>
                          <td data-label="操作" className="row-actions">
                            <button
                              type="button"
                              className="secondary-button compact"
                              onClick={() => openEdit(product)}
                            >
                              編集
                            </button>
                            <button
                              type="button"
                              className="secondary-button compact"
                              onClick={() => setFactsEditing(product.id)}
                            >
                              出品条件
                            </button>
                            <button
                              type="button"
                              className="secondary-button compact"
                              onClick={() => setDiagnosing(product.id)}
                            >
                              判定理由
                            </button>
                            <button
                              type="button"
                              className="secondary-button compact"
                              onClick={() => setHistoryTarget(product.id)}
                            >
                              変更履歴
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
                  <strong>
                    {busy ? "検索しています…" : "条件に一致する登録商品がありません。"}
                  </strong>
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
      </div>
      <div hidden={view !== "maintenance"}>
        {metaReady && replayVisited ? (
          <AdminOfferFactReplay
            shops={shops}
            categories={categories}
            active={active && view === "maintenance"}
            revision={revision}
          />
        ) : null}
      </div>

      {bulkItems ? (
        <AdminBulkEdit
          items={bulkItems}
          categories={categories}
          onClose={() => setBulkItems(null)}
          onChanged={() => {
            void loadListings(applied, currentAfterId, history);
          }}
        />
      ) : null}
      {historyTarget !== null ? (
        <AdminChangeHistoryPanel
          kind="listing"
          targetId={historyTarget}
          onClose={() => setHistoryTarget(null)}
          onChanged={() => {
            void loadListings(applied, currentAfterId, history);
          }}
        />
      ) : null}
      {diagnosing !== null ? (
        <AdminListingDiagnosisPanel
          key={diagnosing}
          listingId={diagnosing}
          onClose={() => setDiagnosing(null)}
        />
      ) : null}
      {factsEditing !== null ? (
        <AdminOfferFacts
          key={factsEditing}
          listingId={factsEditing}
          onClose={() => setFactsEditing(null)}
        />
      ) : null}

      <dialog
        className="admin-editor"
        aria-labelledby="listing-editor-heading"
        ref={editDialogRef}
        onClose={() => setEditing(null)}
        onCancel={(event) => {
          if (editDirty || saving) {
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
                <h2 id="listing-editor-heading">登録商品を修正</h2>
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
                {shops.find((shop) => shop.key === editing.shopKey)?.name ?? editing.shopKey} /
                店舗商品 {editing.sourceId} / 管理番号 #{editing.id}
              </p>
              {sourceUrl ? (
                <a className="source-link" href={sourceUrl} target="_blank" rel="noreferrer">
                  販売店の商品ページを開く ↗
                </a>
              ) : null}
            </div>
            <div className="source-evidence">
              <strong>販売店の取得値（変更されません）</strong>
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
            <AdminManufacturerPicker
              value={editDraft.manufacturerId}
              valueLabel={editManufacturerName}
              disabled={saving}
              clearLabel="メーカー未解決にする"
              onChange={(manufacturerId, name) => {
                setEditDraft((value) => ({ ...value, manufacturerId }));
                setEditManufacturerName(name || "");
              }}
            />
            <small>「メーカー未解決にする」は未解決の手動補正として保存します。</small>
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
              <small>検索や同一製品のまとめ表示に使う型番です。</small>
            </label>
            <label>
              <span>表示色 / 仕上げ</span>
              <input
                type="text"
                maxLength={100}
                autoComplete="off"
                placeholder="ブラック / シルバー / ブラック/ゴールド"
                aria-invalid={invalidColor}
                aria-describedby="listing-color-error"
                value={editDraft.presentationColor}
                onChange={({ currentTarget: { value: nextValue } }) =>
                  setEditDraft((value) => ({ ...value, presentationColor: nextValue }))
                }
              />
              <small>
                Catalogの標準色辞書へ正規化します。2色仕上げは「ブラック/ゴールド」のように /
                で区切れます。空欄は色なしとして固定します。
              </small>
              <small id="listing-color-error" role="status">
                {invalidColor ? "標準色として認識できません。色名を確認してください。" : ""}
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
            <AdminEditDiff rows={editChanges} />
            <div className="edit-impact">
              <strong>保存時の処理</strong>
              <p>検索結果に修正内容を反映します。次回の自動収集でも、この修正は保持されます。</p>
            </div>
            <div className="read-only-note">
              タイトル・価格・在庫・商品URLは販売店の一次情報として保持するため、この画面では変更できません。
            </div>
            <p className="edit-change-status" data-dirty={editDirty ? "true" : "false"}>
              {editDirty ? "未保存の変更があります。" : "変更すると保存できます。"}
            </p>
            {editError ? (
              <p role="alert" className="csv-import-error">
                {editError}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => closeEdit()}>
                キャンセル
              </button>
              <button type="submit" disabled={busy || saving || !editDirty || invalidColor}>
                {saving ? "保存中…" : "変更を保存"}
              </button>
            </div>
          </form>
        ) : null}
      </dialog>
    </section>
  );
}
