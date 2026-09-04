import {
  PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES,
  type ProductPriceIndexListingEndObservation,
  type ProductPriceIndexSummary,
} from "../api/price-index.js";
import { accountReads } from "./read-accounting.js";
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
 * Loads public price-index summaries from the persistent projection only.
 *
 * The trailing-90-day median ages out through `refreshExpiredRecentPriceIndexes`; ordinary search
 * requests therefore never rank or scan `knowledge_catalog_price_index_samples`, regardless of the
 * number of retained samples for a product.
 */
export async function loadKnowledgeCatalogPriceIndexes(
  db: QueryableDatabase,
  requestedCatalogIds: readonly (number | null)[],
): Promise<Map<number, ProductPriceIndexSummary>> {
  const ids = catalogIds(requestedCatalogIds);
  const summaries = new Map<number, ProductPriceIndexSummary>();
  const accounting = accountReads(db);
  for (const chunk of chunks(ids)) {
    const placeholders = chunk.map(() => "?").join(",");
    const result = await accounting.db
      .prepare(`
        SELECT catalog_product_id,
               asking_sample_count,
               asking_median_yen,
               asking_min_yen,
               asking_max_yen,
               recent_asking_median_yen,
               listing_end_sample_count,
               listing_end_median_yen,
               sold_out_signal_count,
               deactivated_signal_count,
               last_computed_at
        FROM knowledge_catalog_price_indexes
        WHERE catalog_product_id IN (${placeholders})
          AND asking_sample_count >= ?
      `)
      .bind(...chunk, PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES)
      .all<PriceIndexProjectionRow>();
    for (const row of result.results || []) {
      const summary = toSummary(row);
      if (summary) summaries.set(Number(row.catalog_product_id), summary);
    }
  }
  if (ids.length > 0) {
    console.log(
      JSON.stringify({
        event: "price_index_public_read_d1_usage",
        requestedProducts: ids.length,
        projectionRows: summaries.size,
        rowsRead: accounting.rowsRead(),
        rowsWritten: accounting.rowsWritten(),
        countedStatements: accounting.countedStatements(),
        statementCount: accounting.statementCount(),
      }),
    );
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
