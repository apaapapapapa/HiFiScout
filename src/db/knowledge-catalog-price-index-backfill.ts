import {
  DEFERRED_REFRESH_LEADING_STATEMENTS,
  deferredPriceIndexRefresh,
} from "./knowledge-catalog-price-index-deferred-refresh.js";
import type { QueryableDatabase } from "./types.js";

interface PriceIndexBackfillCandidateRow {
  id: number;
  listing_product_id: number;
  resolved_catalog_product_id: number;
  existing_catalog_product_id: number | null;
  existing_sample: number;
  shop_key: string;
  source_id: string;
  price_yen: number;
  observed_at: string;
}

interface PriceIndexBackfillRunRow {
  backfill_key: string;
  after_price_history_id: number;
  status: "running" | "completed";
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface KnowledgeCatalogPriceIndexBackfillOptions {
  /** A new key starts an independent rebuild without deleting already-retained evidence. */
  backfillKey?: string;
  /** Number of eligible price-history rows copied by this invocation. */
  batchSize?: number;
  now?: Date;
}

export interface KnowledgeCatalogPriceIndexBackfillResult {
  event: "knowledge_catalog_price_index_backfill";
  backfillKey: string;
  status: "running" | "completed";
  selectedCount: number;
  writtenCount: number;
  afterPriceHistoryId: number;
  hasMore: boolean;
}

const DEFAULT_BACKFILL_KEY = "price-index-history-v1";
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;
const BACKFILL_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

function backfillKey(value: string | undefined): string {
  const normalized = (value || DEFAULT_BACKFILL_KEY).trim();
  if (!normalized || normalized.length > 100 || !BACKFILL_KEY_PATTERN.test(normalized)) {
    throw new Error("backfillKey must be 1-100 characters from [A-Za-z0-9._:-]");
  }
  return normalized;
}

function batchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BATCH_SIZE) {
    throw new Error(`batchSize must be an integer in [1, ${MAX_BATCH_SIZE}]`);
  }
  return value;
}

async function loadOrCreateRun(
  db: QueryableDatabase,
  key: string,
  at: string,
): Promise<PriceIndexBackfillRunRow> {
  await db
    .prepare(`
      INSERT OR IGNORE INTO knowledge_catalog_price_index_backfill_runs(
        backfill_key, after_price_history_id, status, started_at, updated_at, completed_at
      ) VALUES (?, 0, 'running', ?, ?, NULL)
    `)
    .bind(key, at, at)
    .run();

  const row = await db
    .prepare(`
      SELECT backfill_key, after_price_history_id, status, started_at, updated_at, completed_at
      FROM knowledge_catalog_price_index_backfill_runs
      WHERE backfill_key = ?
    `)
    .bind(key)
    .first<PriceIndexBackfillRunRow>();
  if (!row) throw new Error(`Price-index backfill state disappeared for ${key}`);
  return row;
}

async function selectCandidates(
  db: QueryableDatabase,
  afterPriceHistoryId: number,
  limit: number,
): Promise<PriceIndexBackfillCandidateRow[]> {
  const result = await db
    .prepare(`
      SELECT
        ph.id,
        p.id AS listing_product_id,
        pir.catalog_product_id AS resolved_catalog_product_id,
        existing.catalog_product_id AS existing_catalog_product_id,
        CASE WHEN existing.event_key IS NULL THEN 0 ELSE 1 END AS existing_sample,
        p.shop_key,
        p.source_id,
        ph.price_yen,
        ph.observed_at
      FROM price_history ph
      JOIN products p ON p.id = ph.product_id
      JOIN product_identity_resolutions pir ON pir.listing_product_id = p.id
      LEFT JOIN knowledge_catalog_price_index_samples existing
        ON existing.event_key = 'asking:price-history:' || ph.id
      WHERE ph.id > ?
        AND ph.price_yen >= 0
        AND pir.status = 'matched'
        AND pir.catalog_product_id IS NOT NULL
      ORDER BY ph.id ASC
      LIMIT ?
    `)
    .bind(afterPriceHistoryId, limit)
    .all<PriceIndexBackfillCandidateRow>();
  return result.results || [];
}

