/**
 * The single row -> product-search DTO boundary.
 *
 * Same rule as the listing mapper it sits beside: every read path selects an explicit column list
 * and maps field by field, so a migration that adds a column cannot leak it into a public payload.
 *
 * The entity row carries aggregates over *all* active offers. When the request applied offer-level
 * filters the repository passes a recomputed {@link ProductSearchOfferAggregateRow} for the
 * matching subset, and that wins — a card that says "2 shops" while the user filtered to one shop
 * would be contradicting its own filter.
 */

import { categoryClosureIds, getCategory } from "../catalog/categories.js";
import { directCategoryIds } from "../catalog/listing-components.js";
import { normalizeManufacturer } from "../catalog/manufacturers.js";
import { presentationColorList } from "../catalog/model-presentation-color.js";
import { NEW_OFFER_WINDOW_MS } from "./product-search-entity-sql.js";
import type { ProductOffer, ProductSearchItem } from "../api/contracts.js";
import type {
  ProductSearchEntityRow,
  ProductSearchOfferAggregateRow,
  ProductSearchOfferRow,
} from "./types.js";

/** Entity columns backing {@link ProductSearchItem} and the sort/cursor values, in schema order. */
export const PRODUCT_SEARCH_ENTITY_COLUMNS = [
  "id",
  "entity_key",
  "entity_kind",
  "catalog_product_id",
  "fallback_listing_id",
  "manufacturer_id",
  "manufacturer",
  "model",
  "normalized_model",
  "presentation_colors",
  "direct_category_ids",
  "primary_category_id",
  "offer_count",
  "in_stock_offer_count",
  "sold_out_offer_count",
  "shop_count",
  "lowest_price_yen",
  "lowest_in_stock_price_yen",
  "highest_price_yen",
  "latest_activity_at",
  "newest_listed_at",
  "has_price_drop",
] as const satisfies readonly (keyof ProductSearchEntityRow)[];

/** Listing columns backing {@link ProductOffer}. `id` is aliased to keep the DTO name in SQL. */
const PRODUCT_OFFER_COLUMNS = [
  "shop_key",
  "source_url",
  "title",
  "condition_text",
  "presentation_color",
  "price_yen",
  "previous_price_yen",
  "stock_status",
  "first_seen_at",
  "last_seen_at",
  "last_activity_at",
  "source_published_at",
] as const;

export function entityColumns(alias: string): string {
  return PRODUCT_SEARCH_ENTITY_COLUMNS.map((column) => `${alias}.${column}`).join(", ");
}

export function offerColumns(alias: string): string {
  return [
    `${alias}.id AS listing_product_id`,
    ...PRODUCT_OFFER_COLUMNS.map((column) => `${alias}.${column}`),
  ].join(", ");
}

/** The same names once {@link offerColumns} has been projected through a subquery. */
export function offerProjectionColumns(): string {
  return ["listing_product_id", ...PRODUCT_OFFER_COLUMNS].join(", ");
}

/**
 * Retailer URLs are untrusted data. HTML escaping cannot neutralize a `javascript:` URL, so the
 * public DTO boundary permits only absolute HTTP(S) links. Returning an empty value lets the UI's
 * existing fallback render a non-navigating `#` link for any legacy poisoned row.
 */
export function safeProductSourceUrl(value: string): string {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function toProductOffer(row: ProductSearchOfferRow): ProductOffer {
  return {
    listing_product_id: Number(row.listing_product_id),
    shop_key: row.shop_key,
    source_url: safeProductSourceUrl(row.source_url),
    title: row.title,
    condition_text: row.condition_text,
    presentation_color: row.presentation_color ?? "",
    price_yen: row.price_yen,
    previous_price_yen: row.previous_price_yen,
    stock_status: row.stock_status,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    last_activity_at: row.last_activity_at,
    source_published_at: row.source_published_at,
  };
}

export interface ProductSearchItemContext {
  /** Aggregates over the offers that matched the request, when offer filters narrowed them. */
  aggregate?: ProductSearchOfferAggregateRow | null;
  representativeOffer?: ProductSearchOfferRow | null;
  now?: number;
}

function nullableNumber(value: number | null | undefined): number | null {
  return value == null ? null : Number(value);
}

/** Derived rather than stored: "new" is relative to the request, not to the last projection sync. */
function isNewOffer(newestListedAt: string | null, now: number): boolean {
  if (!newestListedAt) return false;
  const listedMs = new Date(newestListedAt).getTime();
  return Number.isFinite(listedMs) && now - listedMs <= NEW_OFFER_WINDOW_MS;
}

export function toProductSearchItem(
  row: ProductSearchEntityRow,
  { aggregate = null, representativeOffer = null, now = Date.now() }: ProductSearchItemContext = {},
): ProductSearchItem {
  const summary = aggregate ?? row;
  const newestListedAt = summary.newest_listed_at ?? null;
  const directCategories = directCategoryIds(
    String(row.direct_category_ids ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  // Read models are eventually repaired by the versioned remediation queue, but cards must never
  // expose a seller condition badge as part of the brand while that backfill is still catching up.
  // Bootstrap-known brands also recover their canonical public id here; operational aliases keep
  // the id already stored in the entity because their vocabulary lives in D1, not this code map.
  const normalizedManufacturer = normalizeManufacturer(row.manufacturer);
  const publicManufacturer = normalizedManufacturer.displayName || row.manufacturer;
  const publicManufacturerId = normalizedManufacturer.matchedAlias
    ? normalizedManufacturer.id
    : row.manufacturer_id;
  return {
    key: row.entity_key,
    identity_kind: row.entity_kind,
    catalog_product_id: nullableNumber(row.catalog_product_id),
    manufacturer: publicManufacturer,
    manufacturer_id: publicManufacturerId,
    model: row.model,
    // From the same summary as every other aggregate: a card that filtered to one shop must show
    // the finishes that shop offers, not the ones the product exists in somewhere else.
    presentation_colors: presentationColorList(
      String(summary.presentation_colors ?? "").split(","),
    ),
    primary_category_id: row.primary_category_id,
    category_ids: categoryClosureIds(row.primary_category_id),
    direct_category_ids: directCategories,
    // Resolved here rather than in the browser: the frontend may import only `src/api/contracts.ts`
    // from `src`, so it cannot read the taxonomy, and `primary_category_id`/`category` already
    // establish that an id travels with its label.
    direct_categories: directCategories.map((categoryId) => getCategory(categoryId)?.name ?? ""),
    category: getCategory(row.primary_category_id)?.name ?? "",
    offer_count: Number(summary.offer_count || 0),
    in_stock_offer_count: Number(summary.in_stock_offer_count || 0),
    sold_out_offer_count: Number(summary.sold_out_offer_count || 0),
    shop_count: Number(summary.shop_count || 0),
    lowest_price_yen: nullableNumber(summary.lowest_price_yen),
    highest_price_yen: nullableNumber(summary.highest_price_yen),
    latest_activity_at: summary.latest_activity_at ?? null,
    newest_listed_at: newestListedAt,
    has_new_offer: isNewOffer(newestListedAt, now),
    has_price_drop: Boolean(Number(summary.has_price_drop || 0)),
    representative_offer: representativeOffer ? toProductOffer(representativeOffer) : null,
  };
}
