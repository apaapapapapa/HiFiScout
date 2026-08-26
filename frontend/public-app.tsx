/** Public catalog application rendered entirely through React components. */

import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createApiClient,
  isMetaResponse,
  isNonNegativeInteger,
  isProductDetailResponse,
  isProductHistoryResponse,
  isProductSearchItem,
  isProductsResponse,
} from "./api-client.js";
import { sanitizedCatalogUrl } from "./catalog-url-sanitizer.js";
import {
  DEFAULT_SORT,
  activeFilterEntries,
  filterUrlParams,
  parseUrlFilters,
  productSearchParams,
} from "./filters.js";
import { featureFromFilterId } from "./filters.js";
import type { ProductFilters, ProductView, ToggleId, UrlValueId } from "./filters.js";
import {
  FAVORITES_KEY,
  favoriteResults,
  favoriteSnapshot,
  favoriteStoragePayload,
  parseFavoriteStorage,
} from "./favorites.js";
import type { FavoriteStore } from "./favorites.js";
import { pageNumbers, resultSummary } from "./pagination.js";
import { syncStatusSummary } from "./product-presentation.js";
import {
  CategoryOptions,
  EmptyProducts,
  HistoryContent,
  LegacyFavoritesNotice,
  OffersContent,
  ProductCard,
  ProductError,
  SyncShopRows,
} from "./public-components.js";
import { SearchSuggestionInput } from "./search-suggestion-input.js";
import { sortShopsByJapaneseReading } from "./shop-options.js";
import { FEATURE_DEFINITIONS } from "../src/api/contracts.js";
import type { FeatureId, MetaResponse, MetaShop } from "../src/api/contracts.js";
import type {
  DisplayProduct,
  PageState,
  ProductDetailResponse,
  ProductHistoryResponse,
  ShopIndex,
} from "./types.js";

const VIEW_KEY = "hifiscout:view";
const MOBILE_QUERY = "(max-width: 640px)";
const DEBOUNCE_MS = 400;
const api = createApiClient();

type OffersState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; data: ProductDetailResponse }
  | null;
type HistoryState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; data: ProductHistoryResponse }
  | null;

function initialView(): ProductView {
  const parsed = parseUrlFilters(location.search);
  if (parsed.view) return parsed.view;
  return localStorage.getItem(VIEW_KEY) === "cards" ? "cards" : "list";
}

function filtersFromLocation(favoritesOnly = false): ProductFilters {
  const parsed = parseUrlFilters(location.search);
  return {
    ...parsed.values,
    features: parsed.features,
    inStock: parsed.inStock,
    favoritesOnly,
    recentOnly: parsed.recentOnly,
    priceDropped: parsed.priceDropped,
  };
}

function sanitizeAddressBar(): void {
  const nextUrl = sanitizedCatalogUrl(location.pathname, location.search, location.hash);
  if (nextUrl) history.replaceState(null, "", nextUrl);
}

sanitizeAddressBar();

function cloneFavorites(store: FavoriteStore): FavoriteStore {
  return { products: new Map(store.products), legacyIds: new Set(store.legacyIds) };
}

interface FilterPanelProps {
  filters: ProductFilters;
  meta: MetaResponse | null;
  favoriteCount: number;
  open: boolean;
  onValueChange: (id: UrlValueId, value: string, debounced?: boolean) => void;
  onToggleChange: (id: ToggleId, checked: boolean) => void;
  onFeatureChange: (feature: FeatureId, checked: boolean) => void;
  onClose: () => void;
  onClear: () => void;
}

