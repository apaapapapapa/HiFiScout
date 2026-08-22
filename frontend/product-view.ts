/**
 * HTML builders.
 *
 * Every function here returns a string and reads nothing from the document, so the markup — badge
 * rules, empty states, offer summaries, sync wording — is unit-testable. The caller owns where the
 * string lands.
 *
 * A card is a product. What varies most is how many shops sell it: a single-offer product still
 * links straight to that shop, while a multi-shop product leads to the offer list instead of
 * pretending one arbitrary shop is *the* one.
 */

import { dateFmt, escapeHtml, relativeTime, safeDate, yen } from "./format.js";
import { isLegacyFavoriteKey } from "./favorites.js";
import { activityData, priceDropped } from "./product-activity.js";
import { sortShopsByJapaneseReading } from "./shop-options.js";
import type { MetaCategoryFacet, MetaResponse, MetaShop } from "../src/api/contracts.js";
import type { DisplayOffer, DisplayProduct, PriceHistoryEntry } from "./types.js";

export interface ProductCardContext {
  favorite: boolean;
  /** Display name for a shop key; the card only knows keys. */
  shopName: (shopKey: string) => string;
  now?: number;
}

function stockLabel(status: DisplayOffer["stock_status"]): string {
  if (status === "in_stock") return "在庫あり";
  return status === "sold_out" ? "売り切れ" : "在庫状態未確認";
}

/** "¥300,000" for a single offer, "¥300,000〜" once cheaper and dearer offers can differ. */
function priceSummary(product: DisplayProduct): string {
  if (product.lowest_price_yen == null) return "価格不明";
  const from = yen.format(product.lowest_price_yen);
  const spread =
    product.highest_price_yen != null && product.highest_price_yen > product.lowest_price_yen;
  return spread ? `${from}〜` : from;
}

function offerAvailability(product: DisplayProduct): string {
  if (!product.offer_count) return "取扱なし";
  if (product.in_stock_offer_count === product.offer_count) return "在庫あり";
  if (product.sold_out_offer_count === product.offer_count) return "売り切れ";
  if (!product.in_stock_offer_count) return "在庫状態未確認";
  return `${product.in_stock_offer_count}/${product.offer_count}件が在庫あり`;
}

function offerAvailabilityClass(product: DisplayProduct): DisplayOffer["stock_status"] {
  if (product.in_stock_offer_count) return "in_stock";
  return product.offer_count > 0 && product.sold_out_offer_count === product.offer_count
    ? "sold_out"
    : "unknown";
}

/**
 * The shop chip.
 *
 * A single-offer product keeps the `shop-<key>` class the shop decorator hooks into; a multi-shop
 * product deliberately does not, because there is no one shop for it to link to.
 */
function shopChip(product: DisplayProduct, shopName: (shopKey: string) => string): string {
  if (product.shop_count > 1) {
    return `<span class="shop shop-multiple">${product.shop_count}店舗</span>`;
  }
  const shopKey = product.representative_offer?.shop_key || "";
  const label = shopKey ? shopName(shopKey) : "ショップ不明";
  return `<span class="shop shop-${escapeHtml(shopKey)}">${escapeHtml(label)}</span>`;
}

