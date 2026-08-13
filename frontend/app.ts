const $ = (id) => document.getElementById(id);
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
const PAGE_SIZE = 50;
const FAVORITES_KEY = "hifiscout:favorites";
const VIEW_KEY = "hifiscout:view";
const URL_VALUE_IDS = ["q", "shop", "manufacturer", "category", "minPrice", "maxPrice", "sort"];
const DEFAULT_SORT = "newest";

function readFavoriteStorage() {
  const products = new Map();
  const legacyIds = new Set();
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    if (!Array.isArray(parsed)) return { products, legacyIds };
    for (const entry of parsed) {
      if (entry && typeof entry === "object" && Number.isSafeInteger(Number(entry.id))) {
        products.set(Number(entry.id), { ...entry, id: Number(entry.id) });
        continue;
      }
      const id = Number(entry);
      if (Number.isSafeInteger(id) && id > 0) legacyIds.add(id);
    }
  } catch {
    // Ignore malformed local data and start with an empty favorite collection.
  }
  return { products, legacyIds };
}

const storedFavorites = readFavoriteStorage();
const storedView = localStorage.getItem(VIEW_KEY);
const state = {
  products: [],
  favoriteProducts: storedFavorites.products,
  legacyFavoriteIds: storedFavorites.legacyIds,
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
const responseCache = new Map();
const CACHE_TTL_MS = 30_000;
const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});
const dateFmt = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function escapeHtml(value = "") {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function favoriteSnapshot(product) {
  const fields = [
    "id",
    "shop_key",
    "manufacturer",
    "manufacturer_id",
    "raw_manufacturer",
    "model",
    "title",
    "category",
    "raw_category",
    "primary_category_id",
    "condition_text",
    "price_yen",
    "previous_price_yen",
    "stock_status",
    "source_url",
    "first_seen_at",
    "last_seen_at",
    "last_changed_at",
    "last_activity_at",
    "search_aliases",
  ];
  const snapshot = {};
  for (const field of fields) snapshot[field] = product[field] ?? null;
  snapshot.category_ids = Array.isArray(product.category_ids) ? [...product.category_ids] : [];
  return snapshot;
}

function saveFavorites() {
  const payload = [...state.legacyFavoriteIds, ...state.favoriteProducts.values()];
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(payload));
  } catch (error) {
    console.error("Failed to save favorites", error);
  }
  updateFavoriteCount();
}

function updateFavoriteCount() {
  $("favorites-count").textContent =
    `(${state.favoriteProducts.size + state.legacyFavoriteIds.size})`;
}

function isFavorite(id) {
  return state.favoriteProducts.has(Number(id)) || state.legacyFavoriteIds.has(Number(id));
}

function refreshFavoriteSnapshots(products) {
  let changed = false;
  for (const product of products) {
    const id = Number(product.id);
    if (!isFavorite(id)) continue;
    state.legacyFavoriteIds.delete(id);
    state.favoriteProducts.set(id, favoriteSnapshot(product));
    changed = true;
  }
  if (changed) saveFavorites();
}

function safeDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function relativeTime(value) {
  const date = safeDate(value);
  if (!date) return "未取得";
  const diff = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

function activityData(product) {
  const firstSeen = safeDate(product.first_seen_at);
  const activityValue = product.last_activity_at || product.first_seen_at || product.last_seen_at;
  const activity = safeDate(activityValue);
  const now = Date.now();
  const isNew = firstSeen && now - firstSeen.getTime() < 48 * 60 * 60 * 1000;
  const hasBeenUpdated = activity && firstSeen && activity.getTime() > firstSeen.getTime();
  const isRecentlyUpdated =
    !isNew && hasBeenUpdated && now - activity.getTime() < 48 * 60 * 60 * 1000;
  return {
    activity,
    isNew,
    isRecentlyUpdated,
    label: hasBeenUpdated ? "更新" : "初回観測",
  };
}

function priceDropped(product) {
  return (
    product.previous_price_yen != null &&
    product.price_yen != null &&
    product.price_yen < product.previous_price_yen
  );
}

function productCard(product) {
  const favorite = isFavorite(product.id);
  const dropped = priceDropped(product);
  const activity = activityData(product);
  const badges = [
    activity.isNew
      ? '<span class="badge">NEW</span>'
      : activity.isRecentlyUpdated
        ? '<span class="badge">UPDATED</span>'
        : "",
    dropped ? '<span class="badge">PRICE DOWN</span>' : "",
  ].join("");
  const title = product.model || product.title || "商品名不明";
  const sourceUrl = escapeHtml(product.source_url || "#");
  const favoriteLabel = favorite ? "お気に入りから削除" : "お気に入りに追加";
  const updated = activity.activity
    ? `${activity.label} ${dateFmt.format(activity.activity)}`
    : "更新日時不明";
  return `<article class="card" data-id="${product.id}">
    <div class="product-summary">
      <div class="card-top">
        <span class="shop shop-${escapeHtml(product.shop_key)}">${escapeHtml(shopName(product.shop_key))}</span>
        <div class="badges">${badges}</div>
      </div>
      <p class="maker">${escapeHtml(product.manufacturer || "メーカー不明")}</p>
      <h2><a class="product-title-link" href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a></h2>
      <div class="product-submeta">
        <span class="category">${escapeHtml(product.category || "カテゴリ不明")}</span>
        ${product.condition_text ? `<span class="condition">${escapeHtml(product.condition_text)}</span>` : ""}
      </div>
    </div>
    <div class="product-commerce">
      <div class="price-row"><strong>${product.price_yen == null ? "価格不明" : yen.format(product.price_yen)}</strong>${dropped ? `<del>${yen.format(product.previous_price_yen)}</del>` : ""}</div>
      <div class="stock ${escapeHtml(product.stock_status || "")}">${product.stock_status === "in_stock" ? "在庫あり" : product.stock_status === "sold_out" ? "売り切れ" : "在庫状態未確認"}</div>
      <p class="updated">${escapeHtml(updated)}</p>
    </div>
    <div class="actions">
      <button class="fav" data-fav="${product.id}" type="button" aria-label="${favoriteLabel}" aria-pressed="${favorite}">${favorite ? "★" : "☆"}</button>
      <button class="history-button" data-history="${product.id}" type="button">価格履歴</button>
      <a class="shop-link" href="${sourceUrl}" target="_blank" rel="noopener noreferrer">販売店で確認 ↗</a>
    </div>
  </article>`;
}

let shops = {};
function shopName(key) {
  return shops[key]?.name || key || "ショップ不明";
}

async function fetchJson(url, { signal } = {}) {
  const cached = responseCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (cached) responseCache.delete(url);

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  responseCache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

function categoryOptions(meta) {
  const facets = Array.isArray(meta.categoryFacets) ? meta.categoryFacets : [];
  if (!facets.length) {
    return (meta.categories || []).map((value) => `<option>${escapeHtml(value)}</option>`).join("");
  }

  const ungrouped = [];
  const grouped = new Map();
  for (const facet of facets) {
    if (!facet?.id || !facet?.name) continue;
    if (!facet.group) {
      ungrouped.push(facet);
      continue;
    }
    if (!grouped.has(facet.group)) grouped.set(facet.group, []);
    grouped.get(facet.group).push(facet);
  }

  const option = (facet) =>
    `<option value="${escapeHtml(facet.id)}">${escapeHtml(facet.name)}</option>`;
  const topLevel = ungrouped.map(option).join("");
  const groups = [...grouped.entries()]
    .map(
      ([group, values]) =>
        `<optgroup label="${escapeHtml(group)}">${values.map(option).join("")}</optgroup>`,
    )
    .join("");
  return topLevel + groups;
}

function renderSyncStatus(meta) {
  const enabled = (meta.shops || []).filter((shop) => shop.enabled !== false);
  const problems = enabled.filter((shop) => ["warning", "critical"].includes(shop.health?.status));
  const critical = problems.filter((shop) => shop.health?.status === "critical");
  const status =
    meta.status || (critical.length ? "critical" : problems.length ? "warning" : "healthy");
  const summary =
    status === "critical"
      ? `⚠ ${Math.max(critical.length, problems.length)}店舗で更新に問題があります`
      : status === "warning"
        ? `⚠ ${problems.length}店舗で更新が遅れています`
        : "データ更新 正常";

  $("sync-status").classList.remove("healthy", "warning", "critical");
  $("sync-status").classList.add(
    status === "critical" ? "critical" : status === "warning" ? "warning" : "healthy",
  );
  $("sync-summary-text").textContent = summary;
  $("sync-status-details").innerHTML = (meta.shops || [])
    .map((shop) => {
      const health = shop.health || {};
      const healthStatus = health.status || (shop.enabled === false ? "disabled" : "unknown");
      const label =
        healthStatus === "healthy"
          ? "正常"
          : healthStatus === "warning"
            ? "遅延"
            : healthStatus === "critical"
              ? "要確認"
              : healthStatus === "disabled"
                ? "停止中"
                : "未確認";
      const lastSuccess = health.lastSuccessAt || shop.sync?.last_success_at || null;
      const exact = safeDate(lastSuccess)?.toLocaleString("ja-JP") || "未取得";
      return `<div class="sync-shop-row ${escapeHtml(healthStatus)}">
      <span class="sync-shop-name">${escapeHtml(shop.name)}</span>
      <span class="sync-shop-health">${escapeHtml(label)}</span>
      <time title="${escapeHtml(exact)}">${escapeHtml(relativeTime(lastSuccess))}</time>
    </div>`;
    })
    .join("");
}

async function loadMeta() {
  const meta = await fetchJson("/api/meta");
  shops = Object.fromEntries(meta.shops.map((shop) => [shop.key, shop]));
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

function productParams({ cursor = null, page = 1, includeTotal = false } = {}) {
  const params = new URLSearchParams();
  for (const id of URL_VALUE_IDS) {
    const value = $(id).value.trim();
    if (value) params.set(id, value);
  }
  if ($("inStock").checked) params.set("inStock", "true");
  if ($("recentOnly").checked) params.set("newOnly", "true");
  if ($("priceDropped").checked) params.set("priceDropped", "true");
  params.set("limit", String(PAGE_SIZE));
  if (cursor) params.set("cursor", cursor);
  else if (page > 1) params.set("offset", String((page - 1) * PAGE_SIZE));
  if (includeTotal) params.set("includeTotal", "true");
  return params;
}

function urlParamsFromState() {
  const params = new URLSearchParams();
  for (const id of URL_VALUE_IDS) {
    const value = $(id).value.trim();
    if (!value) continue;
    if (id === "sort" && value === DEFAULT_SORT) continue;
    params.set(id, value);
  }
  if (!$("inStock").checked) params.set("inStock", "false");
  if ($("recentOnly").checked) params.set("newOnly", "true");
  if ($("priceDropped").checked) params.set("priceDropped", "true");
  if (state.view === "cards") params.set("view", "cards");
  return params;
}

function syncUrl({ replace = false } = {}) {
  if (!state.booted || state.applyingUrl) return;
  const params = urlParamsFromState();
  const nextSearch = params.toString();
  const next = `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}${location.hash}`;
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (next === current) return;
  if (replace) history.replaceState(null, "", next);
  else history.pushState(null, "", next);
}

function setSelectValue(id, value) {
  const select = $(id);
  select.value = value;
  if (value && select.value !== value) select.value = "";
}

function applyUrlState() {
  const params = new URLSearchParams(location.search);
  state.applyingUrl = true;
  $("q").value = params.get("q") || "";
  setSelectValue("shop", params.get("shop") || "");
  $("manufacturer").value = params.get("manufacturer") || "";
  setSelectValue("category", params.get("category") || "");
  $("minPrice").value = params.get("minPrice") || "";
  $("maxPrice").value = params.get("maxPrice") || "";
  setSelectValue("sort", params.get("sort") || DEFAULT_SORT);
  $("inStock").checked = params.get("inStock") !== "false";
  $("recentOnly").checked = params.get("newOnly") === "true";
  $("priceDropped").checked = params.get("priceDropped") === "true";
  const view = params.get("view");
  if (view === "cards" || view === "list") {
    state.view = view;
    localStorage.setItem(VIEW_KEY, view);
  }
  state.applyingUrl = false;
}

function resetPages() {
  state.pages.clear();
  state.currentPage = 1;
  state.totalPages = 0;
  state.totalItems = null;
  state.products = [];
}

function setLoading(loading) {
  state.loading = loading;
  $("loading").classList.toggle("show", loading);
  renderPagination();
}

function pageNumbers() {
  const total = state.totalPages;
  if (total <= 0) return [];
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  if (state.currentPage <= 4) return [1, 2, 3, 4, 5, total];
  if (state.currentPage >= total - 3) return [1, total - 4, total - 3, total - 2, total - 1, total];
  return [1, state.currentPage - 1, state.currentPage, state.currentPage + 1, total];
}

function renderPagination() {
  if ($("favoritesOnly").checked || !state.pages.size || state.totalPages <= 1) {
    $("pagination").innerHTML = "";
    return;
  }

  const numbers = pageNumbers();
  const parts = [];
  numbers.forEach((page, index) => {
    if (index && page - numbers[index - 1] > 1)
      parts.push('<span class="page-ellipsis" aria-hidden="true">…</span>');
    const current = page === state.currentPage;
    parts.push(
      `<button type="button" class="page-button${current ? " active" : ""}" data-page="${page}" aria-label="${page}ページ目"${current ? ' aria-current="page"' : ""}${state.loading ? " disabled" : ""}>${page}</button>`,
    );
  });
  $("pagination").innerHTML = parts.join("");
}

async function loadProducts({ page = 1, reset = false } = {}) {
  if ($("favoritesOnly").checked) {
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

  const previousPage = page > 1 ? state.pages.get(page - 1) : null;
  const cursor = previousPage?.hasMore && previousPage.nextCursor ? previousPage.nextCursor : null;

  state.controller?.abort();
  state.controller = new AbortController();
  const controller = state.controller;
  const sequence = ++state.requestSequence;
  const params = productParams({
    cursor,
    page: cursor ? 1 : page,
    includeTotal: state.totalPages === 0,
  });
  setLoading(true);

  try {
    const result = await fetchJson(`/api/products?${params}`, { signal: controller.signal });
    if (sequence !== state.requestSequence) return;

    if (Number.isInteger(result.totalPages) && result.totalPages >= 0)
      state.totalPages = result.totalPages;
    if (Number.isInteger(result.totalCount) && result.totalCount >= 0)
      state.totalItems = result.totalCount;
    const pageState = {
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
    if (error.name !== "AbortError") {
      console.error(error);
      if (page === 1) resetPages();
      render("商品の取得に失敗しました。");
    }
  } finally {
    if (sequence === state.requestSequence) setLoading(false);
  }
}

function selectedCategoryLabel() {
  const option = $("category").selectedOptions?.[0];
  return option?.value ? option.textContent.trim() : "";
}

function activeFilterEntries() {
  const entries = [];
  const q = $("q").value.trim();
  const shop = $("shop").value.trim();
  const manufacturer = $("manufacturer").value.trim();
  const category = $("category").value.trim();
  const minPrice = Number.parseInt($("minPrice").value, 10);
  const maxPrice = Number.parseInt($("maxPrice").value, 10);
  if (q) entries.push({ id: "q", label: `検索: ${q}`, detail: false });
  if (shop) entries.push({ id: "shop", label: shopName(shop), detail: true });
  if (manufacturer) entries.push({ id: "manufacturer", label: manufacturer, detail: true });
  if (category)
    entries.push({ id: "category", label: selectedCategoryLabel() || category, detail: true });
  if (Number.isFinite(minPrice))
    entries.push({ id: "minPrice", label: `${yen.format(minPrice)}以上`, detail: true });
  if (Number.isFinite(maxPrice))
    entries.push({ id: "maxPrice", label: `${yen.format(maxPrice)}以下`, detail: true });
  if ($("inStock").checked) entries.push({ id: "inStock", label: "在庫あり", detail: true });
  if ($("recentOnly").checked)
    entries.push({ id: "recentOnly", label: "48時間以内の新着", detail: true });
  if ($("priceDropped").checked)
    entries.push({ id: "priceDropped", label: "値下げ商品", detail: true });
  if ($("favoritesOnly").checked)
    entries.push({ id: "favoritesOnly", label: "お気に入り", detail: true });
  return entries;
}

function renderActiveFilters() {
  const entries = activeFilterEntries();
  $("active-filters").innerHTML = entries.length
    ? `${entries.map((entry) => `<button type="button" class="filter-chip" data-clear-filter="${entry.id}" aria-label="${escapeHtml(entry.label)}を解除">${escapeHtml(entry.label)} <span aria-hidden="true">×</span></button>`).join("")}<button type="button" class="clear-all" data-clear-all>すべて解除</button>`
    : '<span class="no-filters">絞り込み条件なし</span>';
  const detailCount = entries.filter((entry) => entry.detail).length;
  $("filter-count").textContent = String(detailCount);
  $("filter-count").hidden = detailCount === 0;
}

function clearFilter(id) {
  if (["inStock", "favoritesOnly", "recentOnly", "priceDropped"].includes(id))
    $(id).checked = false;
  else $(id).value = "";
  commitFilterChange(id);
}

function clearAllFilters() {
  for (const id of ["q", "shop", "manufacturer", "category", "minPrice", "maxPrice"])
    $(id).value = "";
  for (const id of ["inStock", "favoritesOnly", "recentOnly", "priceDropped"])
    $(id).checked = false;
  renderActiveFilters();
  closeFilters();
  syncUrl();
  loadProducts({ reset: true });
}

function normalizedSearchText(product) {
  return [
    product.title,
    product.model,
    product.manufacturer,
    product.raw_manufacturer,
    product.category,
    product.raw_category,
    product.search_aliases,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("ja-JP");
}

function favoriteMatchesFilters(product) {
  const q = $("q").value.trim().toLocaleLowerCase("ja-JP");
  if (q && !normalizedSearchText(product).includes(q)) return false;
  const shop = $("shop").value.trim();
  if (shop && product.shop_key !== shop) return false;
  const manufacturer = $("manufacturer").value.trim();
  if (manufacturer && product.manufacturer !== manufacturer) return false;
  const category = $("category").value.trim();
  if (category) {
    const ids = Array.isArray(product.category_ids) ? product.category_ids : [];
    if (
      !ids.includes(category) &&
      product.primary_category_id !== category &&
      product.category !== selectedCategoryLabel()
    )
      return false;
  }
  if ($("inStock").checked && product.stock_status !== "in_stock") return false;
  if ($("recentOnly").checked && !activityData(product).isNew) return false;
  if ($("priceDropped").checked && !priceDropped(product)) return false;
  const minPrice = Number.parseInt($("minPrice").value, 10);
  if (Number.isFinite(minPrice) && !(product.price_yen >= minPrice)) return false;
  const maxPrice = Number.parseInt($("maxPrice").value, 10);
  if (Number.isFinite(maxPrice) && !(product.price_yen <= maxPrice)) return false;
  return true;
}

function favoriteResults() {
  const products = [...state.favoriteProducts.values()].filter(favoriteMatchesFilters);
  const sort = $("sort").value;
  products.sort((left, right) => {
    if (sort === "priceAsc" || sort === "priceDesc") {
      if (left.price_yen == null && right.price_yen == null) return 0;
      if (left.price_yen == null) return 1;
      if (right.price_yen == null) return -1;
      return sort === "priceAsc"
        ? left.price_yen - right.price_yen
        : right.price_yen - left.price_yen;
    }
    const leftDate =
      safeDate(left.last_activity_at || left.first_seen_at || left.last_seen_at)?.getTime() || 0;
    const rightDate =
      safeDate(right.last_activity_at || right.first_seen_at || right.last_seen_at)?.getTime() || 0;
    return rightDate - leftDate;
  });
  return products;
}

function emptyState(favoriteMode) {
  if (favoriteMode && state.favoriteProducts.size === 0 && state.legacyFavoriteIds.size === 0) {
    return '<div class="empty"><strong>お気に入りはまだありません。</strong><span>商品一覧の☆からこの端末に保存できます。</span></div>';
  }
  return '<div class="empty"><strong>条件に一致する商品はありません。</strong><button type="button" data-clear-all>条件をすべて解除</button></div>';
}

function renderView() {
  $("products").classList.toggle("view-list", state.view === "list");
  $("products").classList.toggle("view-cards", state.view === "cards");
  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === state.view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function render(errorMessage = "") {
  const favoriteMode = $("favoritesOnly").checked;
  const products = favoriteMode ? favoriteResults() : state.products;
  $("count").textContent = String(products.length);
  $("count-label").textContent = favoriteMode ? "件のお気に入り" : "件を表示中";
  $("more-available").hidden =
    favoriteMode || errorMessage || state.currentPage >= state.totalPages;
  $("favorites-note").hidden = !favoriteMode;
  const legacyNotice =
    favoriteMode && state.legacyFavoriteIds.size
      ? `<div class="legacy-favorites-note">旧形式で保存されたお気に入りが${state.legacyFavoriteIds.size}件あります。商品一覧で再表示されると、この端末内で自動的に移行されます。</div>`
      : "";
  $("products").innerHTML = errorMessage
    ? `<div class="empty"><strong>${escapeHtml(errorMessage)}</strong><button type="button" data-retry>再読み込み</button></div>`
    : `${legacyNotice}${products.length ? products.map(productCard).join("") : emptyState(favoriteMode)}`;
  renderActiveFilters();
  renderView();
  renderPagination();
}

async function showHistory(id) {
  try {
    const data = await fetchJson(`/api/products/${id}/history`);
    const rows = data.history
      .map(
        (entry, index) =>
          `<li><time>${escapeHtml(new Date(entry.observed_at).toLocaleString("ja-JP"))}</time><strong>${yen.format(entry.price_yen)}</strong>${index && entry.price_yen < data.history[index - 1].price_yen ? "<span>↓</span>" : ""}</li>`,
      )
      .join("");
    $("history-content").innerHTML =
      `<p class="maker">${escapeHtml(data.product.manufacturer)}</p><h2 id="history-title">${escapeHtml(data.product.model || data.product.title)}</h2><ol class="history">${rows || "<li>履歴はまだありません。</li>"}</ol>`;
    $("history-dialog").showModal();
  } catch (error) {
    console.error(error);
    $("history-content").innerHTML =
      '<h2 id="history-title">価格履歴</h2><p>価格履歴を取得できませんでした。</p>';
    $("history-dialog").showModal();
  }
}

function commitFilterChange(id) {
  renderActiveFilters();
  syncUrl({ replace: debouncedInputIds.includes(id) });
  if (id === "favoritesOnly" && $("favoritesOnly").checked) {
    state.controller?.abort();
    setLoading(false);
    render();
    return;
  }
  if ($("favoritesOnly").checked) {
    render();
    return;
  }
  loadProducts({ reset: true });
}

function openFilters() {
  if (!window.matchMedia("(max-width: 640px)").matches) return;
  $("filter-panel").classList.add("open");
  $("filter-backdrop").hidden = false;
  $("filter-toggle").setAttribute("aria-expanded", "true");
  document.body.classList.add("filters-open");
  $("filter-panel").removeAttribute("inert");
  $("filter-close").focus();
}

function closeFilters() {
  $("filter-panel").classList.remove("open");
  $("filter-backdrop").hidden = true;
  $("filter-toggle").setAttribute("aria-expanded", "false");
  document.body.classList.remove("filters-open");
  if (window.matchMedia("(max-width: 640px)").matches) $("filter-panel").setAttribute("inert", "");
  else $("filter-panel").removeAttribute("inert");
}

function syncFilterPanelMode() {
  if (window.matchMedia("(max-width: 640px)").matches) {
    if (!$("filter-panel").classList.contains("open")) $("filter-panel").setAttribute("inert", "");
  } else {
    $("filter-panel").removeAttribute("inert");
    $("filter-panel").classList.remove("open");
    $("filter-backdrop").hidden = true;
    $("filter-toggle").setAttribute("aria-expanded", "false");
    document.body.classList.remove("filters-open");
  }
}

let inputTimer;
document.addEventListener("input", (event) => {
  if (!debouncedInputIds.includes(event.target.id)) return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => commitFilterChange(event.target.id), 400);
});

document.addEventListener("change", (event) => {
  if (filterChangeIds.includes(event.target.id)) commitFilterChange(event.target.id);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("filter-panel").classList.contains("open")) closeFilters();
});

document.addEventListener("click", (event) => {
  const favoriteButton = event.target.closest("[data-fav]");
  if (favoriteButton) {
    const id = Number(favoriteButton.dataset.fav);
    if (isFavorite(id)) {
      state.favoriteProducts.delete(id);
      state.legacyFavoriteIds.delete(id);
    } else {
      const product =
        state.products.find((candidate) => Number(candidate.id) === id) ||
        state.favoriteProducts.get(id);
      if (product) state.favoriteProducts.set(id, favoriteSnapshot(product));
    }
    saveFavorites();
    render();
    return;
  }

  const history = event.target.closest("[data-history]");
  if (history) {
    showHistory(history.dataset.history);
    return;
  }

  const clearChip = event.target.closest("[data-clear-filter]");
  if (clearChip) {
    clearFilter(clearChip.dataset.clearFilter);
    return;
  }

  if (event.target.closest("[data-clear-all]") || event.target.id === "clear-filters") {
    clearAllFilters();
    return;
  }

  if (event.target.closest("[data-retry]")) {
    loadProducts({ reset: true });
    return;
  }

  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    state.view = viewButton.dataset.view === "cards" ? "cards" : "list";
    localStorage.setItem(VIEW_KEY, state.view);
    renderView();
    syncUrl();
    return;
  }

  if (event.target.matches(".dialog-close")) {
    $("history-dialog").close();
    return;
  }
  if (event.target.id === "filter-toggle") {
    openFilters();
    return;
  }
  if (
    event.target.id === "filter-close" ||
    event.target.id === "filter-backdrop" ||
    event.target.id === "apply-filters"
  ) {
    closeFilters();
    return;
  }

  const pageButton = event.target.closest("[data-page]");
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

async function initialize() {
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
