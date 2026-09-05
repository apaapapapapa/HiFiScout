import { priceIndexRollupUpsertSql } from "./price-index-rollup.js";
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
    db.prepare(
      priceIndexRollupUpsertSql(
        "catalog_product_id IN (SELECT catalog_product_id FROM knowledge_catalog_price_index_dirty_products)",
      ),
    ),
    db.prepare("DELETE FROM knowledge_catalog_price_index_dirty_products"),
    db
      .prepare("DELETE FROM knowledge_catalog_price_index_refresh_deferrals WHERE token = ?")
      .bind(token),
  ];
}

/** How many statements {@link deferredPriceIndexRefresh} adds before the caller's own. */
export const DEFERRED_REFRESH_LEADING_STATEMENTS = 1;
