import {
  PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES,
  type ProductPriceIndexSummary,
} from "../api/price-index.js";
import type { QueryableDatabase } from "./types.js";

/** Keep one statement comfortably below D1's 100-bound-parameter ceiling. */
const PRICE_INDEX_READ_CHUNK_SIZE = 90;

interface PriceIndexProjectionRow {
  catalog_product_id: number;
  asking_sample_count: number;
  asking_median_yen: number | null;
  asking_min_yen: number | null;
  asking_max_yen: number | null;
  recent_asking_median_yen: number | null;
  listing_end_sample_count: number;
  listing_end_median_yen: number | null;
  sold_out_signal_count: number;
  deactivated_signal_count: number;
  last_computed_at: string;
}

function chunks(values: readonly number[]): number[][] {
  const result: number[][] = [];
  for (let index = 0; index < values.length; index += PRICE_INDEX_READ_CHUNK_SIZE) {
    result.push(values.slice(index, index + PRICE_INDEX_READ_CHUNK_SIZE));
  }
  return result;
}

function catalogIds(values: readonly (number | null)[]): number[] {
  return [
    ...new Set(
      values.filter(
        (value): value is number =>
          value != null && Number.isSafeInteger(value) && Number(value) > 0,
      ),
    ),
  ];
}

function nullableNumber(value: number | null): number | null {
  return value == null ? null : Number(value);
}

function toSummary(row: PriceIndexProjectionRow): ProductPriceIndexSummary | null {
  const askingSampleCount = Number(row.asking_sample_count || 0);
  const median = nullableNumber(row.asking_median_yen);
  const min = nullableNumber(row.asking_min_yen);
  const max = nullableNumber(row.asking_max_yen);
  if (
    askingSampleCount < PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES ||
    median == null ||
    min == null ||
    max == null
  ) {
    return null;
  }
  return {
    asking_sample_count: askingSampleCount,
    asking_median_yen: median,
    asking_min_yen: min,
    asking_max_yen: max,
    recent_asking_median_yen: nullableNumber(row.recent_asking_median_yen),
    listing_end_sample_count: Number(row.listing_end_sample_count || 0),
    listing_end_median_yen: nullableNumber(row.listing_end_median_yen),
    sold_out_signal_count: Number(row.sold_out_signal_count || 0),
    deactivated_signal_count: Number(row.deactivated_signal_count || 0),
    last_computed_at: row.last_computed_at,
  };
}

/**
 * Loads public price-index summaries for catalog products only.
 *
 * The materialized aggregate remains the persistent Step 1 index, but the API intentionally reads
 * the canonical rollup view: its trailing-90-day median is evaluated against SQLite `now`, so a
 * quiet product cannot keep an expired "recent" sample forever merely because no write happened.
 */
export async function loadKnowledgeCatalogPriceIndexes(
  db: QueryableDatabase,
  requestedCatalogIds: readonly (number | null)[],
): Promise<Map<number, ProductPriceIndexSummary>> {
  const ids = catalogIds(requestedCatalogIds);
  const summaries = new Map<number, ProductPriceIndexSummary>();
  for (const chunk of chunks(ids)) {
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT r.catalog_product_id,
               r.asking_sample_count,
               r.asking_median_yen,
               r.asking_min_yen,
               r.asking_max_yen,
               r.recent_asking_median_yen,
               r.listing_end_sample_count,
               r.listing_end_median_yen,
               r.sold_out_signal_count,
               r.deactivated_signal_count,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS last_computed_at
        FROM knowledge_catalog_price_index_rollup r
        WHERE r.catalog_product_id IN (${placeholders})
          AND r.asking_sample_count >= ?
      `)
      .bind(...chunk, PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES)
      .all<PriceIndexProjectionRow>();
    for (const row of result.results || []) {
      const summary = toSummary(row);
      if (summary) summaries.set(Number(row.catalog_product_id), summary);
    }
  }
  return summaries;
}
