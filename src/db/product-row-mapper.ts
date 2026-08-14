/**
 * The single `products` row -> API DTO boundary.
 *
 * Every read path that feeds an HTTP response goes through {@link toProductListItem}, and every
 * such query selects {@link PRODUCT_LIST_COLUMNS} rather than `SELECT *`. Together they keep a
 * future migration from silently adding a column to the public payload.
 */

import type { ProductListItem } from "../api/contracts.js";
import type { ProductRow } from "./types.js";

/**
 * Columns backing {@link ProductListItem}, in schema order.
 *
 * Typed as `keyof ProductRow` so a renamed column fails to compile here instead of at runtime,
 * and consumed by {@link productColumns} so the SELECT list and the mapper cannot drift.
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
  "is_active",
  "previous_price_yen",
  "metadata_json",
  "raw_manufacturer",
  "manufacturer_id",
  "raw_category",
  "primary_category_id",
  "category_ids",
  "classification_status",
  "search_aliases",
  "last_inventory_checked_at",
  "inventory_check_failures",
  "last_inventory_check_attempt_at",
  "last_activity_at",
  "source_published_at",
] as const satisfies readonly (keyof ProductRow)[];

/** `productColumns("p")` -> `"p.id, p.shop_key, ..."`. */
export function productColumns(alias: string): string {
  return PRODUCT_LIST_COLUMNS.map((column) => `${alias}.${column}`).join(", ");
}

/**
 * `category_ids` is a JSON array column. Malformed values fall back to the primary category so a
 * single bad row cannot fail a whole page.
 */
function parseCategoryIds(row: Pick<ProductRow, "category_ids" | "primary_category_id">): string[] {
  try {
    const parsed: unknown = JSON.parse(row.category_ids || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return row.primary_category_id ? [row.primary_category_id] : [];
  }
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
    is_active: row.is_active,
    previous_price_yen: row.previous_price_yen,
    metadata_json: row.metadata_json,
    raw_manufacturer: row.raw_manufacturer,
    manufacturer_id: row.manufacturer_id,
    raw_category: row.raw_category,
    primary_category_id: row.primary_category_id,
    category_ids: parseCategoryIds(row),
    classification_status: row.classification_status,
    search_aliases: row.search_aliases,
    last_inventory_checked_at: row.last_inventory_checked_at,
    inventory_check_failures: row.inventory_check_failures,
    last_inventory_check_attempt_at: row.last_inventory_check_attempt_at,
    last_activity_at: row.last_activity_at,
    source_published_at: row.source_published_at,
  };
}
