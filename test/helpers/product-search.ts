import type { ProductSearchEntityRow, ProductSearchOfferRow } from "../../src/db/types.js";

/**
 * A search entity row with every column present.
 *
 * `entity_key` defaults to the catalog form of `id` so a test that only cares about ordering can
 * still assert on stable public keys.
 */
export function entityRow(
  overrides: Partial<ProductSearchEntityRow> & Record<string, unknown> = {},
): ProductSearchEntityRow {
  const id = Number(overrides.id ?? 1);
  return {
    id,
    entity_key: `c-${id}`,
    entity_kind: "catalog",
    catalog_product_id: id,
    fallback_listing_id: null,
    manufacturer_id: "luxman",
    manufacturer: "LUXMAN",
    model: "L-507Z",
    normalized_model: "L507Z",
    primary_category_id: "integrated_amp",
    offer_count: 1,
    in_stock_offer_count: 1,
    sold_out_offer_count: 0,
    shop_count: 1,
    lowest_price_yen: 300_000,
    lowest_in_stock_price_yen: 300_000,
    highest_price_yen: 300_000,
    latest_activity_at: "2026-08-12T00:00:00Z",
    newest_listed_at: "2026-08-12T00:00:00Z",
    has_price_drop: 0,
    ...overrides,
  } as ProductSearchEntityRow;
}

/** A seller offer row as the entity offer queries project it. */
export function offerRow(overrides: Partial<ProductSearchOfferRow> = {}): ProductSearchOfferRow {
  return {
    listing_product_id: 1,
    shop_key: "hifido",
    source_url: "https://example.test/listing",
    title: "LUXMAN L-507Z",
    condition_text: "中古",
    price_yen: 300_000,
    previous_price_yen: null,
    stock_status: "in_stock",
    first_seen_at: "2026-08-12T00:00:00Z",
    last_seen_at: "2026-08-12T00:00:00Z",
    last_activity_at: "2026-08-12T00:00:00Z",
    source_published_at: null,
    ...overrides,
  };
}
