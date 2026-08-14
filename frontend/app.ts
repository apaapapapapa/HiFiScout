/**
 * Catalog page: application state, DOM wiring and bootstrap.
 *
 * Everything deterministic — filter serialization, URL state, pagination arithmetic, favorites
 * matching, activity derivation and markup — lives in the sibling modules and is unit-tested in
 * Node. What remains here is the part that genuinely needs a browser: reading controls, writing
 * `innerHTML`, request sequencing and event delegation.
 */

import {
  createApiClient,
  isMetaResponse,
  isNonNegativeInteger,
  isProductHistoryResponse,
  isProductsResponse,
} from "./api-client.js";
import {
  $,
  $dialog,
  $field,
  $input,
  $select,
  closestButton,
  closestElement,
  eventElement,
} from "./dom.js";
import {
  DEFAULT_SORT,
  TOGGLE_IDS,
  URL_VALUE_IDS,
  activeFilterEntries,
  filterUrlParams,
  parseUrlFilters,
  productSearchParams,
} from "./filters.js";
import type { ProductFilters, ProductView } from "./filters.js";
import {
  FAVORITES_KEY,
  favoriteResults,
  favoriteSnapshot,
  favoriteStoragePayload,
  parseFavoriteStorage,
} from "./favorites.js";
import type { FavoriteStore } from "./favorites.js";
import { escapeHtml } from "./format.js";
import { pageNumbers, resultSummary } from "./pagination.js";
import {
  categoryOptions,
  emptyState,
  errorState,
  legacyFavoritesNotice,
  paginationMarkup,
  priceHistoryErrorMarkup,
  priceHistoryMarkup,
  productCard,
  syncShopRows,
  syncStatusSummary,
} from "./product-view.js";
import type { MetaResponse, MetaShop } from "../src/api/contracts.js";
import type { DisplayProduct, PageState, ShopIndex } from "./types.js";

interface AppState {
  products: DisplayProduct[];
  favorites: FavoriteStore;
  pages: Map<number, PageState>;
  currentPage: number;
  totalPages: number;
  totalItems: number | null;
  controller: AbortController | null;
  requestSequence: number;
  loading: boolean;
  view: ProductView;
  applyingUrl: boolean;
  booted: boolean;
}

const debouncedInputIds = ["q", "minPrice", "maxPrice"];
const filterChangeIds = [
  "shop",
  "manufacturer",
  "category",
  "sort",
  "inStock",
  "favoritesOnly",
  "recentOnly",
  "priceDropped",
];
const VIEW_KEY = "hifiscout:view";
const MOBILE_QUERY = "(max-width: 640px)";

const storedView = localStorage.getItem(VIEW_KEY);
const state: AppState = {
  products: [],
  favorites: parseFavoriteStorage(localStorage.getItem(FAVORITES_KEY)),
  pages: new Map(),
  currentPage: 1,
  totalPages: 0,
  totalItems: null,
  controller: null,
  requestSequence: 0,
  loading: false,
  view: storedView === "cards" ? "cards" : "list",
  applyingUrl: false,
  booted: false,
};

const api = createApiClient();
let shops: ShopIndex = {};

function shopName(key: string | null): string {
  return shops[key ?? ""]?.name || key || "ショップ不明";
}

/** Single read of the filter controls; every pure helper takes the result rather than the DOM. */
function readFilters(): ProductFilters {
  const values = Object.fromEntries(
    URL_VALUE_IDS.map((id) => [id, $field(id).value.trim()]),
  ) as Record<(typeof URL_VALUE_IDS)[number], string>;
  const toggles = Object.fromEntries(TOGGLE_IDS.map((id) => [id, $input(id).checked])) as Record<
    (typeof TOGGLE_IDS)[number],
    boolean
  >;
  return { ...values, ...toggles };
}

function selectedCategoryLabel(): string {
  const option = $select("category").selectedOptions?.[0];
  return option?.value ? (option.textContent?.trim() ?? "") : "";
}

function isFavorite(id: number | string | null): boolean {
  return state.favorites.products.has(Number(id)) || state.favorites.legacyIds.has(Number(id));
}

function favoriteCount(): number {
  return state.favorites.products.size + state.favorites.legacyIds.size;
}

function saveFavorites(): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favoriteStoragePayload(state.favorites)));
  } catch (error) {
    console.error("Failed to save favorites", error);
  }
  updateFavoriteCount();
}

function updateFavoriteCount(): void {
  $("favorites-count").textContent = `(${favoriteCount()})`;
}

