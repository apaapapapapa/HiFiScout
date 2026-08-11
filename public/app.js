const $ = id => document.getElementById(id);
const filterSelectIds = ['shop', 'manufacturer', 'category', 'sort', 'inStock'];
const debouncedInputIds = ['q', 'minPrice', 'maxPrice'];
const PAGE_SIZE = 50;
const state = {
  products: [],
  favorites: new Set(JSON.parse(localStorage.getItem('hifiscout:favorites') || '[]')),
  pages: new Map(),
  currentPage: 1,
  controller: null,
  requestSequence: 0,
  loading: false
};
const responseCache = new Map();
const CACHE_TTL_MS = 30_000;
const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}

function saveFavorites() { localStorage.setItem('hifiscout:favorites', JSON.stringify([...state.favorites])); }

function productCard(p) {
  const favorite = state.favorites.has(p.id);
  const dropped = p.previous_price_yen != null && p.price_yen != null && p.price_yen < p.previous_price_yen;
  const now = Date.now();
  const firstSeenMs = new Date(p.first_seen_at).getTime();
  const activityValue = p.last_activity_at || p.first_seen_at || p.last_seen_at;
  const activityMs = new Date(activityValue).getTime();
  const isNew = Number.isFinite(firstSeenMs) && now - firstSeenMs < 48 * 60 * 60 * 1000;
  const hasBeenUpdated = Number.isFinite(activityMs) && Number.isFinite(firstSeenMs) && activityMs > firstSeenMs;
  const isRecentlyUpdated = !isNew && hasBeenUpdated && now - activityMs < 48 * 60 * 60 * 1000;
  const activityLabel = hasBeenUpdated ? '更新' : '初回観測';
  return `<article class="card" data-id="${p.id}">
    <div class="card-top"><span class="shop shop-${escapeHtml(p.shop_key)}">${escapeHtml(shopName(p.shop_key))}</span><button class="fav" data-fav="${p.id}" aria-label="お気に入り">${favorite ? '★' : '☆'}</button></div>
    <div class="badges">${isNew ? '<span class="badge">NEW</span>' : isRecentlyUpdated ? '<span class="badge">UPDATED</span>' : ''}${dropped ? '<span class="badge">PRICE DOWN</span>' : ''}${p.condition_text ? `<span class="condition">${escapeHtml(p.condition_text)}</span>` : ''}</div>
    <p class="maker">${escapeHtml(p.manufacturer)}</p>
    <h2>${escapeHtml(p.model || p.title)}</h2>
    <p class="category">${escapeHtml(p.category)}</p>
    <div class="price-row"><strong>${p.price_yen == null ? '価格不明' : yen.format(p.price_yen)}</strong>${dropped ? `<del>${yen.format(p.previous_price_yen)}</del>` : ''}</div>
    <div class="stock ${p.stock_status}">${p.stock_status === 'in_stock' ? '在庫あり' : p.stock_status === 'sold_out' ? '売り切れ' : '在庫状態未確認'}</div>
    <p class="updated">${activityLabel} ${dateFmt.format(new Date(activityValue))}</p>
    <div class="actions"><button data-history="${p.id}">価格履歴</button><a href="${escapeHtml(p.source_url)}" target="_blank" rel="noopener noreferrer">販売店で確認 ↗</a></div>
  </article>`;
}

let shops = {};
function shopName(key) { return shops[key]?.name || key; }

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
  shops = Object.fromEntries(meta.shops.map(s => [s.key, s]));
  $('shop').insertAdjacentHTML('beforeend', meta.shops.map(s => `<option value="${escapeHtml(s.key)}">${escapeHtml(s.name)}</option>`).join(''));
  $('manufacturer').insertAdjacentHTML('beforeend', meta.manufacturers.map(v => `<option>${escapeHtml(v)}</option>`).join(''));
  $('category').insertAdjacentHTML('beforeend', categoryOptions(meta));
  $('sync-status').innerHTML = meta.shops.map(s => {
    const last = s.sync?.last_success_at ? dateFmt.format(new Date(s.sync.last_success_at)) : '未取得';
    return `<span>${escapeHtml(s.name)} <b>${last}</b> · ${s.intervalMinutes}分</span>`;
  }).join('');
}

function productParams(cursor = null) {
  const params = new URLSearchParams();
  for (const id of ['q','shop','manufacturer','category','minPrice','maxPrice','sort']) {
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
  if (reset) resetPages();
  const cachedPage = state.pages.get(page);
  if (cachedPage) {
    state.currentPage = page;
    state.products = cachedPage.items;
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

function render(errorMessage = '') {
  const products = $('favoritesOnly').checked ? state.products.filter(p => state.favorites.has(p.id)) : state.products;
  $('count').textContent = String(products.length);
  $('products').innerHTML = errorMessage
    ? `<div class="empty">${escapeHtml(errorMessage)}</div>`
    : products.length ? products.map(productCard).join('') : '<div class="empty">条件に一致する商品はありません。</div>';
  renderPagination();
}

async function showHistory(id) {
  const data = await fetchJson(`/api/products/${id}/history`);
  const rows = data.history.map((h, i) => `<li><time>${escapeHtml(new Date(h.observed_at).toLocaleString('ja-JP'))}</time><strong>${yen.format(h.price_yen)}</strong>${i && h.price_yen < data.history[i-1].price_yen ? '<span>↓</span>' : ''}</li>`).join('');
  $('history-content').innerHTML = `<p class="maker">${escapeHtml(data.product.manufacturer)}</p><h2>${escapeHtml(data.product.model || data.product.title)}</h2><ol class="history">${rows || '<li>履歴はまだありません。</li>'}</ol>`;
  $('history-dialog').showModal();
}

let inputTimer;
document.addEventListener('input', e => {
  if (!debouncedInputIds.includes(e.target.id)) return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => loadProducts({ reset: true }), 400);
});

document.addEventListener('change', e => {
  if (e.target.id === 'favoritesOnly') return render();
  if (filterSelectIds.includes(e.target.id)) loadProducts({ reset: true });
});

document.addEventListener('click', e => {
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    const id = Number(fav.dataset.fav);
    state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
    saveFavorites();
    render();
    return;
  }
  const history = e.target.closest('[data-history]');
  if (history) showHistory(history.dataset.history);
  if (e.target.matches('.dialog-close')) $('history-dialog').close();

  const pageButton = e.target.closest('[data-page]');
  if (pageButton && !pageButton.disabled) {
    const page = Number(pageButton.dataset.page);
    if (Number.isInteger(page) && page > 0 && page !== state.currentPage) {
      loadProducts({ page }).then(() => $('products').scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }
  }
});

await loadMeta();
await loadProducts({ reset: true });
