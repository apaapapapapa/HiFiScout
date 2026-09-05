import { firstMeasured } from "./read-accounting.js";
import { withinD1Budget } from "./invocation-budget.js";
import type { QueryableDatabase } from "./types.js";

const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 25;
const BACKFILL_KEY = "recent-price-index-v1";
const BACKFILL_INTERVAL_MS = 60 * 60 * 1000;
const MAX_PRODUCT_SAMPLES = 500;
const MAX_PAGE_SAMPLES = 1000;

interface CatalogProductIdRow {
  catalog_product_id: number;
}

interface RecentPriceIndexBackfillRunRow {
  after_catalog_product_id: number;
  status: "running" | "completed";
  updated_at: string;
  next_batch_after: string | null;
}

interface BackfillCandidate extends CatalogProductIdRow {
  sample_count: number;
}

export interface RecentPriceIndexRefreshOptions {
  now?: Date;
  limit?: number;
}

export interface RecentPriceIndexBackfillOptions extends RecentPriceIndexRefreshOptions {
  /** Explicit operator/test override; scheduled production work always uses the hourly default. */
  minimumIntervalMs?: number;
}

export interface RecentPriceIndexRefreshResult {
  selectedCount: number;
  refreshedCount: number;
  hasMore: boolean;
}

export interface RecentPriceIndexBackfillResult extends RecentPriceIndexRefreshResult {
  status: "running" | "completed";
  afterCatalogProductId: number;
  deferredReason?: "cooldown" | "sample_budget" | "conflict";
  blockedCatalogProductId?: number;
}