function sampleUpsertStatement(
  db: QueryableDatabase,
  candidate: PriceIndexBackfillCandidateRow,
): D1PreparedStatement {
  // Identity is deliberately read again by this statement inside the same D1 batch transaction
  // that advances the cursor. A resolver write cannot leave stale catalog attribution between the
  // initial candidate scan and commit: the transaction uses whichever identity is current then.
  return db
    .prepare(`
      INSERT INTO knowledge_catalog_price_index_samples(
        event_key,
        catalog_product_id,
        listing_product_id,
        source_price_history_id,
        shop_key,
        source_id,
        sample_kind,
        signal_kind,
        price_yen,
        observed_at
      )
      SELECT ?, pir.catalog_product_id, ?, ?, ?, ?, 'asking', 'asking', ?, ?
      FROM product_identity_resolutions pir
      WHERE pir.listing_product_id = ?
        AND pir.status = 'matched'
        AND pir.catalog_product_id IS NOT NULL
      ON CONFLICT(event_key) DO UPDATE SET
        catalog_product_id = excluded.catalog_product_id,
        listing_product_id = excluded.listing_product_id,
        source_price_history_id = excluded.source_price_history_id,
        shop_key = excluded.shop_key,
        source_id = excluded.source_id,
        price_yen = excluded.price_yen,
        observed_at = excluded.observed_at
      WHERE knowledge_catalog_price_index_samples.catalog_product_id IS NOT excluded.catalog_product_id
         OR knowledge_catalog_price_index_samples.listing_product_id IS NOT excluded.listing_product_id
         OR knowledge_catalog_price_index_samples.source_price_history_id IS NOT excluded.source_price_history_id
         OR knowledge_catalog_price_index_samples.shop_key IS NOT excluded.shop_key
         OR knowledge_catalog_price_index_samples.source_id IS NOT excluded.source_id
         OR knowledge_catalog_price_index_samples.price_yen IS NOT excluded.price_yen
         OR knowledge_catalog_price_index_samples.observed_at IS NOT excluded.observed_at
    `)
    .bind(
      `asking:price-history:${candidate.id}`,
      candidate.listing_product_id,
      candidate.id,
      candidate.shop_key,
      candidate.source_id,
      candidate.price_yen,
      candidate.observed_at,
      candidate.listing_product_id,
    );
}

/**
 * Whether this page is worth doing the transaction-time coalescing check at all.
 *
 * The decisive check still runs as the first statement of the write transaction. This first pass
 * exists only to keep obvious no-op/wide pages on the unchanged path without adding the drain
 * statements. `existing_sample = 0` and a catalog-attribution mismatch are lower bounds on actual
 * sample mutations: either condition guarantees the upsert will change the row if the same
 * resolution is still current when the transaction starts.
 *
 * Distinct listings are kept as the conservative product bound used by the original gate. The
 * transaction-time check below uses the actual current catalog IDs and all existing old IDs before
 * it opens the deferral, so catalog moves and concurrent replay cannot turn this heuristic into a
 * `rows_written` regression.
 */
function coalescesRecomputes(candidates: readonly PriceIndexBackfillCandidateRow[]): boolean {
  const listings = new Set(candidates.map((candidate) => candidate.listing_product_id)).size;
  const guaranteedMutations = candidates.filter(
    (candidate) =>
      Number(candidate.existing_sample) === 0 ||
      candidate.existing_catalog_product_id !== candidate.resolved_catalog_product_id,
  ).length;
  return guaranteedMutations >= 3 * listings + 5;
}

