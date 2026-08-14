/**
 * HTML builders.
 *
 * Every function here returns a string and reads nothing from the document, so the markup — badge
 * rules, empty states, sync wording — is unit-testable. The caller owns where the string lands.
 */

import { dateFmt, escapeHtml, relativeTime, safeDate, yen } from "./format.js";
import { activityData, priceDropped } from "./product-activity.js";
import type { MetaCategoryFacet, MetaResponse, MetaShop } from "../src/api/contracts.js";
import type { DisplayProduct, PriceHistoryEntry } from "./types.js";

export interface ProductCardContext {
  favorite: boolean;
  shopName: string;
  now?: number;
}

export function productCard(
  product: DisplayProduct,
  { favorite, shopName, now = Date.now() }: ProductCardContext,
): string {
  const dropped = priceDropped(product);
  const previousPrice = product.previous_price_yen;
  const activity = activityData(product, now);
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
        <span class="shop shop-${escapeHtml(product.shop_key)}">${escapeHtml(shopName)}</span>
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
      <div class="price-row"><strong>${product.price_yen == null ? "価格不明" : yen.format(product.price_yen)}</strong>${dropped && previousPrice != null ? `<del>${yen.format(previousPrice)}</del>` : ""}</div>
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

export function legacyFavoritesNotice(count: number): string {
  if (!count) return "";
  return `<div class="legacy-favorites-note">旧形式で保存されたお気に入りが${count}件あります。商品一覧で再表示されると、この端末内で自動的に移行されます。</div>`;
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

const CATEGORY_SEPARATOR =
  '<option disabled data-category-separator="true">────────────</option>';

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
    .map(
      (facet) =>
        `${facet.parentId === null && !facet.classifiable ? CATEGORY_SEPARATOR : ""}${option(facet)}`,
    )
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
  return shops
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

/** A `↓` marks each point cheaper than the one before it, so drops are visible at a glance. */
export function priceHistoryMarkup(
  product: DisplayProduct,
  history: readonly PriceHistoryEntry[],
): string {
  const rows = history
    .map(
      (entry, index) =>
        `<li><time>${escapeHtml(new Date(entry.observed_at).toLocaleString("ja-JP"))}</time><strong>${yen.format(entry.price_yen)}</strong>${index && entry.price_yen < history[index - 1].price_yen ? "<span>↓</span>" : ""}</li>`,
    )
    .join("");
  return `<p class="maker">${escapeHtml(product.manufacturer)}</p><h2 id="history-title">${escapeHtml(product.model || product.title)}</h2><ol class="history">${rows || "<li>履歴はまだありません。</li>"}</ol>`;
}

export function priceHistoryErrorMarkup(): string {
  return '<h2 id="history-title">価格履歴</h2><p>価格履歴を取得できませんでした。</p>';
}
