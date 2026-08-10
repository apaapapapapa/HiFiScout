const $ = id => document.getElementById(id);
const fields = ['q', 'shop', 'manufacturer', 'category', 'minPrice', 'maxPrice', 'sort', 'inStock', 'favoritesOnly'];
const state = { products: [], favorites: new Set(JSON.parse(localStorage.getItem('hifiscout:favorites') || '[]')) };
const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}

function saveFavorites() { localStorage.setItem('hifiscout:favorites', JSON.stringify([...state.favorites])); }

function productCard(p) {
  const favorite = state.favorites.has(p.id);
  const dropped = p.previous_price_yen != null && p.price_yen != null && p.price_yen < p.previous_price_yen;
  const isNew = Date.now() - new Date(p.first_seen_at).getTime() < 48 * 60 * 60 * 1000;
  return `<article class="card" data-id="${p.id}">
    <div class="card-top"><span class="shop shop-${escapeHtml(p.shop_key)}">${escapeHtml(shopName(p.shop_key))}</span><button class="fav" data-fav="${p.id}" aria-label="お気に入り">${favorite ? '★' : '☆'}</button></div>
    <div class="badges">${isNew ? '<span class="badge">NEW</span>' : ''}${dropped ? '<span class="badge">PRICE DOWN</span>' : ''}${p.condition_text ? `<span class="condition">${escapeHtml(p.condition_text)}</span>` : ''}</div>
    <p class="maker">${escapeHtml(p.manufacturer)}</p>
    <h2>${escapeHtml(p.model || p.title)}</h2>
    <p class="category">${escapeHtml(p.category)}</p>
    <div class="price-row"><strong>${p.price_yen == null ? '価格不明' : yen.format(p.price_yen)}</strong>${dropped ? `<del>${yen.format(p.previous_price_yen)}</del>` : ''}</div>
    <div class="stock ${p.stock_status}">${p.stock_status === 'in_stock' ? '在庫あり' : p.stock_status === 'sold_out' ? '売り切れ' : '在庫状態未確認'}</div>
    <p class="updated">観測 ${dateFmt.format(new Date(p.last_seen_at))}</p>
    <div class="actions"><button data-history="${p.id}">価格履歴</button><a href="${escapeHtml(p.source_url)}" target="_blank" rel="noopener noreferrer">販売店で確認 ↗</a></div>
  </article>`;
}

let shops = {};
function shopName(key) { return shops[key]?.name || key; }

async function loadMeta() {
  const meta = await fetch('/api/meta').then(r => r.json());
  shops = Object.fromEntries(meta.shops.map(s => [s.key, s]));
  $('shop').insertAdjacentHTML('beforeend', meta.shops.map(s => `<option value="${escapeHtml(s.key)}">${escapeHtml(s.name)}</option>`).join(''));
  $('manufacturer').insertAdjacentHTML('beforeend', meta.manufacturers.map(v => `<option>${escapeHtml(v)}</option>`).join(''));
  $('category').insertAdjacentHTML('beforeend', meta.categories.map(v => `<option>${escapeHtml(v)}</option>`).join(''));
  $('sync-status').innerHTML = meta.shops.map(s => {
    const last = s.sync?.last_success_at ? dateFmt.format(new Date(s.sync.last_success_at)) : '未取得';
    return `<span>${escapeHtml(s.name)} <b>${last}</b> · ${s.intervalMinutes}分</span>`;
  }).join('');
}

let timer;
async function loadProducts() {
  $('loading').classList.add('show');
  const params = new URLSearchParams();
  for (const id of ['q','shop','manufacturer','category','minPrice','maxPrice','sort']) {
    const value = $(id).value.trim(); if (value) params.set(id, value);
  }
  if ($('inStock').checked) params.set('inStock', 'true');
  params.set('limit', '200');
  try {
    state.products = await fetch(`/api/products?${params}`).then(r => r.json());
    render();
  } finally { $('loading').classList.remove('show'); }
}

function render() {
  const products = $('favoritesOnly').checked ? state.products.filter(p => state.favorites.has(p.id)) : state.products;
  $('count').textContent = products.length;
  $('products').innerHTML = products.length ? products.map(productCard).join('') : '<div class="empty">条件に一致する商品はありません。</div>';
}

async function showHistory(id) {
  const data = await fetch(`/api/products/${id}/history`).then(r => r.json());
  const rows = data.history.map((h, i) => `<li><time>${escapeHtml(new Date(h.observed_at).toLocaleString('ja-JP'))}</time><strong>${yen.format(h.price_yen)}</strong>${i && h.price_yen < data.history[i-1].price_yen ? '<span>↓</span>' : ''}</li>`).join('');
  $('history-content').innerHTML = `<p class="maker">${escapeHtml(data.product.manufacturer)}</p><h2>${escapeHtml(data.product.model || data.product.title)}</h2><ol class="history">${rows || '<li>履歴はまだありません。</li>'}</ol>`;
  $('history-dialog').showModal();
}

document.addEventListener('input', e => {
  if (!fields.includes(e.target.id)) return;
  if (e.target.id === 'favoritesOnly') return render();
  clearTimeout(timer); timer = setTimeout(loadProducts, 250);
});
document.addEventListener('change', e => { if (fields.includes(e.target.id)) loadProducts(); });
document.addEventListener('click', e => {
  const fav = e.target.closest('[data-fav]');
  if (fav) { const id = Number(fav.dataset.fav); state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id); saveFavorites(); render(); return; }
  const history = e.target.closest('[data-history]'); if (history) showHistory(history.dataset.history);
  if (e.target.matches('.dialog-close')) $('history-dialog').close();
});

await loadMeta();
await loadProducts();
