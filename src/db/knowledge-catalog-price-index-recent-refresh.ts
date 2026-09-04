import { firstMeasured } from "./read-accounting.js";
import type { QueryableDatabase } from "./types.js";

const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 25;
const BACKFILL_KEY = "recent-price-index-v1";

interface CatalogProductIdRow {
  catalog_product_id: number;
}

interface RecentPriceIndexBackfillRunRow {
  after_catalog_product_id: number;
  status: "running" | "completed";
}

export interface RecentPriceIndexRefreshOptions {
  now?: Date;
  limit?: number;
}

export interface RecentPriceIndexRefreshResult {
  selectedCount: number;
  refreshedCount: number;
  hasMore: boolean;
}

export interface RecentPriceIndexBackfillResult extends RecentPriceIndexRefreshResult {
  status: "running" | "completed";
  afterCatalogProductId: number;
}

function refreshLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIMIT) {
    throw new Error(`Recent price-index refresh limit must be in [1, ${MAX_LIMIT}]`);
  }
  return value;
}

function cutoffAt(now: Date): string {
  return new Date(now.getTime() - RECENT_WINDOW_MS).toISOString();
}

function medianRefreshStatement(
  db: QueryableDatabase,
  catalogProductId: number,
  cutoff: string,
  at: string,
): D1PreparedStatement {
  return db
    .prepare(`
      UPDATE knowledge_catalog_price_indexes
      SET recent_asking_median_yen = (
            WITH ranked AS (
              SELECT
                price_yen,
                ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
                COUNT(*) OVER () AS sample_count
              FROM knowledge_catalog_price_index_samples
              WHERE catalog_product_id = ?
                AND sample_kind = 'asking'
                AND price_yen IS NOT NULL
                AND observed_at >= ?
            )
            SELECT CAST(
              ROUND(
                AVG(
                  CASE
                    WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                      THEN price_yen
                  END
                )
              ) AS INTEGER
            )
            FROM ranked
          ),
          last_computed_at = ?
      WHERE catalog_product_id = ?
    `)
    .bind(catalogProductId, cutoff, at, catalogProductId);
}

function expiryRefreshStatement(
  db: QueryableDatabase,
  catalogProductId: number,
  cutoff: string,
  at: string,
): D1PreparedStatement {
  return db
    .prepare(`
      INSERT INTO knowledge_catalog_price_index_recent_refreshes(
        catalog_product_id,
        next_expiry_at,
        updated_at
      ) VALUES (
        ?,
        (
            SELECT MIN(strftime('%Y-%m-%dT%H:%M:%fZ', observed_at, '+90 days'))
            FROM knowledge_catalog_price_index_samples
            WHERE catalog_product_id = ?
              AND sample_kind = 'asking'
              AND price_yen IS NOT NULL
              AND observed_at >= ?
        ),
        ?
      )
      ON CONFLICT(catalog_product_id) DO UPDATE SET
        next_expiry_at = excluded.next_expiry_at,
        updated_at = excluded.updated_at
    `)
    .bind(catalogProductId, catalogProductId, cutoff, at);
}

function refreshedProductCount(
  results: readonly D1Result<unknown>[],
  productCount: number,
): number {
  let refreshedCount = 0;
  for (let index = 0; index < productCount; index += 1) {
    refreshedCount += Number(results[index * 2]?.meta?.changes || 0) > 0 ? 1 : 0;
  }
  return refreshedCount;
}

/**
 * Rebuilds one bounded keyset page of the persistent recent-median projection.
 *
 * Migration 0078 creates only schema, triggers, and one constant-size cursor row.  This routine is
 * the data migration: it selects at most 26 projection ids (25 plus lookahead), refreshes at most 25
 * products, and advances the cursor in the same atomic D1 batch as those writes.  Replaying a page
 * is harmless because both product updates are deterministic upserts.
 */