export function productCard(
  product: DisplayProduct,
  { favorite, shopName, now = Date.now() }: ProductCardContext,
): string {
  const activity = activityData(product, now);
  const badges = [
    activity.isNew
      ? '<span class="badge">NEW</span>'
      : activity.isRecentlyUpdated
        ? '<span class="badge">UPDATED</span>'
        : "",
    priceDropped(product) ? '<span class="badge">PRICE DOWN</span>' : "",
    product.identity_kind === "catalog" && product.shop_count > 1
      ? '<span class="badge badge-compare">比較</span>'
      : "",
  ].join("");
  const title = product.model || product.representative_offer?.title || "商品名不明";
  const key = escapeHtml(product.key);
  const multiOffer = product.offer_count > 1;
  const sourceUrl = escapeHtml(product.representative_offer?.source_url || "#");
  const titleMarkup = multiOffer
    ? `<button type="button" class="product-title-link" data-offers="${key}">${escapeHtml(title)}</button>`
    : `<a class="product-title-link" href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`;
  const condition = multiOffer ? "" : product.representative_offer?.condition_text || "";
  const favoriteLabel = favorite ? "お気に入りから削除" : "お気に入りに追加";
  const hasServerDetail = !isLegacyFavoriteKey(product.key);
  const updated = activity.activity
    ? `${activity.label} ${dateFmt.format(activity.activity)}`
    : "更新日時不明";
  const offersButton = hasServerDetail
    ? multiOffer
      ? `<button class="offers-button" data-offers="${key}" type="button">${product.offer_count}件の在庫を比較</button>`
      : `<button class="offers-button" data-offers="${key}" type="button">商品詳細</button>`
    : "";
  return `<article class="card" data-key="${key}">
    <div class="product-summary">
      <div class="card-top">
        ${shopChip(product, shopName)}
        <div class="badges">${badges}</div>
      </div>
      <p class="maker">${escapeHtml(product.manufacturer || "メーカー不明")}</p>
      <h2>${titleMarkup}</h2>
      <div class="product-submeta">
        <span class="category">${escapeHtml(product.category || "カテゴリ不明")}</span>
        ${condition ? `<span class="condition">${escapeHtml(condition)}</span>` : ""}
      </div>
    </div>
    <div class="product-commerce">
      <div class="price-row"><strong>${escapeHtml(priceSummary(product))}</strong></div>
      <div class="stock ${offerAvailabilityClass(product)}">${escapeHtml(offerAvailability(product))}</div>
      <p class="updated">${escapeHtml(updated)}</p>
    </div>
    <div class="actions">
      <button class="fav" data-fav="${key}" type="button" aria-label="${favoriteLabel}" aria-pressed="${favorite}">${favorite ? "★" : "☆"}</button>
      ${offersButton}
      ${multiOffer ? "" : `<a class="shop-link" href="${sourceUrl}" target="_blank" rel="noopener noreferrer">販売店で確認 ↗</a>`}
    </div>
  </article>`;
}

export interface OfferListContext {
  shopName: (shopKey: string) => string;
}

/**
 * One row per shop.
 *
 * Deliberately keeps the seller's own title and condition text: they are frequently the only thing
 * distinguishing two offers of the same model, so dropping them would make the comparison useless.
 */
export function offerRow(offer: DisplayOffer, { shopName }: OfferListContext): string {
  const dropped =
    offer.previous_price_yen != null &&
    offer.price_yen != null &&
    offer.price_yen < offer.previous_price_yen;
  const price = offer.price_yen == null ? "価格不明" : yen.format(offer.price_yen);
  const previous =
    dropped && offer.previous_price_yen != null
      ? `<del>${yen.format(offer.previous_price_yen)}</del>`
      : "";
  return `<li class="offer">
    <div class="offer-head">
      <span class="offer-shop shop-${escapeHtml(offer.shop_key)}">${escapeHtml(shopName(offer.shop_key))}</span>
      ${offer.condition_text ? `<span class="condition">${escapeHtml(offer.condition_text)}</span>` : ""}
      <span class="stock ${escapeHtml(offer.stock_status)}">${escapeHtml(stockLabel(offer.stock_status))}</span>
    </div>
    <p class="offer-title">${escapeHtml(offer.title)}</p>
    <div class="offer-commerce">
      <strong>${escapeHtml(price)}</strong>${previous}
    </div>
    <div class="offer-actions">
      <button type="button" data-history="${offer.listing_product_id}">価格履歴</button>
      <a class="shop-link" href="${escapeHtml(offer.source_url || "#")}" target="_blank" rel="noopener noreferrer">販売店で確認 ↗</a>
    </div>
  </li>`;
}

/**
 * The offer dialog.
 *
 * An unresolved product says so in plain language rather than showing a debug label: the user is
 * being told the cross-shop comparison is unavailable for this one, not that something is broken.
 */
