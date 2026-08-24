/** Pure display models for React; this module never emits markup or mutates the DOM. */
import { relativeTime, safeDate, yen } from "./format.js";
import { sortShopsByJapaneseReading } from "./shop-options.js";
import type { MetaCategoryFacet, MetaResponse, MetaShop } from "../src/api/contracts.js";
import type { DisplayOffer, DisplayProduct } from "./types.js";

export function stockLabel(status: DisplayOffer["stock_status"]): string {
  if (status === "in_stock") return "在庫あり";
  return status === "sold_out" ? "売り切れ" : "在庫状態未確認";
}

/**
 * The finishes to show beside a product name.
 *
 * A product groups its colours rather than splitting into one card per colour, so this can be
 * several labels. Falls back to the representative offer for a card restored from a favorite
 * written before the product-level field existed.
 */
export function productColors(product: DisplayProduct): string[] {
  if (product.presentation_colors?.length) return product.presentation_colors;
  const offerColor = product.representative_offer?.presentation_color;
  return offerColor ? [offerColor] : [];
}

export function priceSummary(product: DisplayProduct): string {
  if (product.lowest_price_yen == null) return "価格不明";
  const from = yen.format(product.lowest_price_yen);
  const spread =
    product.highest_price_yen != null && product.highest_price_yen > product.lowest_price_yen;
  return spread ? `${from}〜` : from;
}

export function offerAvailability(product: DisplayProduct): string {
  if (!product.offer_count) return "取扱なし";
  if (product.in_stock_offer_count === product.offer_count) return "在庫あり";
  if (product.sold_out_offer_count === product.offer_count) return "売り切れ";
  if (!product.in_stock_offer_count) return "在庫状態未確認";
  return `${product.in_stock_offer_count}/${product.offer_count}件が在庫あり`;
}

export function offerAvailabilityClass(product: DisplayProduct): DisplayOffer["stock_status"] {
  if (product.in_stock_offer_count) return "in_stock";
  return product.offer_count > 0 && product.sold_out_offer_count === product.offer_count
    ? "sold_out"
    : "unknown";
}

export interface CategoryOptionGroup {
  label: string;
  values: MetaCategoryFacet[];
}

export interface CategoryOptionModel {
  topLevel: Array<MetaCategoryFacet | "separator">;
  groups: CategoryOptionGroup[];
  legacy: string[];
}

export function categoryOptionModel(meta: MetaResponse): CategoryOptionModel {
  const facets = Array.isArray(meta.categoryFacets) ? meta.categoryFacets : [];
  if (!facets.length) return { topLevel: [], groups: [], legacy: meta.categories || [] };

  const ungrouped: MetaCategoryFacet[] = [];
  const grouped = new Map<string, MetaCategoryFacet[]>();
  for (const facet of facets) {
    if (!facet?.id || !facet?.name) continue;
    if (!facet.group) {
      ungrouped.push(facet);
      continue;
    }
    const values = grouped.get(facet.group) ?? [];
    values.push(facet);
    grouped.set(facet.group, values);
  }

  const topLevel: Array<MetaCategoryFacet | "separator"> = [];
  for (const facet of ungrouped) {
    const top = facet.parentId === null;
    if (top && (!facet.classifiable || facet.id === "dj_dtm")) topLevel.push("separator");
    topLevel.push(facet);
    if (top && facet.id === "dj_dtm") topLevel.push("separator");
  }

  return {
    topLevel,
    groups: [...grouped.entries()].map(([label, values]) => ({ label, values })),
    legacy: [],
  };
}

export type SyncStatusClass = "healthy" | "warning" | "critical";

export interface SyncStatusSummary {
  status: SyncStatusClass;
  summary: string;
}

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

export interface SyncShopPresentation {
  key: string;
  name: string;
  status: string;
  label: string;
  exact: string;
  relative: string;
}

export function syncShopPresentations(
  shops: readonly MetaShop[],
  now = Date.now(),
): SyncShopPresentation[] {
  return sortShopsByJapaneseReading(shops).map((shop) => {
    const status = shop.health?.status || (shop.enabled === false ? "disabled" : "unknown");
    const lastSuccess = shop.health?.lastSuccessAt || shop.sync?.last_success_at || null;
    const exact = lastSuccess
      ? safeDate(lastSuccess)?.toLocaleString("ja-JP") || "未取得"
      : "未取得";
    return {
      key: shop.key,
      name: shop.name,
      status,
      label: HEALTH_LABELS[status] || "未確認",
      exact,
      relative: lastSuccess ? relativeTime(lastSuccess, now) : "未取得",
    };
  });
}

export function safeExternalUrl(value: string | null | undefined): string {
  if (!value) return "#";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "#";
  } catch {
    return "#";
  }
}

export const SHOP_LISTING_URLS: Readonly<Record<string, string>> = Object.freeze({
  audiounion: "https://www.audiounion.jp/st/new_arrival_used.html",
  ippinkan: "https://ippinkan.jp/shopbrand/U100000/",
  "fujiya-avic": "https://www.fujiya-avic.co.jp/shop/e/ea-usednw_s1/?ps=50",
  hifido: "https://www.hifido.co.jp/?L=50&LNG=J&O=0&OD=0",
  formusic: "https://shop.formusic.jp/",
  "u-audio": "https://www.u-audio.com/",
});