function pageGuard(token: string | undefined): string {
  return token === undefined
    ? ""
    : `AND EXISTS (
    SELECT 1 FROM knowledge_catalog_price_index_recent_backfill_runs
    WHERE backfill_key = '${BACKFILL_KEY}' AND page_token = ?
  )`;
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
  token?: string,
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
      ${pageGuard(token)}
    `)
    .bind(catalogProductId, cutoff, at, catalogProductId, ...(token ? [token] : []));
}

function expiryRefreshStatement(
  db: QueryableDatabase,
  catalogProductId: number,
  cutoff: string,
  at: string,
  token?: string,
): D1PreparedStatement {
  return db
    .prepare(`
      INSERT INTO knowledge_catalog_price_index_recent_refreshes(
        catalog_product_id,
        next_expiry_at,
        updated_at
      ) SELECT
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
      WHERE 1 = 1 ${pageGuard(token)}
      ON CONFLICT(catalog_product_id) DO UPDATE SET
        next_expiry_at = excluded.next_expiry_at,
        updated_at = excluded.updated_at
    `)
    .bind(catalogProductId, catalogProductId, cutoff, at, ...(token ? [token] : []));
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
 * Data work runs after deployment, with a durable hourly pace and bounded sample admission.
 * The claim, projections and checkpoint share one atomic batch. A losing contender writes
 * neither projections nor progress. Sample counts are checked again inside that transaction,
 * so an intervening crawler cannot turn an admitted page into an unbounded median scan.
 */
export async function backfillRecentPriceIndexes(
  db: QueryableDatabase,
  options: RecentPriceIndexBackfillOptions = {},
): Promise<RecentPriceIndexBackfillResult> {
  const now = options.now || new Date();
  const at = now.toISOString();
  const cutoff = cutoffAt(now);
  const limit = refreshLimit(options.limit);
  const interval = options.minimumIntervalMs ?? BACKFILL_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 0 || interval > 24 * BACKFILL_INTERVAL_MS) {
    throw new Error("Backfill interval must be between zero and 24 hours");
  }
  const readRun = async () => {
    const run = await firstMeasured<RecentPriceIndexBackfillRunRow>(
      db
        .prepare(`
      SELECT after_catalog_product_id, status, updated_at, next_batch_after
      FROM knowledge_catalog_price_index_recent_backfill_runs WHERE backfill_key = ?
    `)
        .bind(BACKFILL_KEY),
    );
    if (!run) throw new Error(`Recent price-index backfill state is missing for ${BACKFILL_KEY}`);
    return run;
  };
  const idleResult = (run: RecentPriceIndexBackfillRunRow): RecentPriceIndexBackfillResult => ({
    status: run.status,
    selectedCount: 0,
    refreshedCount: 0,
    afterCatalogProductId: Number(run.after_catalog_product_id),
    hasMore: run.status === "running",
  });
  const run = await readRun();
  if (run.status === "completed") return idleResult(run);
  if (run.next_batch_after && run.next_batch_after > at) {
    return { ...idleResult(run), deferredReason: "cooldown" };
  }
  const previousCursor = Number(run.after_catalog_product_id);
  const candidateResult = await db
    .prepare(`
    SELECT catalog_product_id, (
      SELECT COUNT(*) FROM (
        SELECT 1 FROM knowledge_catalog_price_index_samples s
        WHERE s.catalog_product_id = p.catalog_product_id
          AND s.sample_kind = 'asking' AND s.observed_at >= ?
        LIMIT ?
      )
    ) AS sample_count
    FROM knowledge_catalog_price_indexes p
    WHERE catalog_product_id > ?
    ORDER BY catalog_product_id ASC LIMIT ?
  `)
    .bind(cutoff, MAX_PRODUCT_SAMPLES + 1, previousCursor, limit + 1)
    .all<BackfillCandidate>();
  const lookahead = candidateResult.results || [];
  const candidates: BackfillCandidate[] = [];
  let sampleCount = 0;
  for (const candidate of lookahead.slice(0, limit)) {
    if (
      candidate.sample_count > MAX_PRODUCT_SAMPLES ||
      sampleCount + candidate.sample_count > MAX_PAGE_SAMPLES
    )
      break;
    candidates.push(candidate);
    sampleCount += candidate.sample_count;
  }
  if (!candidates.length && lookahead.length) {
    return {
      ...idleResult(run),
      deferredReason: "sample_budget",
      blockedCatalogProductId: lookahead[0]?.catalog_product_id,
    };
  }
  const hasMore = lookahead.length > candidates.length;
  const nextCursor = Number(candidates.at(-1)?.catalog_product_id ?? previousCursor);
  const nextStatus = hasMore ? "running" : "completed";
  const token = crypto.randomUUID();
  // Bind at most 2*25 + 7 parameters, below D1's per-statement parameter limit.
  const sampleAdmission = candidates.length
    ? `AND NOT EXISTS (
    SELECT 1 FROM selected WHERE (
      SELECT COUNT(*) FROM (
        SELECT 1 FROM knowledge_catalog_price_index_samples s
        WHERE s.catalog_product_id = selected.id
          AND s.sample_kind = 'asking' AND s.observed_at >= ?
        LIMIT ${MAX_PRODUCT_SAMPLES + 1}
      )
    ) > selected.sample_count
  )`
    : "";
  const claim = db
    .prepare(`
    ${candidates.length ? `WITH selected(id,sample_count) AS (VALUES ${candidates.map(() => "(?,?)").join(",")})` : ""}
    UPDATE knowledge_catalog_price_index_recent_backfill_runs SET page_token = ?
    WHERE backfill_key = ? AND status = 'running' AND after_catalog_product_id = ?
      AND updated_at = ? AND page_token IS NULL
      AND (next_batch_after IS NULL OR next_batch_after <= ?)
      ${sampleAdmission}
  `)
    .bind(
      ...candidates.flatMap((row) => [row.catalog_product_id, row.sample_count]),
      token,
      BACKFILL_KEY,
      previousCursor,
      run.updated_at,
      at,
      ...(candidates.length ? [cutoff] : []),
    );
  const products = candidates.flatMap(({ catalog_product_id }) => [
    medianRefreshStatement(db, Number(catalog_product_id), cutoff, at, token),
    expiryRefreshStatement(db, Number(catalog_product_id), cutoff, at, token),
  ]);
  const checkpoint = db
    .prepare(`
    UPDATE knowledge_catalog_price_index_recent_backfill_runs
    SET after_catalog_product_id = ?, status = ?, updated_at = ?, completed_at = ?,
        page_token = NULL, next_batch_after = ?
    WHERE backfill_key = ? AND page_token = ?
  `)
    .bind(
      nextCursor,
      nextStatus,
      at,
      hasMore ? null : at,
      hasMore ? new Date(now.getTime() + interval).toISOString() : null,
      BACKFILL_KEY,
      token,
    );
  const results = await withinD1Budget(db, 1, () => db.batch([claim, ...products, checkpoint]));
  if (!Number(results.at(-1)?.meta?.changes)) {
    return { ...idleResult(await readRun()), deferredReason: "conflict" };
  }
  return {
    status: nextStatus,
    selectedCount: candidates.length,
    refreshedCount: refreshedProductCount(results.slice(1), candidates.length),
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
