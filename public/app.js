const $ = id => document.getElementById(id);
const debouncedInputIds = ['q', 'minPrice', 'maxPrice'];
const filterChangeIds = ['shop', 'manufacturer', 'category', 'sort', 'inStock', 'favoritesOnly'];
const PAGE_SIZE = 50;
const FAVORITES_KEY = 'hifiscout:favorites';
const VIEW_KEY = 'hifiscout:view';

function readFavoriteStorage() {
  const products = new Map();
  const legacyIds = new Set();
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    if (!Array.isArray(parsed)) return { products, legacyIds };
    for (const entry of parsed) {
      if (entry && typeof entry === 'object' && Number.isSafeInteger(Number(entry.id))) {
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
  controller: null,
  requestSequence: 0,
  loading: false,
  view: storedView === 'cards' ? 'cards' : 'list'
};
const responseCache = new Map();
const CACHE_TTL_MS = 30_000;
const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}

function favoriteSnapshot(product) {
  const fields = [
    'id', 'shop_key', 'manufacturer', 'manufacturer_id', 'raw_manufacturer', 'model', 'title',
    'category', 'raw_category', 'primary_category_id', 'condition_text', 'price_yen',
    'previous_price_yen', 'stock_status', 'source_url', 'first_seen_at', 'last_seen_at',
    'last_changed_at', 'last_activity_at', 'search_aliases'
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
    console.error('Failed to save favorites', error);
  }
  updateFavoriteCount();
}

function updateFavoriteCount() {
  $('favorites-count').textContent = `(${state.favoriteProducts.size + state.legacyFavoriteIds.size})`;
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

function activityData(product) {
  const firstSeen = safeDate(product.first_seen_at);
  const activityValue = product.last_activity_at || product.first_seen_at || product.last_seen_at;
  const activity = safeDate(activityValue);
  const now = Date.now();
  const isNew = firstSeen && now - firstSeen.getTime() < 48 * 60 * 60 * 1000;
  const hasBeenUpdated = activity && firstSeen && activity.getTime() > firstSeen.getTime();
  const isRecentlyUpdated = !isNew && hasBeenUpdated && now - activity.getTime() < 48 * 60 * 60 * 1000;
  return {
    activity,
    isNew,
    isRecentlyUpdated,
    label: hasBeenUpdated ? '更新' : '初回観測'
  };
}

function productCard(product) {
  const favorite = isFavorite(product.id);
  const dropped = product.previous_price_yen != null && product.price_yen != null && product.price_yen < product.previous_price_yen;
  const activity = activityData(product);
  const badges = [
    activity.isNew ? '<span class="badge">NEW</span>' : activity.isRecentlyUpdated ? '<span class="badge">UPDATED</span>' : '',
    dropped ? '<span class="badge">PRICE DOWN</span>' : ''
  ].join('');
  const title = product.model || product.title || '商品名不明';
  const sourceUrl = escapeHtml(product.source_url || '#');
  const favoriteLabel = favorite ? 'お気に入りから削除' : 'お気に入りに追加';
  const updated = activity.activity ? `${activity.label} ${dateFmt.format(activity.activity)}` : '更新日時不明';
  return `<article class="card" data-id="${product.id}">
    <div class="product-summary">
      <div class="card-top">
        <span class="shop shop-${escapeHtml(product.shop_key)}">${escapeHtml(shopName(product.shop_key))}</span>
        <div class="badges">${badges}</div>
      </div>
      <p class="maker">${escapeHtml(product.manufacturer || 'メーカー不明')}</p>
      <h2><a class="product-title-link" href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a></h2>
      <div class="product-submeta">
        <span class="category">${escapeHtml(product.category || 'カテゴリ不明')}</span>
        ${product.condition_text ? `<span class="condition">${escapeHtml(product.condition_text)}</span>` : ''}
      </div>
    </div>
    <div class="product-commerce">
      <div class="price-row"><strong>${product.price_yen == null ? '価格不明' : yen.format(product.price_yen)}</strong>${dropped ? `<del>${yen.format(product.previous_price_yen)}</del>` : ''}</div>
      <div class="stock ${escapeHtml(product.stock_status || '')}">${product.stock_status === 'in_stock' ? '在庫あり' : product.stock_status === 'sold_out' ? '売り切れ' : '在庫状態未確認'}</div>
      <p class="updated">${escapeHtml(updated)}</p>
    </div>
    <div class="actions">
      <button class="fav" data-fav="${product.id}" type="button" aria-label="${favoriteLabel}" aria-pressed="${favorite}">${favorite ? '★' : '☆'}</button>
      <button class="history-button" data-history="${product.id}" type="button">価格履歴</button>
      <a class="shop-link" href="${sourceUrl}" target="_blank" rel="noopener noreferrer">販売店で確認 ↗</a>
    </div>
  </article>`;
}

let shops = {};
function shopName(key) { return shops[key]?.name || key || 'ショップ不明'; }

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
    return (meta.categories || []).map(value => `<option>${escapeHtml(value)}</option>`).join('');
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

  const option = facet => `<option value="${escapeHtml(facet.id)}">${escapeHtml(facet.name)}</option>`;
  const topLevel = ungrouped.map(option).join('');
  const groups = [...grouped.entries()].map(([group, values]) => (
    `<optgroup label="${escapeHtml(group)}">${values.map(option).join('')}</optgroup>`
  )).join('');
  return topLevel + groups;
}

async function loadMeta() {
  const meta = await fetchJson('/api/meta');
  shops = Object.fromEntries(meta.shops.map(shop => [shop.key, shop]));
  $('shop').insertAdjacentHTML('beforeend', meta.shops.map(shop => `<option value="${escapeHtml(shop.key)}">${escapeHtml(shop.name)}</option>`).join(''));
  $('manufacturer-options').innerHTML = meta.manufacturers.map(value => `<option value="${escapeHtml(value)}"></option>`).join('');
  $('category').insertAdjacentHTML('beforeend', categoryOptions(meta));
  $('sync-status').innerHTML = meta.shops.map(shop => {
    const lastDate = shop.sync?.last_success_at ? safeDate(shop.sync.last_success_at) : null;
    const last = lastDate ? dateFmt.format(lastDate) : '未取得';
    return `<span>${escapeHtml(shop.name)} <b>${last}</b> · ${shop.intervalMinutes}分</span>`;
  }).join('');
}

function productParams(cursor = null) {
  const params = new URLSearchParams();
  for (const id of ['q', 'shop', 'manufacturer', 'category', 'minPrice', 'maxPrice', 'sort']) {
    const value = $(id).value.trim();
    if (value) params.set(id, value);
  }
  if ($('inStock').checked) params.set('inStock', 'true');
  params.set('limit', String(PAGE_SIZE));
  if (cursor) params.set('cursor', cursor);
  return params;
}

function resetPages() {
  state.pages.clear();
  state.currentPage = 1;
  state.products = [];
}

function setLoading(loading) {
  state.loading = loading;
  $('loading').classList.toggle('show', loading);
  renderPagination();
}

function pageNumbers() {
  const loadedPages = [...state.pages.keys()].sort((a, b) => a - b);
  const lastLoaded = loadedPages.at(-1) || 1;
  const lastPage = state.pages.get(lastLoaded);
  const highestAvailable = lastPage?.hasMore ? lastLoaded + 1 : lastLoaded;
  const candidates = new Set([1, highestAvailable]);
  for (let page = Math.max(1, state.currentPage - 2); page <= Math.min(highestAvailable, state.currentPage + 2); page += 1) {
    candidates.add(page);
  }
  return [...candidates].filter(page => page >= 1 && page <= highestAvailable).sort((a, b) => a - b);
}

function renderPagination() {
  if ($('favoritesOnly').checked) {
    $('pagination').innerHTML = '';
    return;
  }
  const loadedPages = [...state.pages.keys()].sort((a, b) => a - b);
  if (!loadedPages.length) {
    $('pagination').innerHTML = '';
    return;
  }

  const numbers = pageNumbers();
  const parts = [];
  numbers.forEach((page, index) => {
    if (index && page - numbers[index - 1] > 1) parts.push('<span class="page-ellipsis" aria-hidden="true">…</span>');
    const current = page === state.currentPage;
    parts.push(`<button type="button" class="page-button${current ? ' active' : ''}" data-page="${page}"${current ? ' aria-current="page"' : ''}${state.loading ? ' disabled' : ''}>${page}</button>`);
  });
  $('pagination').innerHTML = parts.join('');
}

async function loadProducts({ page = 1, reset = false } = {}) {
  if ($('favoritesOnly').checked) {
    render();
    return;
  }
  if (reset) resetPages();
  const cachedPage = state.pages.get(page);
  if (cachedPage) {
    state.currentPage = page;
    state.products = cachedPage.items;
    refreshFavoriteSnapshots(state.products);
    render();
    return;
  }

  const previousPage = page > 1 ? state.pages.get(page - 1) : null;
  if (page > 1 && (!previousPage || !previousPage.hasMore || !previousPage.nextCursor)) return;

  state.controller?.abort();
  state.controller = new AbortController();
  const controller = state.controller;
  const sequence = ++state.requestSequence;
  const params = productParams(previousPage?.nextCursor || null);
  setLoading(true);

  try {
    const result = await fetchJson(`/api/products?${params}`, { signal: controller.signal });
    if (sequence !== state.requestSequence) return;

    const pageState = {
      items: result.items,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor
    };
    state.pages.set(page, pageState);
    state.currentPage = page;
    state.products = pageState.items;
    refreshFavoriteSnapshots(state.products);
    render();
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      if (page === 1) resetPages();
      render('商品の取得に失敗しました。');
    }
  } finally {
    if (sequence === state.requestSequence) setLoading(false);
  }
}