/** Upgrades legacy id-only favorites to full snapshots as their products reappear in a listing. */
function refreshFavoriteSnapshots(products: DisplayProduct[]): void {
  let changed = false;
  for (const product of products) {
    const id = Number(product.id);
    if (!isFavorite(id)) continue;
    state.favorites.legacyIds.delete(id);
    state.favorites.products.set(id, favoriteSnapshot(product));
    changed = true;
  }
  if (changed) saveFavorites();
}

function renderSyncStatus(meta: MetaResponse): void {
  const { status, summary } = syncStatusSummary(meta);
  $("sync-status").classList.remove("healthy", "warning", "critical");
  $("sync-status").classList.add(status);
  $("sync-summary-text").textContent = summary;
  $("sync-status-details").innerHTML = syncShopRows(meta.shops || []);
}

async function loadMeta(): Promise<void> {
  const meta = await api.fetchJson("/api/meta");
  if (!isMetaResponse(meta)) throw new TypeError("Unexpected /api/meta payload");
  shops = Object.fromEntries(meta.shops.map((shop): [string, MetaShop] => [shop.key, shop]));
  $("shop").insertAdjacentHTML(
    "beforeend",
    meta.shops
      .map((shop) => `<option value="${escapeHtml(shop.key)}">${escapeHtml(shop.name)}</option>`)
      .join(""),
  );
  $("manufacturer-options").innerHTML = meta.manufacturers
    .map((value) => `<option value="${escapeHtml(value)}"></option>`)
    .join("");
  $("category").insertAdjacentHTML("beforeend", categoryOptions(meta));
  renderSyncStatus(meta);
}

function syncUrl({ replace = false }: { replace?: boolean } = {}): void {
  if (!state.booted || state.applyingUrl) return;
  const nextSearch = filterUrlParams(readFilters(), state.view).toString();
  const next = `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}${location.hash}`;
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (next === current) return;
  if (replace) history.replaceState(null, "", next);
  else history.pushState(null, "", next);
}

/** A `<select>` silently ignores an unknown value, so fall back to "all" rather than keep it. */
function setSelectValue(id: string, value: string): void {
  const select = $select(id);
  select.value = value;
  if (value && select.value !== value) select.value = "";
}

function applyUrlState(): void {
  const parsed = parseUrlFilters(location.search);
  state.applyingUrl = true;
  $input("q").value = parsed.values.q;
  setSelectValue("shop", parsed.values.shop);
  $input("manufacturer").value = parsed.values.manufacturer;
  setSelectValue("category", parsed.values.category);
  $input("minPrice").value = parsed.values.minPrice;
  $input("maxPrice").value = parsed.values.maxPrice;
  setSelectValue("sort", parsed.values.sort || DEFAULT_SORT);
  $input("inStock").checked = parsed.inStock;
  $input("recentOnly").checked = parsed.recentOnly;
  $input("priceDropped").checked = parsed.priceDropped;
  if (parsed.view) {
    state.view = parsed.view;
    localStorage.setItem(VIEW_KEY, parsed.view);
  }
  state.applyingUrl = false;
}

function resetPages(): void {
  state.pages.clear();
  state.currentPage = 1;
  state.totalPages = 0;
  state.totalItems = null;
  state.products = [];
}

function setLoading(loading: boolean): void {
  state.loading = loading;
  $("loading").classList.toggle("show", loading);
  renderPagination();
}

function renderPagination(): void {
  if ($input("favoritesOnly").checked || !state.pages.size || state.totalPages <= 1) {
    $("pagination").innerHTML = "";
    return;
  }
  $("pagination").innerHTML = paginationMarkup(
    pageNumbers(state.currentPage, state.totalPages),
    state.currentPage,
    state.loading,
  );
}

async function loadProducts({
  page = 1,
  reset = false,
}: { page?: number; reset?: boolean } = {}): Promise<void> {
  if ($input("favoritesOnly").checked) {
    render();
    return;
  }
  if (reset) resetPages();
  if (state.totalPages > 0 && page > state.totalPages) return;
  const cachedPage = state.pages.get(page);
  if (cachedPage) {
    state.currentPage = page;
    state.products = cachedPage.items;
    refreshFavoriteSnapshots(state.products);
    render();
    return;
  }

  // Resuming from the previous page's cursor keeps keyset pagination stable under inserts.
  const previousPage = page > 1 ? state.pages.get(page - 1) : null;
  const cursor = previousPage?.hasMore && previousPage.nextCursor ? previousPage.nextCursor : null;

  state.controller?.abort();
  state.controller = new AbortController();
  const controller = state.controller;
  const sequence = ++state.requestSequence;
  const params = productSearchParams(readFilters(), {
    cursor,
    page: cursor ? 1 : page,
    includeTotal: state.totalPages === 0,
  });
  setLoading(true);

  try {
    const result = await api.fetchJson(`/api/products?${params}`, { signal: controller.signal });
    if (sequence !== state.requestSequence) return;
    if (!isProductsResponse(result)) throw new TypeError("Unexpected /api/products payload");

    if (isNonNegativeInteger(result.totalPages)) state.totalPages = result.totalPages;
    if (isNonNegativeInteger(result.totalCount)) state.totalItems = result.totalCount;
    const pageState: PageState = {
      items: result.items,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
    };
    state.pages.set(page, pageState);
    state.currentPage = page;
    state.products = pageState.items;
    refreshFavoriteSnapshots(state.products);
    render();
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      console.error(error);
      if (page === 1) resetPages();
      render("商品の取得に失敗しました。");
    }
  } finally {
    if (sequence === state.requestSequence) setLoading(false);
  }
}

