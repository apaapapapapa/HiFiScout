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
  listing_end_observations_json: string | null;
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

function listingEndObservations(raw: string | null): ProductPriceIndexListingEndObservation[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): ProductPriceIndexListingEndObservation[] => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const value = entry as Record<string, unknown>;
      const price = Number(value.price_yen);
      const observedAt = value.observed_at;
      const signal = value.signal_kind;
      if (
        !Number.isFinite(price) ||
        price < 0 ||
        typeof observedAt !== "string" ||
        (signal !== "sold_out" && signal !== "deactivated")
      ) {
        return [];
      }
      return [{ price_yen: price, observed_at: observedAt, signal_kind: signal }];
    });
  } catch {
    return [];
  }
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
    listing_end_observations: listingEndObservations(row.listing_end_observations_json),
    last_computed_at: row.last_computed_at,
  };
}

/**
 * Loads public price-index summaries for catalog products only.
 *
 * Lifetime and listing-end statistics come from the persistent Step 1 aggregate table. Only the
 * time-sensitive trailing-90-day median is recalculated at read time. Recent listing-end evidence
 * is also bounded and scoped to the requested catalog ids before ranking. Ordinary API reads
 * therefore avoid materializing the all-products rollup while keeping the UI evidence factual.
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
        ),
        listing_end_ranked AS (
          SELECT
            s.catalog_product_id,
            s.price_yen,
            s.observed_at,
            s.signal_kind,
            ROW_NUMBER() OVER (
              PARTITION BY s.catalog_product_id
              ORDER BY s.observed_at DESC, s.id DESC
            ) AS recent_order
          FROM knowledge_catalog_price_index_samples s
          JOIN requested q ON q.catalog_product_id = s.catalog_product_id
          WHERE s.sample_kind = 'listing_end'
            AND s.price_yen IS NOT NULL
        ),
        listing_end_recent AS (
          SELECT catalog_product_id, price_yen, observed_at, signal_kind, recent_order
          FROM listing_end_ranked
          WHERE recent_order <= ${LISTING_END_OBSERVATION_LIMIT}
          ORDER BY catalog_product_id, recent_order
        ),
        listing_end_json AS (
          SELECT
            catalog_product_id,
            json_group_array(
              json_object(
                'price_yen', price_yen,
                'observed_at', observed_at,
                'signal_kind', signal_kind
              )
            ) AS listing_end_observations_json
          FROM listing_end_recent
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
               COALESCE(e.listing_end_observations_json, '[]') AS listing_end_observations_json,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS last_computed_at
        FROM requested q
        JOIN knowledge_catalog_price_indexes i ON i.catalog_product_id = q.catalog_product_id
        LEFT JOIN recent_stats r ON r.catalog_product_id = i.catalog_product_id
        LEFT JOIN listing_end_json e ON e.catalog_product_id = i.catalog_product_id
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