export async function backfillRecentPriceIndexes(
  db: QueryableDatabase,
  options: RecentPriceIndexRefreshOptions = {},
): Promise<RecentPriceIndexBackfillResult> {
  const now = options.now || new Date();
  const at = now.toISOString();
  const cutoff = cutoffAt(now);
  const limit = refreshLimit(options.limit);
  const run = await firstMeasured<RecentPriceIndexBackfillRunRow>(
    db
      .prepare(`
        SELECT after_catalog_product_id, status
        FROM knowledge_catalog_price_index_recent_backfill_runs
        WHERE backfill_key = ?
      `)
      .bind(BACKFILL_KEY),
  );
  if (!run) throw new Error(`Recent price-index backfill state is missing for ${BACKFILL_KEY}`);
  const previousCursor = Number(run.after_catalog_product_id);
  if (run.status === "completed") {
    return {
      status: "completed",
      selectedCount: 0,
      refreshedCount: 0,
      afterCatalogProductId: previousCursor,
      hasMore: false,
    };
  }

  const candidateResult = await db
    .prepare(`
      SELECT catalog_product_id
      FROM knowledge_catalog_price_indexes
      WHERE catalog_product_id > ?
      ORDER BY catalog_product_id ASC
      LIMIT ?
    `)
    .bind(previousCursor, limit + 1)
    .all<CatalogProductIdRow>();
  const candidatesWithLookahead = candidateResult.results || [];
  const candidates = candidatesWithLookahead.slice(0, limit);
  const hasMore = candidatesWithLookahead.length > limit;
  if (!candidates.length) {
    await db
      .prepare(`
        UPDATE knowledge_catalog_price_index_recent_backfill_runs
        SET status = 'completed', updated_at = ?, completed_at = ?
        WHERE backfill_key = ? AND status = 'running'
      `)
      .bind(at, at, BACKFILL_KEY)
      .run();
    return {
      status: "completed",
      selectedCount: 0,
      refreshedCount: 0,
      afterCatalogProductId: previousCursor,
      hasMore: false,
    };
  }

  const nextCursor = Number(candidates[candidates.length - 1]?.catalog_product_id || 0);
  const nextStatus = hasMore ? "running" : "completed";
  const productStatements = candidates.flatMap(({ catalog_product_id }) => {
    const id = Number(catalog_product_id);
    return [medianRefreshStatement(db, id, cutoff, at), expiryRefreshStatement(db, id, cutoff, at)];
  });
  const stateUpdate = db
    .prepare(`
      UPDATE knowledge_catalog_price_index_recent_backfill_runs
      SET after_catalog_product_id = ?,
          status = ?,
          updated_at = ?,
          completed_at = ?
      WHERE backfill_key = ?
        AND status = 'running'
        AND after_catalog_product_id = ?
    `)
    .bind(nextCursor, nextStatus, at, hasMore ? null : at, BACKFILL_KEY, previousCursor);
  const results = await db.batch([...productStatements, stateUpdate]);

  return {
    status: nextStatus,
    selectedCount: candidates.length,
    refreshedCount: refreshedProductCount(results, candidates.length),
    afterCatalogProductId: nextCursor,
    hasMore,
  };
}

/**
 * Refreshes only recent-price projections whose oldest in-window sample has expired.
 *
 * The selector is driven by the partial `(next_expiry_at, catalog_product_id)` index.  A product is
 * not due at the exact 90-day boundary because the public definition is inclusive (`>= cutoff`);
 * it becomes due only after that instant (`next_expiry_at < now`).  Each selected product then pays
 * one product-scoped sample ranking and one product-scoped MIN to establish its next boundary.
 */
export async function refreshExpiredRecentPriceIndexes(
  db: QueryableDatabase,
  options: RecentPriceIndexRefreshOptions = {},
): Promise<RecentPriceIndexRefreshResult> {
  const now = options.now || new Date();
  const at = now.toISOString();
  const cutoff = cutoffAt(now);
  const limit = refreshLimit(options.limit);

  const dueResult = await db
    .prepare(`
      SELECT catalog_product_id
      FROM knowledge_catalog_price_index_recent_refreshes
      WHERE next_expiry_at < ?
      ORDER BY next_expiry_at ASC, catalog_product_id ASC
      LIMIT ?
    `)
    .bind(at, limit + 1)
    .all<CatalogProductIdRow>();
  const dueWithLookahead = dueResult.results || [];
  const due = dueWithLookahead.slice(0, limit);
  if (!due.length) return { selectedCount: 0, refreshedCount: 0, hasMore: false };

  const statements = due.flatMap((row) => {
    const id = Number(row.catalog_product_id);
    return [medianRefreshStatement(db, id, cutoff, at), expiryRefreshStatement(db, id, cutoff, at)];
  });
  const results = await db.batch(statements);

  return {
    selectedCount: due.length,
    refreshedCount: refreshedProductCount(results, due.length),
    hasMore: dueWithLookahead.length > limit,
  };
}