function selectedCategoryLabel() {
  const option = $('category').selectedOptions?.[0];
  return option?.value ? option.textContent.trim() : '';
}

function activeFilterEntries() {
  const entries = [];
  const q = $('q').value.trim();
  const shop = $('shop').value.trim();
  const manufacturer = $('manufacturer').value.trim();
  const category = $('category').value.trim();
  const minPrice = Number.parseInt($('minPrice').value, 10);
  const maxPrice = Number.parseInt($('maxPrice').value, 10);
  if (q) entries.push({ id: 'q', label: `検索: ${q}`, detail: false });
  if (shop) entries.push({ id: 'shop', label: shopName(shop), detail: true });
  if (manufacturer) entries.push({ id: 'manufacturer', label: manufacturer, detail: true });
  if (category) entries.push({ id: 'category', label: selectedCategoryLabel() || category, detail: true });
  if (Number.isFinite(minPrice)) entries.push({ id: 'minPrice', label: `${yen.format(minPrice)}以上`, detail: true });
  if (Number.isFinite(maxPrice)) entries.push({ id: 'maxPrice', label: `${yen.format(maxPrice)}以下`, detail: true });
  if ($('inStock').checked) entries.push({ id: 'inStock', label: '在庫あり', detail: true });
  if ($('favoritesOnly').checked) entries.push({ id: 'favoritesOnly', label: 'お気に入り', detail: true });
  return entries;
}