export function offersMarkup(
  product: DisplayProduct,
  offers: readonly DisplayOffer[],
  context: OfferListContext,
): string {
  const heading = escapeHtml(product.model || product.representative_offer?.title || "商品");
  const identityNote =
    product.identity_kind === "catalog"
      ? `<p class="offers-note">${product.shop_count}店舗 / ${product.offer_count}件の在庫</p>`
      : '<p class="offers-note">この商品はまだ他店の在庫と照合できていません。</p>';
  const rows = offers.map((offer) => offerRow(offer, context)).join("");
  return `<p class="maker">${escapeHtml(product.manufacturer || "メーカー不明")}</p>
    <h2 id="offers-title">${heading}</h2>
    ${identityNote}
    <ol class="offers">${rows || "<li>表示できる在庫がありません。</li>"}</ol>`;
}

export function offersErrorMarkup(): string {
  return '<h2 id="offers-title">在庫一覧</h2><p>在庫情報を取得できませんでした。</p>';
}

/** "No favorites yet" and "no matches" are different situations and get different wording. */
export function emptyState(favoriteMode: boolean, hasFavorites: boolean): string {
  if (favoriteMode && !hasFavorites) {
    return '<div class="empty"><strong>お気に入りはまだありません。</strong><span>商品一覧の☆からこの端末に保存できます。</span></div>';
  }
  return '<div class="empty"><strong>条件に一致する商品はありません。</strong><button type="button" data-clear-all>条件をすべて解除</button></div>';
}

export function errorState(message: string): string {
  return `<div class="empty"><strong>${escapeHtml(message)}</strong><button type="button" data-retry>再読み込み</button></div>`;
}

/**
 * Favorites saved by a build that stored bare listing ids.
 *
 * Those entries carry no snapshot, and a search that returns products can no longer resolve a
 * listing id, so they are reported rather than silently dropped or guessed at.
 */
export function legacyFavoritesNotice(count: number): string {
  if (!count) return "";
  return `<div class="legacy-favorites-note">旧形式で保存されたお気に入りが${count}件あります。商品情報が保存されていないため表示できません。</div>`;
}

/** Gaps in `numbers` become an ellipsis; see `pageNumbers()` for where the gaps come from. */
export function paginationMarkup(
  numbers: readonly number[],
  currentPage: number,
  loading: boolean,
): string {
  const parts: string[] = [];
  numbers.forEach((page, index) => {
    if (index && page - numbers[index - 1] > 1) {
      parts.push('<span class="page-ellipsis" aria-hidden="true">…</span>');
    }
    const current = page === currentPage;
    parts.push(
      `<button type="button" class="page-button${current ? " active" : ""}" data-page="${page}" aria-label="${page}ページ目"${current ? ' aria-current="page"' : ""}${loading ? " disabled" : ""}>${page}</button>`,
    );
  });
  return parts.join("");
}

const CATEGORY_SEPARATOR = '<option disabled data-category-separator="true">────────────</option>';

/**
 * Renders category metadata in server order.
 *
 * A top-level, non-classifiable category is a visual group heading in the flat `<select>`. The
 * separator belongs to this deterministic projection, not to a MutationObserver in the HTML shell,
 * so order and separator placement are unit-testable without a browser.
 */
export function categoryOptions(meta: MetaResponse): string {
  const facets = Array.isArray(meta.categoryFacets) ? meta.categoryFacets : [];
  if (!facets.length) {
    return (meta.categories || []).map((value) => `<option>${escapeHtml(value)}</option>`).join("");
  }

  const ungrouped: MetaCategoryFacet[] = [];
  const grouped = new Map<string, MetaCategoryFacet[]>();
  for (const facet of facets) {
    if (!facet?.id || !facet?.name) continue;
    if (!facet.group) {
      ungrouped.push(facet);
      continue;
    }
    if (!grouped.has(facet.group)) grouped.set(facet.group, []);
    grouped.get(facet.group)?.push(facet);
  }

  const option = (facet: MetaCategoryFacet) =>
    `<option value="${escapeHtml(facet.id)}">${escapeHtml(facet.name)}</option>`;
  const topLevel = ungrouped
    .map((facet) => {
      const topLevelFacet = facet.parentId === null;
      const before =
        topLevelFacet && (!facet.classifiable || facet.id === "dj_dtm") ? CATEGORY_SEPARATOR : "";
      const after = topLevelFacet && facet.id === "dj_dtm" ? CATEGORY_SEPARATOR : "";
      return `${before}${option(facet)}${after}`;
    })
    .join("");
  const groups = [...grouped.entries()]
    .map(
      ([group, values]) =>
        `<optgroup label="${escapeHtml(group)}">${values.map(option).join("")}</optgroup>`,
    )
    .join("");
  return topLevel + groups;
}

