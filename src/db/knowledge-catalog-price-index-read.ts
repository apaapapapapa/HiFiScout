import {
  PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES,
  type ProductPriceIndexListingEndObservation,
  type ProductPriceIndexSummary,
} from "../api/price-index.js";
import type { QueryableDatabase } from "./types.js";

/** Keep one statement comfortably below D1's bound-parameter ceiling. */
const PRICE_INDEX_READ_CHUNK_SIZE = 90;
/** Detail UI shows recent evidence, not an unbounded listing-end log. */
const LISTING_END_OBSERVATION_LIMIT = 5;

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

interface ListingEndObservationRow {
  price_yen: number | null;
  observed_at: string;
  signal_kind: string;
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
 * Lifetime and listing-end statistics come from the persistent Step 1 aggregate table. Only the
 * time-sensitive trailing-90-day median is recalculated at read time, and its sample scan is joined
 * to the requested catalog ids before ranking. Ordinary API reads therefore avoid materializing the
 * all-products rollup while still letting old "recent" samples age out without a write.
 */
export async function loadKnowledgeCatalogPriceIndexes(
  db: QueryableDatabase,
  requestedCatalogIds: readonly (number | null)[],
): Promise<Map<number, ProductPriceIndexSummary>> {
  const ids = catalogIds(requestedCatalogIds);
  const summaries = new Map<number, ProductPriceIndexSummary>();
  for (const chunk of chunks(ids)) {
    const requestedValues = chunk.map(() => "(?)").join(",");
    const result = await db
      .prepare(`
        WITH requested(catalog_product_id) AS (
          VALUES ${requestedValues}
        ),
        recent_ranked AS (
          SELECT
            s.catalog_product_id,
            s.price_yen,
            ROW_NUMBER() OVER (
              PARTITION BY s.catalog_product_id
              ORDER BY s.price_yen, s.id
            ) AS row_number,
            COUNT(*) OVER (PARTITION BY s.catalog_product_id) AS sample_count
          FROM knowledge_catalog_price_index_samples s
          JOIN requested q ON q.catalog_product_id = s.catalog_product_id
          WHERE s.sample_kind = 'asking'
            AND s.price_yen IS NOT NULL
            AND julianday(s.observed_at) >= julianday('now', '-90 days')
        ),
        recent_stats AS (
          SELECT
            catalog_product_id,
            CAST(
              ROUND(
                AVG(
                  CASE
                    WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                      THEN price_yen
                  END
                )
              ) AS INTEGER
            ) AS recent_asking_median_yen
          FROM recent_ranked
          GROUP BY catalog_product_id
        )
        SELECT i.catalog_product_id,
               i.asking_sample_count,
               i.asking_median_yen,
               i.asking_min_yen,
               i.asking_max_yen,
               r.recent_asking_median_yen,
               i.listing_end_sample_count,
               i.listing_end_median_yen,
               i.sold_out_signal_count,
               i.deactivated_signal_count,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS last_computed_at
        FROM requested q
        JOIN knowledge_catalog_price_indexes i ON i.catalog_product_id = q.catalog_product_id
        LEFT JOIN recent_stats r ON r.catalog_product_id = i.catalog_product_id
        WHERE i.asking_sample_count >= ?
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

/**
 * Loads the small factual listing-end evidence list shown only on the product-detail surface.
 * Search cards use aggregate statistics only, so this event read never scales with page size.
 */
export async function loadKnowledgeCatalogListingEndObservations(
  db: QueryableDatabase,
  catalogProductId: number,
): Promise<ProductPriceIndexListingEndObservation[]> {
  if (!Number.isSafeInteger(catalogProductId) || catalogProductId <= 0) return [];
  const result = await db
    .prepare(`
      SELECT price_yen, observed_at, signal_kind
      FROM knowledge_catalog_price_index_samples
      WHERE catalog_product_id = ?
        AND sample_kind = 'listing_end'
        AND price_yen IS NOT NULL
      ORDER BY observed_at DESC, id DESC
      LIMIT ?
    `)
    .bind(catalogProductId, LISTING_END_OBSERVATION_LIMIT)
    .all<ListingEndObservationRow>();

  return (result.results || []).flatMap((row): ProductPriceIndexListingEndObservation[] => {
    const price = nullableNumber(row.price_yen);
    if (
      price == null ||
      price < 0 ||
      typeof row.observed_at !== "string" ||
      (row.signal_kind !== "sold_out" && row.signal_kind !== "deactivated")
    ) {
      return [];
    }
    return [{ price_yen: price, observed_at: row.observed_at, signal_kind: row.signal_kind }];
  });
}
