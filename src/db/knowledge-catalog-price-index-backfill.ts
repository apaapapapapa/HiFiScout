import type { QueryableDatabase } from "./types.js";

interface PriceIndexBackfillCandidateRow {
  id: number;
  listing_product_id: number;
  catalog_product_id: number;
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
        pir.catalog_product_id,
        p.shop_key,
        p.source_id,
        ph.price_yen,
        ph.observed_at
      FROM price_history ph
      JOIN products p ON p.id = ph.product_id
      JOIN product_identity_resolutions pir ON pir.listing_product_id = p.id
      WHERE ph.id > ?
        AND ph.price_yen > 0
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
      ) VALUES (?, ?, ?, ?, ?, ?, 'asking', 'asking', ?, ?)
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
      candidate.catalog_product_id,
      candidate.listing_product_id,
      candidate.id,
      candidate.shop_key,
      candidate.source_id,
      candidate.price_yen,
      candidate.observed_at,
    );
}

/**
 * Copies one bounded keyset page from retained `price_history` into the permanent sample ledger.
 *
 * Sample upserts and cursor advancement are committed in the same D1 `batch()` transaction. A
 * terminated invocation therefore either advances neither side or both sides. The job never clears
 * the ledger: crawler triggers may keep writing newer evidence while a historical backfill is in
 * progress, and replaying an overlapping page is idempotent by the stable price-history event key.
 *
 * Rows that are unresolved at the time this page passes are intentionally skipped. If their
 * identity later becomes matched, the price-index identity trigger copies their retained history,
 * so advancing this cursor cannot make a later resolution permanently miss evidence.
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
  const stateUpdate = db
    .prepare(`
      UPDATE knowledge_catalog_price_index_backfill_runs
      SET after_price_history_id = ?,
          status = ?,
          updated_at = ?,
          completed_at = ?
      WHERE backfill_key = ?
        AND status = 'running'
        AND after_price_history_id <= ?
    `)
    .bind(
      nextAfterPriceHistoryId,
      nextStatus,
      at,
      hasMore ? null : at,
      key,
      Number(run.after_price_history_id),
    );

  const results = await db.batch([
    ...candidates.map((candidate) => sampleUpsertStatement(db, candidate)),
    stateUpdate,
  ]);
  const writtenCount = results
    .slice(0, candidates.length)
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