export type SyncStatusClass = "healthy" | "warning" | "critical";

export interface SyncStatusSummary {
  status: SyncStatusClass;
  summary: string;
}

/**
 * Headline sync state.
 *
 * Disabled shops are excluded before grading: a deliberately switched-off collector is not a
 * problem. The server's own `status` wins when present; the local tally is the fallback.
 */
export function syncStatusSummary(meta: MetaResponse): SyncStatusSummary {
  const enabled = (meta.shops || []).filter((shop) => shop.enabled !== false);
  const problems = enabled.filter((shop) =>
    ["warning", "critical"].includes(shop.health?.status ?? ""),
  );
  const critical = problems.filter((shop) => shop.health?.status === "critical");
  const reported =
    meta.status || (critical.length ? "critical" : problems.length ? "warning" : "healthy");
  const status: SyncStatusClass =
    reported === "critical" ? "critical" : reported === "warning" ? "warning" : "healthy";
  const summary =
    reported === "critical"
      ? `⚠ ${Math.max(critical.length, problems.length)}店舗で更新に問題があります`
      : reported === "warning"
        ? `⚠ ${problems.length}店舗で更新が遅れています`
        : "データ更新 正常";
  return { status, summary };
}

const HEALTH_LABELS: Record<string, string> = {
  healthy: "正常",
  warning: "遅延",
  critical: "要確認",
  disabled: "停止中",
};

export function syncShopRows(shops: readonly MetaShop[], now = Date.now()): string {
  return sortShopsByJapaneseReading(shops)
    .map((shop) => {
      const health = shop.health;
      const healthStatus = health?.status || (shop.enabled === false ? "disabled" : "unknown");
      const label = HEALTH_LABELS[healthStatus] || "未確認";
      const lastSuccess = health?.lastSuccessAt || shop.sync?.last_success_at || null;
      const exact = safeDate(lastSuccess)?.toLocaleString("ja-JP") || "未取得";
      return `<div class="sync-shop-row ${escapeHtml(healthStatus)}">
      <span class="sync-shop-name">${escapeHtml(shop.name)}</span>
      <span class="sync-shop-health">${escapeHtml(label)}</span>
      <time title="${escapeHtml(exact)}">${escapeHtml(relativeTime(lastSuccess, now))}</time>
    </div>`;
    })
    .join("");
}

/** Price history is one shop's offer, so its heading names the listing rather than the product. */
export function priceHistoryMarkup(
  listing: { manufacturer: string; model: string; title: string },
  history: readonly PriceHistoryEntry[],
): string {
  const rows = history
    .map(
      (entry, index) =>
        `<li><time>${escapeHtml(new Date(entry.observed_at).toLocaleString("ja-JP"))}</time><strong>${yen.format(entry.price_yen)}</strong>${index && entry.price_yen < history[index - 1].price_yen ? "<span>↓</span>" : ""}</li>`,
    )
    .join("");
  return `<p class="maker">${escapeHtml(listing.manufacturer)}</p><h2 id="history-title">${escapeHtml(listing.model || listing.title)}</h2><ol class="history">${rows || "<li>履歴はまだありません。</li>"}</ol>`;
}

export function priceHistoryErrorMarkup(): string {
  return '<h2 id="history-title">価格履歴</h2><p>価格履歴を取得できませんでした。</p>';
}