function FilterPanel({
  filters,
  meta,
  favoriteCount,
  open,
  onValueChange,
  onToggleChange,
  onFeatureChange,
  onClose,
  onClear,
}: FilterPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const shops = useMemo(() => sortShopsByJapaneseReading(meta?.shops ?? []), [meta]);

  useEffect(() => {
    if (!panelRef.current) return;
    const mobile = window.matchMedia(MOBILE_QUERY).matches;
    panelRef.current.inert = mobile && !open;
    if (open) panelRef.current.querySelector<HTMLElement>("#filter-close")?.focus();
  }, [open]);

  return (
    <>
      <div id="filter-backdrop" className="filter-backdrop" hidden={!open} onClick={onClose} />
      <section
        ref={panelRef}
        id="filter-panel"
        className={`filters${open ? " open" : ""}`}
        aria-label="絞り込み条件"
      >
        <div className="filters-head">
          <strong>絞り込み</strong>
          <button
            id="filter-close"
            className="filter-close"
            type="button"
            aria-label="絞り込みを閉じる"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <label>
          <span>ショップ</span>
          <select
            id="shop"
            value={filters.shop}
            onChange={(event) => onValueChange("shop", event.currentTarget.value)}
          >
            <option value="">すべて</option>
            {shops.map((shop) => (
              <option key={shop.key} value={shop.key}>
                {shop.name}
                {isNonNegativeInteger(shop.activeProductCount)
                  ? ` (${shop.activeProductCount})`
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>メーカー</span>
          <input
            id="manufacturer"
            type="search"
            list="manufacturer-options"
            placeholder="メーカー名を入力"
            autoComplete="off"
            value={filters.manufacturer}
            onChange={(event) => onValueChange("manufacturer", event.currentTarget.value, true)}
          />
          <datalist id="manufacturer-options">
            {meta?.manufacturerFacets?.length
              ? meta.manufacturerFacets.map((facet) => (
                  <option
                    key={facet.name}
                    value={facet.name}
                    label={`${facet.name} (${facet.activeProductCount})`}
                  />
                ))
              : (meta?.manufacturers ?? []).map((value) => <option key={value} value={value} />)}
          </datalist>
        </label>
        <label>
          <span>カテゴリ</span>
          <select
            id="category"
            value={filters.category}
            onChange={(event) => onValueChange("category", event.currentTarget.value)}
          >
            <option value="">すべて</option>
            <CategoryOptions meta={meta} />
          </select>
        </label>
        <label>
          <span>最低価格</span>
          <input
            id="minPrice"
            inputMode="numeric"
            placeholder="0"
            value={filters.minPrice}
            onChange={(event) => onValueChange("minPrice", event.currentTarget.value, true)}
          />
        </label>
        <label>
          <span>最高価格</span>
          <input
            id="maxPrice"
            inputMode="numeric"
            placeholder="1000000"
            value={filters.maxPrice}
            onChange={(event) => onValueChange("maxPrice", event.currentTarget.value, true)}
          />
        </label>
        {/*
          Feature matching is a server-side predicate over stored facts. Favorites are matched
          locally against snapshots that carry none, so the control is disabled there rather than
          left to look applied while the results ignore it. The selection itself survives.
        */}
        <fieldset className="filter-features" disabled={filters.favoritesOnly}>
          <legend>機能</legend>
          {FEATURE_DEFINITIONS.map((feature) => (
            <label className="check" key={feature.id}>
              <input
                id={`feature-${feature.id}`}
                type="checkbox"
                checked={filters.features.includes(feature.id)}
                onChange={(event) => onFeatureChange(feature.id, event.currentTarget.checked)}
              />
              <span>{feature.name}</span>
            </label>
          ))}
          {filters.favoritesOnly ? (
            <p className="filter-note">お気に入り表示中は機能で絞り込めません</p>
          ) : null}
        </fieldset>
        <label className="check">
          <input
            id="inStock"
            type="checkbox"
            checked={filters.inStock}
            onChange={(event) => onToggleChange("inStock", event.currentTarget.checked)}
          />
          <span>在庫ありのみ</span>
        </label>
        <label className="check">
          <input
            id="recentOnly"
            type="checkbox"
            checked={filters.recentOnly}
            onChange={(event) => onToggleChange("recentOnly", event.currentTarget.checked)}
          />
          <span>48時間以内の新着</span>
        </label>
        <label className="check">
          <input
            id="priceDropped"
            type="checkbox"
            checked={filters.priceDropped}
            onChange={(event) => onToggleChange("priceDropped", event.currentTarget.checked)}
          />
          <span>値下げ商品</span>
        </label>
        <label className="check">
          <input
            id="favoritesOnly"
            type="checkbox"
            checked={filters.favoritesOnly}
            onChange={(event) => onToggleChange("favoritesOnly", event.currentTarget.checked)}
          />
          <span>
            お気に入りのみ <small id="favorites-count">({favoriteCount})</small>
          </span>
        </label>
        <div className="filter-actions">
          <button id="clear-filters" className="button-secondary" type="button" onClick={onClear}>
            すべて解除
          </button>
          <button id="apply-filters" className="button-primary" type="button" onClick={onClose}>
            結果を見る
          </button>
        </div>
      </section>
    </>
  );
}

function SyncStatus({ meta }: { meta: MetaResponse | null }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const sync = meta ? syncStatusSummary(meta) : null;
  return (
    <details
      ref={detailsRef}
      id="sync-status"
      className={`sync-status${sync ? ` ${sync.status}` : ""}`}
    >
      <summary>
        <span className="sync-indicator" aria-hidden="true" />
        <span id="sync-summary-text">{sync?.summary ?? "同期状況を取得中…"}</span>
        <span
          aria-hidden="true"
          style={{ fontSize: 10, fontWeight: 600, color: "#8a867e", whiteSpace: "nowrap" }}
        >
          詳細 ▾
        </span>
      </summary>
      <div id="sync-status-details" className="sync-status-details">
        <SyncShopRows meta={meta} />
      </div>
      <button
        id="sync-status-close"
        type="button"
        aria-label="同期状況を閉じる"
        title="閉じる"
        style={{
          position: "absolute",
          right: 8,
          top: "calc(100% + 12px)",
          zIndex: 16,
          width: 32,
          height: 32,
          border: 0,
          borderRadius: 8,
          background: "#fff",
          color: "#555",
          fontSize: 22,
          lineHeight: 1,
          cursor: "pointer",
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          detailsRef.current?.removeAttribute("open");
          detailsRef.current?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
        }}
      >
        ×
      </button>
    </details>
  );
}

function App() {
  const [filters, setFilters] = useState<ProductFilters>(() => filtersFromLocation());
  const filtersRef = useRef(filters);
  const [view, setView] = useState<ProductView>(initialView);
  const viewRef = useRef(view);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [shops, setShops] = useState<ShopIndex>({});
  const [products, setProducts] = useState<DisplayProduct[]>([]);
  const [favorites, setFavorites] = useState<FavoriteStore>(() =>
    parseFavoriteStorage(localStorage.getItem(FAVORITES_KEY), isProductSearchItem),
  );
  const favoritesRef = useRef(favorites);
  const pagesRef = useRef(new Map<number, PageState>());
  const [currentPage, setCurrentPage] = useState(1);
  const currentPageRef = useRef(1);
  const [totalPages, setTotalPages] = useState(0);
  const totalPagesRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  const [offersState, setOffersState] = useState<OffersState>(null);
  const [historyState, setHistoryState] = useState<HistoryState>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const bootedRef = useRef(false);
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const productsRef = useRef<HTMLElement>(null);
  const offersDialogRef = useRef<HTMLDialogElement>(null);
  const historyDialogRef = useRef<HTMLDialogElement>(null);

  const shopName = useCallback((key: string) => shops[key]?.name || key || "ショップ不明", [shops]);
  const favoriteCount = favorites.products.size + favorites.legacyIds.size;

  const selectedCategoryLabel = useMemo(() => {
    if (!filters.category || !meta) return "";
    return (
      meta.categoryFacets?.find((facet) => facet.id === filters.category)?.name ??
      meta.categories?.find((category) => category === filters.category) ??
      filters.category
    );
  }, [filters.category, meta]);

  const persistFavorites = useCallback((next: FavoriteStore) => {
    favoritesRef.current = next;
    setFavorites(next);
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favoriteStoragePayload(next)));
    } catch (error) {
      console.error("Failed to save favorites", error);
    }
  }, []);

  const refreshFavoriteSnapshots = useCallback(
    (items: DisplayProduct[]) => {
      const current = favoritesRef.current;
      let next: FavoriteStore | null = null;
      for (const product of items) {
        if (!current.products.has(product.key)) continue;
        next ??= cloneFavorites(current);
        next.products.set(product.key, favoriteSnapshot(product));
      }
      if (next) persistFavorites(next);
    },
    [persistFavorites],
  );

  const syncUrl = useCallback(
    (nextFilters: ProductFilters, nextView: ProductView, replace = false) => {
      if (!bootedRef.current) return;
      const nextSearch = filterUrlParams(nextFilters, nextView).toString();
      const next = `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}${location.hash}`;
      const current = `${location.pathname}${location.search}${location.hash}`;
      if (next === current) return;
      if (replace) history.replaceState(null, "", next);
      else history.pushState(null, "", next);
    },
    [],
  );

  const resetPages = useCallback(() => {
    pagesRef.current.clear();
    currentPageRef.current = 1;
    totalPagesRef.current = 0;
    setCurrentPage(1);
    setTotalPages(0);
    setProducts([]);
  }, []);

  const loadProducts = useCallback(
    async (
      nextFilters: ProductFilters,
      { page = 1, reset = false }: { page?: number; reset?: boolean } = {},
    ) => {
      if (nextFilters.favoritesOnly) {
        controllerRef.current?.abort();
        setLoading(false);
        setErrorMessage("");
        return;
      }
      if (reset) resetPages();
      if (!reset && totalPagesRef.current > 0 && page > totalPagesRef.current) return;

      const cachedPage = pagesRef.current.get(page);
      if (cachedPage) {
        currentPageRef.current = page;
        setCurrentPage(page);
        setProducts(cachedPage.items);
        refreshFavoriteSnapshots(cachedPage.items);
        setErrorMessage("");
        return;
      }

      const previousPage = page > 1 ? pagesRef.current.get(page - 1) : null;
      const cursor =
        previousPage?.hasMore && previousPage.nextCursor ? previousPage.nextCursor : null;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const sequence = ++requestSequenceRef.current;
      const params = productSearchParams(nextFilters, {
        cursor,
        page: cursor ? 1 : page,
        includeTotal: totalPagesRef.current === 0,
      });
      setLoading(true);
      setErrorMessage("");

      try {
        const result = await api.fetchJson(`/api/product-search?${params}`, {
          signal: controller.signal,
        });
        if (sequence !== requestSequenceRef.current) return;
        if (!isProductsResponse(result))
          throw new TypeError("Unexpected /api/product-search payload");
        if (isNonNegativeInteger(result.totalPages)) {
          totalPagesRef.current = result.totalPages;
          setTotalPages(result.totalPages);
        }
        const pageState: PageState = {
          items: result.items,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        };
        pagesRef.current.set(page, pageState);
        currentPageRef.current = page;
        setCurrentPage(page);
        setProducts(pageState.items);
        refreshFavoriteSnapshots(pageState.items);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "AbortError") {
          console.error(error);
          if (page === 1) resetPages();
          setErrorMessage("商品の取得に失敗しました。");
        }
      } finally {
        if (sequence === requestSequenceRef.current) setLoading(false);
      }
    },
    [refreshFavoriteSnapshots, resetPages],
  );

  const commitFilters = useCallback(
    (next: ProductFilters, replace = false) => {
      if (inputTimerRef.current) {
        clearTimeout(inputTimerRef.current);
        inputTimerRef.current = null;
      }
      filtersRef.current = next;
      setFilters(next);
      syncUrl(next, viewRef.current, replace);
      void loadProducts(next, { reset: true });
    },
    [loadProducts, syncUrl],
  );

  const changeValue = useCallback(
    (id: UrlValueId, value: string, debounced = false) => {
      const next = { ...filtersRef.current, [id]: value };
      filtersRef.current = next;
      setFilters(next);
      if (inputTimerRef.current) clearTimeout(inputTimerRef.current);
      if (debounced) {
        inputTimerRef.current = setTimeout(() => {
          inputTimerRef.current = null;
          syncUrl(next, viewRef.current, true);
          void loadProducts(next, { reset: true });
        }, DEBOUNCE_MS);
        return;
      }
      inputTimerRef.current = null;
      syncUrl(next, viewRef.current);
      void loadProducts(next, { reset: true });
    },
    [loadProducts, syncUrl],
  );

  const changeToggle = useCallback(
    (id: ToggleId, checked: boolean) => {
      commitFilters({ ...filtersRef.current, [id]: checked });
    },
    [commitFilters],
  );

  const changeFeature = useCallback(
    (feature: FeatureId, checked: boolean) => {
      const current = filtersRef.current.features;
      const features = checked
        ? [...new Set([...current, feature])]
        : current.filter((selected) => selected !== feature);
      commitFilters({ ...filtersRef.current, features });
    },
    [commitFilters],
  );

  const clearFilter = useCallback(
    (id: string) => {
      const next = { ...filtersRef.current };
      const feature = featureFromFilterId(id);
      if (feature) next.features = next.features.filter((selected) => selected !== feature);
      else if (
        id === "inStock" ||
        id === "favoritesOnly" ||
        id === "recentOnly" ||
        id === "priceDropped"
      )
        next[id] = false;
      else if (
        id === "q" ||
        id === "shop" ||
        id === "manufacturer" ||
        id === "category" ||
        id === "minPrice" ||
        id === "maxPrice"
      )
        next[id] = "";
      commitFilters(next);
    },
    [commitFilters],
  );

  const clearAllFilters = useCallback(() => {
    const next: ProductFilters = {
      q: "",
      shop: "",
      manufacturer: "",
      category: "",
      minPrice: "",
      maxPrice: "",
      sort: filtersRef.current.sort || DEFAULT_SORT,
      features: [],
      inStock: false,
      favoritesOnly: false,
      recentOnly: false,
      priceDropped: false,
    };
    setFilterOpen(false);
    commitFilters(next);
  }, [commitFilters]);

  const toggleFavorite = useCallback(
    (key: string) => {
      const next = cloneFavorites(favoritesRef.current);
      if (next.products.has(key)) next.products.delete(key);
      else {
        const product =
          products.find((candidate) => candidate.key === key) ??
          favoritesRef.current.products.get(key);
        if (product) next.products.set(product.key, favoriteSnapshot(product));
      }
      persistFavorites(next);
    },
    [persistFavorites, products],
  );

  const showOffers = useCallback(async (key: string) => {
    setOffersState({ kind: "loading" });
    try {
      const data = await api.fetchJson(`/api/product-search/${encodeURIComponent(key)}`);
      if (!isProductDetailResponse(data)) throw new TypeError("Unexpected product detail payload");
      setOffersState({ kind: "ready", data });
    } catch (error) {
      console.error(error);
      setOffersState({ kind: "error" });
    }
  }, []);

  const showHistory = useCallback(async (listingId: number) => {
    setHistoryState({ kind: "loading" });
    try {
      const data = await api.fetchJson(`/api/products/${listingId}/history`);
      if (!isProductHistoryResponse(data)) throw new TypeError("Unexpected history payload");
      setHistoryState({ kind: "ready", data });
    } catch (error) {
      console.error(error);
      setHistoryState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    if (offersState !== null && offersDialogRef.current && !offersDialogRef.current.open)
      offersDialogRef.current.showModal();
  }, [offersState]);
  useEffect(() => {
    if (historyState !== null && historyDialogRef.current && !historyDialogRef.current.open)
      historyDialogRef.current.showModal();
  }, [historyState]);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => {
      setIsMobile(query.matches);
      if (!query.matches) setFilterOpen(false);
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("filters-open", isMobile && filterOpen);
    return () => document.body.classList.remove("filters-open");
  }, [filterOpen, isMobile]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && filterOpen) setFilterOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filterOpen]);

  useEffect(() => {
    const onPopState = () => {
      const next = filtersFromLocation(filtersRef.current.favoritesOnly);
      const parsed = parseUrlFilters(location.search);
      const nextView = parsed.view ?? viewRef.current;
      filtersRef.current = next;
      setFilters(next);
      viewRef.current = nextView;
      setView(nextView);
      localStorage.setItem(VIEW_KEY, nextView);
      void loadProducts(next, { reset: true });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadProducts]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.fetchJson("/api/meta");
        if (!isMetaResponse(result)) throw new TypeError("Unexpected /api/meta payload");
        if (cancelled) return;
        setMeta(result);
        setShops(
          Object.fromEntries(result.shops.map((shop): [string, MetaShop] => [shop.key, shop])),
        );

        const current = filtersFromLocation(false);
        const validShops = new Set(result.shops.map((shop) => shop.key));
        const validCategories = new Set([
          ...(result.categoryFacets ?? []).map((facet) => facet.id),
          ...(result.categories ?? []),
        ]);
        if (current.shop && !validShops.has(current.shop)) current.shop = "";
        if (current.category && !validCategories.has(current.category)) current.category = "";
        filtersRef.current = current;
        setFilters(current);
        const nextView = initialView();
        viewRef.current = nextView;
        setView(nextView);
        localStorage.setItem(VIEW_KEY, nextView);
        bootedRef.current = true;
        syncUrl(current, nextView, true);
        await loadProducts(current, { reset: true });
      } catch (error) {
        console.error("Failed to initialize application", error);
        if (!cancelled) setErrorMessage("商品の取得に失敗しました。");
      }
    })();
    return () => {
      cancelled = true;
      controllerRef.current?.abort();
      if (inputTimerRef.current) clearTimeout(inputTimerRef.current);
    };
  }, [loadProducts, syncUrl]);

  const favoriteMode = filters.favoritesOnly;
  const visibleProducts = useMemo(
    () => (favoriteMode ? favoriteResults(favorites, filters, selectedCategoryLabel) : products),
    [favoriteMode, favorites, filters, products, selectedCategoryLabel],
  );
  const summary = resultSummary({
    shown: visibleProducts.length,
    favoriteMode,
    currentPage,
    totalPages,
    errorMessage,
  });
  const activeFilters = activeFilterEntries(filters, {
    shop: shopName(filters.shop),
    category: selectedCategoryLabel,
  });
  const detailFilterCount = activeFilters.filter((entry) => entry.detail).length;

  const changeView = useCallback(
    (nextView: ProductView) => {
      viewRef.current = nextView;
      setView(nextView);
      localStorage.setItem(VIEW_KEY, nextView);
      syncUrl(filtersRef.current, nextView);
    },
    [syncUrl],
  );

  const gotoPage = useCallback(
    (page: number) => {
      if (loading || page <= 0 || page > totalPagesRef.current || page === currentPageRef.current)
        return;
      void loadProducts(filtersRef.current, { page }).then(() =>
        productsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }),
      );
    },
    [loadProducts, loading],
  );

  return (
    <>
      <header className="hero">
        <div>
          <p className="eyebrow">USED AUDIO SEARCH</p>
          <a className="brand-home" href="/" aria-label="HiFiScout トップページへ">
            <h1>HiFiScout</h1>
          </a>
          <p className="lead">中古オーディオを、ショップをまたいで探す。</p>
        </div>
        <SyncStatus meta={meta} />
      </header>

      <main>
        <section className="search-shell" aria-label="商品検索">
          <label className="search-primary" htmlFor="q">
            <span>検索</span>
            <div className="search-row">
              <SearchSuggestionInput
                api={api}
                value={filters.q}
                onValueChange={(value, debounced) => changeValue("q", value, debounced)}
              />
              <button
                id="filter-toggle"
                className="filter-toggle"
                type="button"
                aria-controls="filter-panel"
                aria-expanded={filterOpen}
                onClick={() => {
                  if (isMobile) setFilterOpen(true);
                }}
              >
                絞り込み{" "}
                <span id="filter-count" className="filter-count" hidden={detailFilterCount === 0}>
                  {detailFilterCount}
                </span>
              </button>
            </div>
          </label>
        </section>

        <FilterPanel
          filters={filters}
          meta={meta}
          favoriteCount={favoriteCount}
          open={filterOpen}
          onValueChange={changeValue}
          onToggleChange={changeToggle}
          onFeatureChange={changeFeature}
          onClose={() => setFilterOpen(false)}
          onClear={clearAllFilters}
        />

        <div id="active-filters" className="active-filters" aria-live="polite">
          {activeFilters.length ? (
            <>
              {activeFilters.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="filter-chip"
                  data-clear-filter={entry.id}
                  aria-label={`${entry.label}を解除`}
                  onClick={() => clearFilter(entry.id)}
                >
                  {entry.label} <span aria-hidden="true">×</span>
                </button>
              ))}
              <button type="button" className="clear-all" data-clear-all onClick={clearAllFilters}>
                すべて解除
              </button>
            </>
          ) : (
            <span className="no-filters">絞り込み条件なし</span>
          )}
        </div>

        <div className="result-header">
          <div className="result-count">
            <strong id="count">{summary.count}</strong>
            <span id="count-label">{summary.label}</span>
            <span id="more-available" className="more-available" hidden={summary.moreHidden}>
              さらに商品があります
            </span>
          </div>
          <span
            id="loading"
            className={`loading${loading ? " show" : ""}`}
            role="status"
            aria-live="polite"
          >
            更新中
          </span>
          <div className="result-tools">
            <label className="sort-control">
              <span>並び順</span>
              <select
                id="sort"
                value={filters.sort}
                onChange={(event) => changeValue("sort", event.currentTarget.value)}
              >
                <option value="newest">新着・更新順</option>
                <option value="oldest">更新が古い順</option>
                <option value="priceAsc">価格が安い順</option>
                <option value="priceDesc">価格が高い順</option>
              </select>
            </label>
            <div className="view-switch" role="group" aria-label="表示形式">
              <button
                type="button"
                data-view="list"
                aria-label="リスト表示"
                className={view === "list" ? "active" : ""}
                aria-pressed={view === "list"}
                onClick={() => changeView("list")}
              >
                リスト
              </button>
              <button
                type="button"
                data-view="cards"
                aria-label="カード表示"
                className={view === "cards" ? "active" : ""}
                aria-pressed={view === "cards"}
                onClick={() => changeView("cards")}
              >
                カード
              </button>
            </div>
          </div>
        </div>

        <p id="favorites-note" className="favorites-note" hidden={!favoriteMode}>
          お気に入りはこの端末にのみ保存されます。価格や在庫は最後に表示した時点の情報です。
        </p>
        <section
          ref={productsRef}
          id="products"
          className={`products view-${view}`}
          aria-live="polite"
        >
          {errorMessage ? (
            <ProductError
              message={errorMessage}
              onRetry={() => void loadProducts(filtersRef.current, { reset: true })}
            />
          ) : (
            <>
              {favoriteMode ? <LegacyFavoritesNotice count={favorites.legacyIds.size} /> : null}
              {visibleProducts.length ? (
                visibleProducts.map((product) => (
                  <ProductCard
                    key={product.key}
                    product={product}
                    favorite={favorites.products.has(product.key)}
                    shopName={shopName}
                    onManufacturer={(manufacturer) => changeValue("manufacturer", manufacturer)}
                    onFavorite={toggleFavorite}
                    onOffers={(key) => void showOffers(key)}
                  />
                ))
              ) : (
                <EmptyProducts
                  favoriteMode={favoriteMode}
                  hasFavorites={favoriteCount > 0}
                  onClear={clearAllFilters}
                />
              )}
            </>
          )}
        </section>

        <nav id="pagination" className="pagination" aria-label="商品一覧のページ">
          {!favoriteMode && pagesRef.current.size > 0 && totalPages > 1
            ? pageNumbers(currentPage, totalPages).map((page, index, numbers) => (
                <span key={page}>
                  {index > 0 && page - numbers[index - 1] > 1 ? (
                    <span className="page-ellipsis" aria-hidden="true">
                      …
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className={`page-button${page === currentPage ? " active" : ""}`}
                    data-page={page}
                    aria-label={`${page}ページ目`}
                    aria-current={page === currentPage ? "page" : undefined}
                    disabled={loading}
                    onClick={() => gotoPage(page)}
                  >
                    {page}
                  </button>
                </span>
              ))
            : null}
        </nav>
      </main>

      <dialog
        ref={offersDialogRef}
        id="offers-dialog"
        aria-labelledby="offers-title"
        onClose={() => setOffersState(null)}
      >
        <button
          className="dialog-close"
          aria-label="閉じる"
          onClick={() => offersDialogRef.current?.close()}
        >
          ×
        </button>
        <div id="offers-content">
          <OffersContent
            state={offersState}
            shopName={shopName}
            onHistory={(listingId) => void showHistory(listingId)}
          />
        </div>
      </dialog>

      <dialog
        ref={historyDialogRef}
        id="history-dialog"
        aria-labelledby="history-title"
        onClose={() => setHistoryState(null)}
      >
        <button
          className="dialog-close"
          aria-label="閉じる"
          onClick={() => historyDialogRef.current?.close()}
        >
          ×
        </button>
        <div id="history-content">
          <HistoryContent state={historyState} />
        </div>
      </dialog>

      <footer>
        <p>
          HiFiScout
          は各販売店とは関係のない非公式の横断検索ツールです。価格・在庫・商品状態は必ず販売店の商品ページで確認してください。
        </p>
        <p>商品画像・販売店の商品説明文・スタッフコメントは保存・転載しません。</p>
      </footer>
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("React root is missing");
createRoot(root).render(<App />);