function renderActiveFilters(): void {
  const entries = activeFilterEntries(readFilters(), {
    shop: shopName($select("shop").value.trim()),
    category: selectedCategoryLabel(),
  });
  $("active-filters").innerHTML = entries.length
    ? `${entries.map((entry) => `<button type="button" class="filter-chip" data-clear-filter="${entry.id}" aria-label="${escapeHtml(entry.label)}を解除">${escapeHtml(entry.label)} <span aria-hidden="true">×</span></button>`).join("")}<button type="button" class="clear-all" data-clear-all>すべて解除</button>`
    : '<span class="no-filters">絞り込み条件なし</span>';
  const detailCount = entries.filter((entry) => entry.detail).length;
  $("filter-count").textContent = String(detailCount);
  $("filter-count").hidden = detailCount === 0;
}

function clearFilter(id: string): void {
  if ((TOGGLE_IDS as readonly string[]).includes(id)) $input(id).checked = false;
  else $field(id).value = "";
  commitFilterChange(id);
}

function clearAllFilters(): void {
  for (const id of URL_VALUE_IDS) if (id !== "sort") $field(id).value = "";
  for (const id of TOGGLE_IDS) $input(id).checked = false;
  renderActiveFilters();
  closeFilters();
  syncUrl();
  loadProducts({ reset: true });
}