/**
 * Opens the deferral only when it is still a strict D1 `rows_written` saving at transaction time.
 *
 * The pre-scan can race with another backfill invocation or an independent fresh key. Re-evaluating
 * here, as the first statement of the same D1 `batch()` that performs the sample upserts, closes
 * that window:
 *
 * - `guaranteed_mutations` is a lower bound on rows the upcoming upserts must change: an event is
 *   absent, or its stored catalog attribution differs from the resolution current in this
 *   transaction.
 * - `possible_dirty_products` is an upper bound on products those statements can dirty, even when
 *   some existing sample differs only in another field: every dirty product is either an existing
 *   old catalog ID or a current resolved catalog ID for one of the exact selected events.
 *
 * Therefore opening only when
 *
 *     guaranteed_mutations >= 3 * possible_dirty_products + 5
 *
 * implies the actual mutation count also clears the write break-even point. The cursor predicate is
 * a same-key concurrency fence: after another invocation advances this run, a stale batch cannot
 * open a deferral merely because its JavaScript gate was computed before that commit.
 */
function backfillDeferralOpenStatement(
  db: QueryableDatabase,
  token: string,
  key: string,
  afterPriceHistoryId: number,
  candidates: readonly PriceIndexBackfillCandidateRow[],
): D1PreparedStatement {
  const candidateIds = candidates.map((candidate) => Number(candidate.id));
  if (
    candidateIds.length === 0 ||
    candidateIds.some((candidateId) => !Number.isSafeInteger(candidateId) || candidateId <= 0)
  ) {
    throw new Error("Price-index backfill candidates must have positive safe-integer ids");
  }
  const idList = candidateIds.join(", ");

  return db
    .prepare(`
      INSERT INTO knowledge_catalog_price_index_refresh_deferrals(token, opened_at)
      WITH candidate_state AS (
        SELECT
          ph.id,
          pir.catalog_product_id AS resolved_catalog_product_id,
          existing.catalog_product_id AS existing_catalog_product_id,
          existing.event_key AS existing_event_key
        FROM price_history ph
        JOIN products p ON p.id = ph.product_id
        JOIN product_identity_resolutions pir ON pir.listing_product_id = p.id
        LEFT JOIN knowledge_catalog_price_index_samples existing
          ON existing.event_key = 'asking:price-history:' || ph.id
        WHERE ph.id IN (${idList})
          AND ph.price_yen >= 0
          AND pir.status = 'matched'
          AND pir.catalog_product_id IS NOT NULL
      ),
      possible_dirty_products AS (
        SELECT resolved_catalog_product_id AS catalog_product_id
        FROM candidate_state
        UNION
        SELECT existing_catalog_product_id
        FROM candidate_state
        WHERE existing_catalog_product_id IS NOT NULL
      ),
      cost AS (
        SELECT
          SUM(
            CASE
              WHEN existing_event_key IS NULL
                OR existing_catalog_product_id IS NOT resolved_catalog_product_id
                THEN 1
              ELSE 0
            END
          ) AS guaranteed_mutations,
          (SELECT COUNT(*) FROM possible_dirty_products) AS possible_dirty_products
        FROM candidate_state
      )
      SELECT ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM cost
      WHERE guaranteed_mutations >= 3 * possible_dirty_products + 5
        AND EXISTS (
          SELECT 1
          FROM knowledge_catalog_price_index_backfill_runs
          WHERE backfill_key = ?
            AND status = 'running'
            AND after_price_history_id = ?
        )
      ON CONFLICT(token) DO NOTHING
    `)
    .bind(token, key, afterPriceHistoryId);
}

/**
 * Copies one bounded keyset page from retained `price_history` into the permanent sample ledger.
 *
 * Sample upserts, the aggregate recompute they imply, and cursor advancement are committed in the
 * same D1 `batch()` transaction. A terminated invocation therefore either advances neither side or
 * both sides. A page that repeats catalog products runs under a price-index refresh deferral only
 * when the transaction itself proves the coordination is cheaper than the recomputes it replaces.
 * The recompute is still inside the transaction, so the aggregate is never observably behind its
 * samples. The job never clears the ledger: crawler triggers may keep writing newer evidence while
 * a historical backfill is in progress, and replaying an overlapping page is idempotent by the
 * stable price-history event key.
 *
 * Rows that are unresolved at the candidate scan are intentionally skipped. If identity changes
 * after selection, the transactional upsert rechecks it before attribution. If an unresolved row
 * later becomes matched, the price-index identity trigger copies its retained history, so advancing
 * this cursor cannot make a later resolution permanently miss evidence.
 */
