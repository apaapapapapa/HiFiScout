/**
 * Collapsing many sample writes in one transaction into one aggregate recompute per product.
 *
 * The sample triggers recompute a product's whole rollup on every row. That is the right cost for
 * the paths that write one or two samples at a time and the wrong cost for the price-history
 * backfill, which writes up to fifty samples at once and can write many of them for the same
 * product: each row re-reads every sample that product already has, for a value only the last write
 * leaves standing.
 *
 * SQLite has no statement-level trigger, so the coalescing cannot live in the trigger. It lives in
 * the transaction instead. Migration 0080 gives the triggers a deferred half: while a deferral row
 * exists they record which products changed rather than recomputing them, and the same batch drains
 * that record before it commits.
 *
 * Aggregates stay synchronous. The drain is part of the same transaction as the writes, so nothing
 * outside it can observe a sample without its aggregate.
 *
 * The open and the drain are emitted together by {@link deferredPriceIndexRefresh} and never
 * separately: a batch that opened a deferral without draining it would commit stale aggregates, so
 * there is deliberately no way to write only half of it.
 */

import type { QueryableDatabase } from "./types.js";

/**
 * The rollup, restricted at the base to the products the batch touched.
 *
 * This is `knowledge_catalog_price_index_rollup` from migration 0060 with one change: `scoped`
 * filters the sample ledger to the dirty set before the window functions run, so the statistics are
 * computed from the same expressions over the same rows while the read stays on
 * `idx_knowledge_catalog_price_index_samples_catalog`. The view itself cannot be used here for the
 * reason 0071 records -- SQLite will not push an outer `WHERE` through `ROW_NUMBER() OVER
 * (PARTITION BY ...)`, so selecting from it scans the whole ledger three times.
 *
 * `catalog_ids` is taken from `scoped`, so a dirty product whose last sample went away produces no
 * row here and is handled by the delete below instead -- the same division the trigger makes.
 */
const DIRTY_ROLLUP = `
  WITH
  scoped AS (
    SELECT id, catalog_product_id, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id IN (
      SELECT catalog_product_id FROM knowledge_catalog_price_index_dirty_products
    )
  ),
  catalog_ids AS (
    SELECT DISTINCT catalog_product_id FROM scoped
  ),
  asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS asking_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS asking_median_yen,
      MIN(price_yen) AS asking_min_yen,
      MAX(price_yen) AS asking_max_yen
    FROM asking_ranked
    GROUP BY catalog_product_id
  ),
  recent_asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday('now', '-90 days')
  ),
  recent_asking_stats AS (
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
    FROM recent_asking_ranked
    GROUP BY catalog_product_id
  ),
  listing_end_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS listing_end_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS listing_end_median_yen
    FROM listing_end_ranked
    GROUP BY catalog_product_id
  ),
  signal_stats AS (
    SELECT
      catalog_product_id,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'sold_out' THEN 1
          ELSE 0
        END
      ) AS sold_out_signal_count,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'deactivated' THEN 1
          ELSE 0
        END
      ) AS deactivated_signal_count
    FROM scoped
    GROUP BY catalog_product_id
  )
  SELECT
    catalog_ids.catalog_product_id,
    COALESCE(asking_stats.asking_sample_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM catalog_ids
  LEFT JOIN asking_stats USING (catalog_product_id)
  LEFT JOIN recent_asking_stats USING (catalog_product_id)
  LEFT JOIN listing_end_stats USING (catalog_product_id)
  LEFT JOIN signal_stats USING (catalog_product_id)
`;

/**
 * Wraps a batch so its sample writes recompute each changed product once.
 *
 * The returned statements are the caller's, preceded by the deferral and followed by the drain. They
 * are meant for a single `db.batch`: the deferral only means anything inside one transaction, and
 * splitting them across batches would publish samples whose aggregates had not been recomputed.
 *
 * `token` distinguishes concurrent deferrals in the table. Batches are serialized, so in practice
 * only one is ever open; the key exists so a caller cannot close a deferral it did not open.
 */
export function deferredPriceIndexRefresh(
  db: QueryableDatabase,
  token: string,
  statements: readonly D1PreparedStatement[],
): D1PreparedStatement[] {
  return [
    db
      .prepare(`
        INSERT INTO knowledge_catalog_price_index_refresh_deferrals(token, opened_at)
        VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(token) DO NOTHING
      `)
      .bind(token),
    ...statements,
    // A product whose last sample went away produces no rollup row, so the upsert below would leave
    // its aggregate behind. The immediate triggers carry the same clause for the same reason.
    db.prepare(`
      DELETE FROM knowledge_catalog_price_indexes
      WHERE catalog_product_id IN (
        SELECT catalog_product_id FROM knowledge_catalog_price_index_dirty_products
      )
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_catalog_price_index_samples
        WHERE catalog_product_id = knowledge_catalog_price_indexes.catalog_product_id
      )
    `),
    db.prepare(`
      INSERT INTO knowledge_catalog_price_indexes(
        catalog_product_id,
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
      )
      ${DIRTY_ROLLUP}
      ON CONFLICT(catalog_product_id) DO UPDATE SET
        asking_sample_count = excluded.asking_sample_count,
        asking_median_yen = excluded.asking_median_yen,
        asking_min_yen = excluded.asking_min_yen,
        asking_max_yen = excluded.asking_max_yen,
        recent_asking_median_yen = excluded.recent_asking_median_yen,
        listing_end_sample_count = excluded.listing_end_sample_count,
        listing_end_median_yen = excluded.listing_end_median_yen,
        sold_out_signal_count = excluded.sold_out_signal_count,
        deactivated_signal_count = excluded.deactivated_signal_count,
        last_computed_at = excluded.last_computed_at
    `),
    db.prepare("DELETE FROM knowledge_catalog_price_index_dirty_products"),
    db
      .prepare("DELETE FROM knowledge_catalog_price_index_refresh_deferrals WHERE token = ?")
      .bind(token),
  ];
}

/** How many statements {@link deferredPriceIndexRefresh} adds before the caller's own. */
export const DEFERRED_REFRESH_LEADING_STATEMENTS = 1;