function renderView(): void {
  $("products").classList.toggle("view-list", state.view === "list");
  $("products").classList.toggle("view-cards", state.view === "cards");
  for (const button of document.querySelectorAll("[data-view]")) {
    if (!(button instanceof HTMLElement)) continue;
    const active = button.dataset.view === state.view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function render(errorMessage = ""): void {
  const filters = readFilters();
  const favoriteMode = filters.favoritesOnly;
  const products = favoriteMode
    ? favoriteResults(state.favorites, filters, selectedCategoryLabel())
    : state.products;
  const summary = resultSummary({
    shown: products.length,
    favoriteMode,
    currentPage: state.currentPage,
    totalPages: state.totalPages,
    errorMessage,
  });
  $("count").textContent = summary.count;
  $("count-label").textContent = summary.label;
  $("more-available").hidden = summary.moreHidden;
  $("favorites-note").hidden = !favoriteMode;
  const legacyNotice = favoriteMode ? legacyFavoritesNotice(state.favorites.legacyIds.size) : "";
  const cards = products
    .map((product) =>
      productCard(product, {
        favorite: isFavorite(product.id),
        shopName: shopName(product.shop_key),
      }),
    )
    .join("");
  $("products").innerHTML = errorMessage
    ? errorState(errorMessage)
    : `${legacyNotice}${products.length ? cards : emptyState(favoriteMode, favoriteCount() > 0)}`;
  renderActiveFilters();
  renderView();
  renderPagination();
}

async function showHistory(id: string): Promise<void> {
  try {
    const data = await api.fetchJson(`/api/products/${id}/history`);
    if (!isProductHistoryResponse(data)) throw new TypeError("Unexpected history payload");
    $("history-content").innerHTML = priceHistoryMarkup(data.product, data.history);
    $dialog("history-dialog").showModal();
  } catch (error) {
    console.error(error);
    $("history-content").innerHTML = priceHistoryErrorMarkup();
    $dialog("history-dialog").showModal();
  }
}

function commitFilterChange(id: string): void {
  renderActiveFilters();
  // Typing replaces the current history entry; discrete choices push a new one.
  syncUrl({ replace: debouncedInputIds.includes(id) });
  if (id === "favoritesOnly" && $input("favoritesOnly").checked) {
    state.controller?.abort();
    setLoading(false);
    render();
    return;
  }
  if ($input("favoritesOnly").checked) {
    render();
    return;
  }
  loadProducts({ reset: true });
}

function isMobileLayout(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function openFilters(): void {
  if (!isMobileLayout()) return;
  $("filter-panel").classList.add("open");
  $("filter-backdrop").hidden = false;
  $("filter-toggle").setAttribute("aria-expanded", "true");
  document.body.classList.add("filters-open");
  $("filter-panel").removeAttribute("inert");
  $("filter-close").focus();
}

function closeFilters(): void {
  $("filter-panel").classList.remove("open");
  $("filter-backdrop").hidden = true;
  $("filter-toggle").setAttribute("aria-expanded", "false");
  document.body.classList.remove("filters-open");
  // Off-canvas on mobile: `inert` keeps the hidden panel out of the tab order.
  if (isMobileLayout()) $("filter-panel").setAttribute("inert", "");
  else $("filter-panel").removeAttribute("inert");
}

function syncFilterPanelMode(): void {
  if (isMobileLayout()) {
    if (!$("filter-panel").classList.contains("open")) $("filter-panel").setAttribute("inert", "");
    return;
  }
  $("filter-panel").removeAttribute("inert");
  $("filter-panel").classList.remove("open");
  $("filter-backdrop").hidden = true;
  $("filter-toggle").setAttribute("aria-expanded", "false");
  document.body.classList.remove("filters-open");
}

function toggleFavorite(id: number): void {
  if (isFavorite(id)) {
    state.favorites.products.delete(id);
    state.favorites.legacyIds.delete(id);
  } else {
    const product =
      state.products.find((candidate) => Number(candidate.id) === id) ||
      state.favorites.products.get(id);
    if (product) state.favorites.products.set(id, favoriteSnapshot(product));
  }
  saveFavorites();
  render();
}

let inputTimer: ReturnType<typeof setTimeout> | undefined;
document.addEventListener("input", (event) => {
  const target = eventElement(event);
  if (!target || !debouncedInputIds.includes(target.id)) return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => commitFilterChange(target.id), 400);
});

document.addEventListener("change", (event) => {
  const target = eventElement(event);
  if (target && filterChangeIds.includes(target.id)) commitFilterChange(target.id);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("filter-panel").classList.contains("open")) closeFilters();
});

document.addEventListener("click", (event) => {
  const target = eventElement(event);
  if (!target) return;

  const favoriteButton = closestElement(target, "[data-fav]");
  if (favoriteButton) {
    toggleFavorite(Number(favoriteButton.dataset.fav));
    return;
  }

  const history = closestElement(target, "[data-history]");
  if (history) {
    showHistory(history.dataset.history ?? "");
    return;
  }

  const clearChip = closestElement(target, "[data-clear-filter]");
  if (clearChip) {
    clearFilter(clearChip.dataset.clearFilter ?? "");
    return;
  }

  if (target.closest("[data-clear-all]") || target.id === "clear-filters") {
    clearAllFilters();
    return;
  }

  if (target.closest("[data-retry]")) {
    loadProducts({ reset: true });
    return;
  }

  const viewButton = closestElement(target, "[data-view]");
  if (viewButton) {
    state.view = viewButton.dataset.view === "cards" ? "cards" : "list";
    localStorage.setItem(VIEW_KEY, state.view);
    renderView();
    syncUrl();
    return;
  }

  if (target.matches(".dialog-close")) {
    $dialog("history-dialog").close();
    return;
  }
  if (target.id === "filter-toggle") {
    openFilters();
    return;
  }
  if (
    target.id === "filter-close" ||
    target.id === "filter-backdrop" ||
    target.id === "apply-filters"
  ) {
    closeFilters();
    return;
  }

  const pageButton = closestButton(target, "[data-page]");
  if (pageButton && !pageButton.disabled) {
    const page = Number(pageButton.dataset.page);
    if (
      Number.isInteger(page) &&
      page > 0 &&
      page <= state.totalPages &&
      page !== state.currentPage
    ) {
      loadProducts({ page }).then(() =>
        $("products").scrollIntoView({ block: "start", behavior: "smooth" }),
      );
    }
  }
});

window.addEventListener("resize", syncFilterPanelMode);
window.addEventListener("popstate", async () => {
  applyUrlState();
  renderActiveFilters();
  renderView();
  await loadProducts({ reset: true });
});

async function initialize(): Promise<void> {
  updateFavoriteCount();
  syncFilterPanelMode();
  await loadMeta();
  applyUrlState();
  renderActiveFilters();
  renderView();
  state.booted = true;
  syncUrl({ replace: true });
  await loadProducts({ reset: true });
}

initialize().catch((error) => console.error("Failed to initialize application", error));
