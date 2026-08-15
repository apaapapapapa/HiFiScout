/**
 * The single `products` row -> seller-listing DTO boundary.
 *
 * Every listing read path that feeds an HTTP response goes through {@link toProductListItem}, and
 * every such query selects {@link PRODUCT_LIST_COLUMNS} rather than `SELECT *`. Together they keep
 * a future migration from silently adding a column to the public payload.
 *
 * Product search maps entities instead — see `product-search-entity-mapper.ts`. This mapper now
 * serves the price-history endpoint, which is legitimately scoped to one shop's listing.
 */

import type { ProductListItem } from "../api/contracts.js";
import type { ProductRow } from "./types.js";

/**
 * Public columns backing {@link ProductListItem}, in schema order.
 *
 * Raw source evidence and resolver/remediation provenance are deliberately absent even though they
 * live on the same persistence row. They belong to admin/debug surfaces, not the public wire shape.
 */
export const PRODUCT_LIST_COLUMNS = [
  "id",
  "shop_key",
  "source_id",
  "manufacturer",
  "model",
  "title",
  "category",
  "condition_text",
  "price_yen",
  "stock_status",
  "source_url",
  "first_seen_at",
  "last_seen_at",
  "last_changed_at",
  "previous_price_yen",
  "last_activity_at",
  "source_published_at",
] as const satisfies readonly (keyof ProductRow)[];

/** `productColumns("p")` -> `"p.id, p.shop_key, ..."`. */
export function productColumns(alias: string): string {
  return PRODUCT_LIST_COLUMNS.map((column) => `${alias}.${column}`).join(", ");
}

/** Field-by-field on purpose: spreading the row would re-couple the API to the schema. */
export function toProductListItem(row: ProductRow): ProductListItem {
  return {
    id: row.id,
    shop_key: row.shop_key,
    source_id: row.source_id,
    manufacturer: row.manufacturer,
    model: row.model,
    title: row.title,
    category: row.category,
    condition_text: row.condition_text,
    price_yen: row.price_yen,
    stock_status: row.stock_status,
    source_url: row.source_url,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    last_changed_at: row.last_changed_at,
    previous_price_yen: row.previous_price_yen,
    last_activity_at: row.last_activity_at,
    source_published_at: row.source_published_at,
  };
}