function renderActiveFilters() {
  const entries = activeFilterEntries();
  $('active-filters').innerHTML = entries.length
    ? `${entries.map(entry => `<button type="button" class="filter-chip" data-clear-filter="${entry.id}" aria-label="${escapeHtml(entry.label)}を解除">${escapeHtml(entry.label)} <span aria-hidden="true">×</span></button>`).join('')}<button type="button" class="clear-all" data-clear-all>すべて解除</button>`
    : '<span class="no-filters">絞り込み条件なし</span>';
  const detailCount = entries.filter(entry => entry.detail).length;
  $('filter-count').textContent = String(detailCount);
  $('filter-count').hidden = detailCount === 0;
}

function clearFilter(id) {
  if (id === 'inStock' || id === 'favoritesOnly') $(id).checked = false;
  else $(id).value = '';
  commitFilterChange(id);
}

function clearAllFilters() {
  for (const id of ['q', 'shop', 'manufacturer', 'category', 'minPrice', 'maxPrice']) $(id).value = '';
  $('inStock').checked = false;
  $('favoritesOnly').checked = false;
  renderActiveFilters();
  closeFilters();
  loadProducts({ reset: true });
}

function normalizedSearchText(product) {
  return [
    product.title, product.model, product.manufacturer, product.raw_manufacturer,
    product.category, product.raw_category, product.search_aliases
  ].filter(Boolean).join(' ').toLocaleLowerCase('ja-JP');
}