export async function backfillKnowledgeCatalogPriceIndex(
  db: QueryableDatabase,
  options: KnowledgeCatalogPriceIndexBackfillOptions = {},
): Promise<KnowledgeCatalogPriceIndexBackfillResult> {
  const key = backfillKey(options.backfillKey);
  const limit = batchSize(options.batchSize);
  const at = (options.now || new Date()).toISOString();
  const run = await loadOrCreateRun(db, key, at);

  if (run.status === "completed") {
    return {
      event: "knowledge_catalog_price_index_backfill",
      backfillKey: key,
      status: "completed",
      selectedCount: 0,
      writtenCount: 0,
      afterPriceHistoryId: Number(run.after_price_history_id),
      hasMore: false,
    };
  }

  const candidatesWithLookahead = await selectCandidates(
    db,
    Number(run.after_price_history_id),
    limit + 1,
  );
  const candidates = candidatesWithLookahead.slice(0, limit);
  const hasMore = candidatesWithLookahead.length > limit;

  if (!candidates.length) {
    await db
      .prepare(`
        UPDATE knowledge_catalog_price_index_backfill_runs
        SET status = 'completed', updated_at = ?, completed_at = ?
        WHERE backfill_key = ? AND status = 'running'
      `)
      .bind(at, at, key)
      .run();
    return {
      event: "knowledge_catalog_price_index_backfill",
      backfillKey: key,
      status: "completed",
      selectedCount: 0,
      writtenCount: 0,
      afterPriceHistoryId: Number(run.after_price_history_id),
      hasMore: false,
    };
  }

  const nextAfterPriceHistoryId = Number(candidates[candidates.length - 1]?.id || 0);
  const nextStatus = hasMore ? "running" : "completed";
  const currentAfterPriceHistoryId = Number(run.after_price_history_id);
  const stateUpdate = db
    .prepare(`
      UPDATE knowledge_catalog_price_index_backfill_runs
      SET after_price_history_id = ?,
          status = ?,
          updated_at = ?,
          completed_at = ?
      WHERE backfill_key = ?
        AND status = 'running'
        AND after_price_history_id = ?
    `)
    .bind(
      nextAfterPriceHistoryId,
      nextStatus,
      at,
      hasMore ? null : at,
      key,
      currentAfterPriceHistoryId,
    );

  const pageStatements = [
    ...candidates.map((candidate) => sampleUpsertStatement(db, candidate)),
    stateUpdate,
  ];

  // The JavaScript gate avoids the extra drain statements on obvious no-op/wide pages. When it
  // passes, replace the helper's unconditional opener with a transaction-time cost gate. The rest
  // of the helper remains unchanged, preserving one transaction and one drain per changed product.
  const coalesce = coalescesRecomputes(candidates);
  const token = `backfill:${key}`;
  const deferredStatements = coalesce
    ? deferredPriceIndexRefresh(db, token, pageStatements)
    : pageStatements;
  if (coalesce) {
    deferredStatements[0] = backfillDeferralOpenStatement(
      db,
      token,
      key,
      currentAfterPriceHistoryId,
      candidates,
    );
  }

  const results = await db.batch(deferredStatements);
  const firstUpsert = coalesce ? DEFERRED_REFRESH_LEADING_STATEMENTS : 0;
  const writtenCount = results
    .slice(firstUpsert, firstUpsert + candidates.length)
    .reduce((sum, result) => sum + Number(result?.meta?.changes || 0), 0);

  return {
    event: "knowledge_catalog_price_index_backfill",
    backfillKey: key,
    status: nextStatus,
    selectedCount: candidates.length,
    writtenCount,
    afterPriceHistoryId: nextAfterPriceHistoryId,
    hasMore,
  };
}