function favoriteMatchesFilters(product) {
  const q = $('q').value.trim().toLocaleLowerCase('ja-JP');
  if (q && !normalizedSearchText(product).includes(q)) return false;
  const shop = $('shop').value.trim();
  if (shop && product.shop_key !== shop) return false;
  const manufacturer = $('manufacturer').value.trim();
  if (manufacturer && product.manufacturer !== manufacturer) return false;
  const category = $('category').value.trim();
  if (category) {
    const ids = Array.isArray(product.category_ids) ? product.category_ids : [];
    if (!ids.includes(category) && product.primary_category_id !== category && product.category !== selectedCategoryLabel()) return false;
  }
  if ($('inStock').checked && product.stock_status !== 'in_stock') return false;
  const minPrice = Number.parseInt($('minPrice').value, 10);
  if (Number.isFinite(minPrice) && !(product.price_yen >= minPrice)) return false;
  const maxPrice = Number.parseInt($('maxPrice').value, 10);
  if (Number.isFinite(maxPrice) && !(product.price_yen <= maxPrice)) return false;
  return true;
}

function favoriteResults() {
  const products = [...state.favoriteProducts.values()].filter(favoriteMatchesFilters);
  const sort = $('sort').value;
  products.sort((left, right) => {
    if (sort === 'priceAsc' || sort === 'priceDesc') {
      if (left.price_yen == null && right.price_yen == null) return 0;
      if (left.price_yen == null) return 1;
      if (right.price_yen == null) return -1;
      return sort === 'priceAsc' ? left.price_yen - right.price_yen : right.price_yen - left.price_yen;
    }
    const leftDate = safeDate(left.last_activity_at || left.first_seen_at || left.last_seen_at)?.getTime() || 0;
    const rightDate = safeDate(right.last_activity_at || right.first_seen_at || right.last_seen_at)?.getTime() || 0;
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
  $('products').classList.toggle('view-list', state.view === 'list');
  $('products').classList.toggle('view-cards', state.view === 'cards');
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function render(errorMessage = '') {
  const favoriteMode = $('favoritesOnly').checked;
  const products = favoriteMode ? favoriteResults() : state.products;
  $('count').textContent = String(products.length);
  $('count-label').textContent = favoriteMode ? '件のお気に入り' : '件表示';
  $('favorites-note').hidden = !favoriteMode;
  const legacyNotice = favoriteMode && state.legacyFavoriteIds.size
    ? `<div class="legacy-favorites-note">旧形式で保存されたお気に入りが${state.legacyFavoriteIds.size}件あります。商品一覧で再表示されると、この端末内で自動的に移行されます。</div>`
    : '';
  $('products').innerHTML = errorMessage
    ? `<div class="empty"><strong>${escapeHtml(errorMessage)}</strong><button type="button" data-retry>再読み込み</button></div>`
    : `${legacyNotice}${products.length ? products.map(productCard).join('') : emptyState(favoriteMode)}`;
  renderActiveFilters();
  renderView();
  renderPagination();
}

async function showHistory(id) {
  try {
    const data = await fetchJson(`/api/products/${id}/history`);
    const rows = data.history.map((entry, index) => `<li><time>${escapeHtml(new Date(entry.observed_at).toLocaleString('ja-JP'))}</time><strong>${yen.format(entry.price_yen)}</strong>${index && entry.price_yen < data.history[index - 1].price_yen ? '<span>↓</span>' : ''}</li>`).join('');
    $('history-content').innerHTML = `<p class="maker">${escapeHtml(data.product.manufacturer)}</p><h2 id="history-title">${escapeHtml(data.product.model || data.product.title)}</h2><ol class="history">${rows || '<li>履歴はまだありません。</li>'}</ol>`;
    $('history-dialog').showModal();
  } catch (error) {
    console.error(error);
    $('history-content').innerHTML = '<h2 id="history-title">価格履歴</h2><p>価格履歴を取得できませんでした。</p>';
    $('history-dialog').showModal();
  }
}

function commitFilterChange(id) {
  renderActiveFilters();
  if (id === 'favoritesOnly' && $('favoritesOnly').checked) {
    state.controller?.abort();
    setLoading(false);
    render();
    return;
  }
  if ($('favoritesOnly').checked) {
    render();
    return;
  }
  loadProducts({ reset: true });
}

function openFilters() {
  if (!window.matchMedia('(max-width: 640px)').matches) return;
  $('filter-panel').classList.add('open');
  $('filter-backdrop').hidden = false;
  $('filter-toggle').setAttribute('aria-expanded', 'true');
  document.body.classList.add('filters-open');
  $('filter-panel').removeAttribute('inert');
  $('filter-close').focus();
}

function closeFilters() {
  $('filter-panel').classList.remove('open');
  $('filter-backdrop').hidden = true;
  $('filter-toggle').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('filters-open');
  if (window.matchMedia('(max-width: 640px)').matches) $('filter-panel').setAttribute('inert', '');
  else $('filter-panel').removeAttribute('inert');
}

function syncFilterPanelMode() {
  if (window.matchMedia('(max-width: 640px)').matches) {
    if (!$('filter-panel').classList.contains('open')) $('filter-panel').setAttribute('inert', '');
  } else {
    $('filter-panel').removeAttribute('inert');
    $('filter-panel').classList.remove('open');
    $('filter-backdrop').hidden = true;
    $('filter-toggle').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('filters-open');
  }
}

let inputTimer;
document.addEventListener('input', event => {
  if (!debouncedInputIds.includes(event.target.id)) return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => commitFilterChange(event.target.id), 400);
});

document.addEventListener('change', event => {
  if (filterChangeIds.includes(event.target.id)) commitFilterChange(event.target.id);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('filter-panel').classList.contains('open')) closeFilters();
});

document.addEventListener('click', event => {
  const favoriteButton = event.target.closest('[data-fav]');
  if (favoriteButton) {
    const id = Number(favoriteButton.dataset.fav);
    if (isFavorite(id)) {
      state.favoriteProducts.delete(id);
      state.legacyFavoriteIds.delete(id);
    } else {
      const product = state.products.find(candidate => Number(candidate.id) === id) || state.favoriteProducts.get(id);
      if (product) state.favoriteProducts.set(id, favoriteSnapshot(product));
    }
    saveFavorites();
    render();
    return;
  }

  const history = event.target.closest('[data-history]');
  if (history) {
    showHistory(history.dataset.history);
    return;
  }

  const clearChip = event.target.closest('[data-clear-filter]');
  if (clearChip) {
    clearFilter(clearChip.dataset.clearFilter);
    return;
  }

  if (event.target.closest('[data-clear-all]') || event.target.id === 'clear-filters') {
    clearAllFilters();
    return;
  }

  if (event.target.closest('[data-retry]')) {
    loadProducts({ reset: true });
    return;
  }

  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    state.view = viewButton.dataset.view === 'cards' ? 'cards' : 'list';
    localStorage.setItem(VIEW_KEY, state.view);
    renderView();
    return;
  }

  if (event.target.matches('.dialog-close')) {
    $('history-dialog').close();
    return;
  }
  if (event.target.id === 'filter-toggle') {
    openFilters();
    return;
  }
  if (event.target.id === 'filter-close' || event.target.id === 'filter-backdrop' || event.target.id === 'apply-filters') {
    closeFilters();
    return;
  }

  const pageButton = event.target.closest('[data-page]');
  if (pageButton && !pageButton.disabled) {
    const page = Number(pageButton.dataset.page);
    if (Number.isInteger(page) && page > 0 && page !== state.currentPage) {
      loadProducts({ page }).then(() => $('products').scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }
  }
});

window.addEventListener('resize', syncFilterPanelMode);

updateFavoriteCount();
syncFilterPanelMode();
await loadMeta();
renderActiveFilters();
renderView();
await loadProducts({ reset: true });
