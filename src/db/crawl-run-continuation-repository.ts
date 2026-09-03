import type { QueryableDatabase, ReadableDatabase } from "./types.js";

/**
 * The derived stages a continuation can finish, in dependency order.
 *
 * Only stages that can be reconstructed from persisted listings appear here. Feature facts and
 * product metadata are written from the parsed seller objects, which are not stored, so they stay
 * on the one-shot path until a measurement shows they need chunking too.
 *
 * `membership_cleanup` is last because it is the one stage scoped to the shop rather than to this
 * run's listings: retiring the memberships of listings that disappeared has to see the offers the
 * earlier stages just rewrote.
 */
export const RESUMABLE_CRAWL_STAGES = [
  "search_projection",
  "identity_resolution",
  "search_entity",
  "membership_cleanup",
] as const;

export type ResumableCrawlStage = (typeof RESUMABLE_CRAWL_STAGES)[number];

/**
 * Whether a stage walks this run's own work set or the shop's leftover memberships.
 *
 * The single definition: the chunk a stage claims, the input count it reports, and which runs still
 * hold work worth inheriting are all the same question.
 */
export const CRAWL_STAGE_SCOPE: Readonly<Record<ResumableCrawlStage, "run" | "shop">> =
  Object.freeze({
    search_projection: "run",
    identity_resolution: "run",
    search_entity: "run",
    membership_cleanup: "shop",
  });

const RUN_SCOPED_CRAWL_STAGES = RESUMABLE_CRAWL_STAGES.filter(
  (stage) => CRAWL_STAGE_SCOPE[stage] === "run",
);

/** D1 caps bound variables per statement, so every multi-row write is chunked below that limit. */
const WRITE_CHUNK_SIZE = 50;

export interface CrawlRunStageCheckpoint {
  stage: ResumableCrawlStage;
  ordinal: number;
  afterSourceId: string;
  processedCount: number;
  attempts: number;
}

export interface ResumableCrawlRun {
  crawlRunId: number;
  shopKey: string;
  generation: string;
}

function stageOrdinal(stage: ResumableCrawlStage): number {
  return RESUMABLE_CRAWL_STAGES.indexOf(stage);
}

function isResumableStage(value: string): value is ResumableCrawlStage {
  return (RESUMABLE_CRAWL_STAGES as readonly string[]).includes(value);
}

/**
 * Records what a run owes before it starts owing it.
 *
 * Written immediately after the listing write, while the invocation still holds its budget: from
 * this point the seller never has to be visited again, because every remaining stage reads the
 * listings this set names. Re-running the same crawl overwrites its own rows rather than
 * accumulating, so a redelivered message converges instead of duplicating work.
 */
export async function recordCrawlRunWorkSet(
  db: QueryableDatabase,
  {
    crawlRunId,
    generation,
    sourceIds,
    recordedAt,
  }: {
    crawlRunId: number;
    generation: string;
    sourceIds: readonly string[];
    recordedAt: string;
  },
): Promise<void> {
  // Written even for an empty delta. A crawl where nothing changed still owes the shop-scoped
  // cleanup, and the generation is what lets a later crawl retire this one's outstanding work.
  await db
    .prepare("UPDATE crawl_runs SET generation = ? WHERE id = ?")
    .bind(generation, crawlRunId)
    .run();

  const unique = [...new Set(sourceIds)].filter(Boolean);
  for (let index = 0; index < unique.length; index += WRITE_CHUNK_SIZE) {
    await db.batch(
      unique
        .slice(index, index + WRITE_CHUNK_SIZE)
        .map((sourceId) =>
          db
            .prepare(
              "INSERT OR IGNORE INTO crawl_run_work_items (crawl_run_id, source_id) VALUES (?, ?)",
            )
            .bind(crawlRunId, sourceId),
        ),
    );
  }

  await inheritOutstandingWorkItems(db, crawlRunId);
  await ensureCrawlRunStages(db, crawlRunId, recordedAt);
}

/**
 * Adds any stage row this run is missing, leaving the ones it has alone.
 *
 * The stage list grows as new derived work is added, but a run's rows are written once, when it
 * records its work set. A run interrupted across a deployment therefore knows only the stages that
 * existed when it started: without this it would finish those, find nothing pending, free its work
 * set and count as complete, silently skipping a stage introduced while it was waiting.
 */
export async function ensureCrawlRunStages(
  db: QueryableDatabase,
  crawlRunId: number,
  at: string,
): Promise<void> {
  await db.batch(
    RESUMABLE_CRAWL_STAGES.map((stage) =>
      db
        .prepare(`
          INSERT INTO crawl_run_stages (crawl_run_id, stage, ordinal, status, updated_at)
          VALUES (?, ?, ?, 'pending', ?)
          ON CONFLICT(crawl_run_id, stage) DO NOTHING
        `)
        .bind(crawlRunId, stage, stageOrdinal(stage), at),
    ),
  );
}

/**
 * Adopts the unfinished work of this shop's earlier runs.
 *
 * A crawl records only the listings whose inputs moved, so a listing changed by an interrupted run
 * is absent from the next run's delta — it already matches what that run wrote. Without this, the
 * moment the newer run supersedes the older one, that listing's projection would be dropped with it
 * and stay stale until an unrelated crawl happened to touch it again. Inheriting first means
 * supersession only ever discards work that has already been taken over.
 *
 * Only runs with a run-scoped stage still pending are worth adopting. A run held open solely by the
 * shop-scoped cleanup has already projected every listing it named, but still holds its work set,
 * so inheriting from it would copy a fully consumed delta into the next crawl and make it redo the
 * bulk work from `search_projection` — repeatedly, for as long as that cleanup keeps failing.
 */
async function inheritOutstandingWorkItems(
  db: QueryableDatabase,
  crawlRunId: number,
): Promise<void> {
  const stagePlaceholders = RUN_SCOPED_CRAWL_STAGES.map(() => "?").join(",");
  await db
    .prepare(`
      INSERT OR IGNORE INTO crawl_run_work_items (crawl_run_id, source_id)
      SELECT ?, w.source_id
      FROM crawl_run_work_items w
      WHERE w.crawl_run_id <> ?
        AND EXISTS (
          SELECT 1 FROM crawl_runs older
          JOIN crawl_runs mine ON mine.id = ?
          WHERE older.id = w.crawl_run_id AND older.shop_key = mine.shop_key
        )
        AND EXISTS (
          SELECT 1 FROM crawl_run_stages s
          WHERE s.crawl_run_id = w.crawl_run_id
            AND s.status = 'pending'
            AND s.stage IN (${stagePlaceholders})
        )
    `)
    .bind(crawlRunId, crawlRunId, crawlRunId, ...RUN_SCOPED_CRAWL_STAGES)
    .run();
}

/** The next stage a run still owes, or null when its derived work is complete. */
export async function nextPendingCrawlRunStage(
  db: ReadableDatabase,
  crawlRunId: number,
): Promise<CrawlRunStageCheckpoint | null> {
  const row = await db
    .prepare(`
      SELECT stage, ordinal, after_source_id, processed_count, attempts
      FROM crawl_run_stages
      WHERE crawl_run_id = ? AND status = 'pending'
      ORDER BY ordinal
      LIMIT 1
    `)
    .bind(crawlRunId)
    .first<{
      stage: string;
      ordinal: number;
      after_source_id: string;
      processed_count: number;
      attempts: number;
    }>();
  if (!row || !isResumableStage(row.stage)) return null;
  return {
    stage: row.stage,
    ordinal: Number(row.ordinal),
    afterSourceId: row.after_source_id || "",
    processedCount: Number(row.processed_count || 0),
    attempts: Number(row.attempts || 0),
  };
}

/** One bounded slice of a run's changed listings, ordered so the cursor can resume from it. */
export async function claimCrawlRunWorkChunk(
  db: ReadableDatabase,
  crawlRunId: number,
  afterSourceId: string,
  limit: number,
): Promise<string[]> {
  const result = await db
    .prepare(`
      SELECT source_id
      FROM crawl_run_work_items
      WHERE crawl_run_id = ? AND source_id > ?
      ORDER BY source_id
      LIMIT ?
    `)
    .bind(crawlRunId, afterSourceId, limit)
    .all<{ source_id: string }>();
  return (result.results || []).map((row) => row.source_id);
}

/**
 * One bounded slice of the shop's listings that are gone but still hold a search-entity offer.
 *
 * Cleanup is shop-scoped rather than run-scoped: a listing that disappeared is by definition not in
 * anything this run observed, so without this its offer would keep inflating its product's offer
 * count forever. Processing a chunk removes it from this set, and the cursor still advances by
 * source id so the stage terminates even if a row somehow survives its own cleanup.
 */
export async function claimShopMembershipCleanupChunk(
  db: ReadableDatabase,
  shopKey: string,
  afterSourceId: string,
  limit: number,
): Promise<string[]> {
  const result = await db
    .prepare(`
      SELECT DISTINCT p.source_id AS source_id
      FROM product_search_entity_offers m
      JOIN products p ON p.id = m.listing_product_id
      WHERE p.shop_key = ? AND p.is_active = 0 AND p.source_id > ?
      ORDER BY p.source_id
      LIMIT ?
    `)
    .bind(shopKey, afterSourceId, limit)
    .all<{ source_id: string }>();
  return (result.results || []).map((row) => row.source_id);
}

/**
 * Moves a stage's cursor past a chunk that has already been committed.
 *
 * The cursor advances only after the chunk's own writes are durable, so an invocation killed
 * between the two replays exactly that chunk. Every stage it drives is idempotent, which is what
 * makes replaying safe rather than merely tolerable.
 */
export async function advanceCrawlRunStage(
  db: QueryableDatabase,
  crawlRunId: number,
  stage: ResumableCrawlStage,
  {
    afterSourceId,
    processedCount,
    at,
  }: { afterSourceId: string; processedCount: number; at: string },
): Promise<void> {
  await db
    .prepare(`
      UPDATE crawl_run_stages
      SET after_source_id = ?, processed_count = processed_count + ?, updated_at = ?
      WHERE crawl_run_id = ? AND stage = ? AND status = 'pending'
    `)
    .bind(afterSourceId, processedCount, at, crawlRunId, stage)
    .run();
}

/** Marks a stage finished. Idempotent: a redelivery that re-completes it changes nothing. */
export async function completeCrawlRunStage(
  db: QueryableDatabase,
  crawlRunId: number,
  stage: ResumableCrawlStage,
  at: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE crawl_run_stages
      SET status = 'done', last_error = '', updated_at = ?
      WHERE crawl_run_id = ? AND stage = ?
    `)
    .bind(at, crawlRunId, stage)
    .run();
}

/** Records an attempt that failed, leaving the stage pending so a later sweep retries it. */
export async function recordCrawlRunStageFailure(
  db: QueryableDatabase,
  crawlRunId: number,
  stage: ResumableCrawlStage,
  { message, at }: { message: string; at: string },
): Promise<void> {
  await db
    .prepare(`
      UPDATE crawl_run_stages
      SET attempts = attempts + 1, last_error = ?, updated_at = ?
      WHERE crawl_run_id = ? AND stage = ? AND status = 'pending'
    `)
    .bind(message.slice(0, 500), at, crawlRunId, stage)
    .run();
}

/**
 * Retires a run's outstanding work because a newer run for the same shop has taken over.
 *
 * Finishing an older generation's projections after a newer crawl has written its listings would
 * group current listings against a stale observation, so the older work is dropped rather than
 * completed.
 */
export async function supersedeCrawlRunStages(
  db: QueryableDatabase,
  crawlRunId: number,
  at: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE crawl_run_stages
      SET status = 'superseded', updated_at = ?
      WHERE crawl_run_id = ? AND status = 'pending'
    `)
    .bind(at, crawlRunId)
    .run();
}

/** The observed listings are only needed while a stage still reads them. */
export async function clearCrawlRunWorkItems(
  db: QueryableDatabase,
  crawlRunId: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM crawl_run_work_items WHERE crawl_run_id = ?")
    .bind(crawlRunId)
    .run();
}

/**
 * Runs whose derived work is unfinished, in crawl creation order.
 *
 * Recovery starts from the partial index that contains only pending stage rows. Picking the
 * smallest pending ordinal gives one representative row per run, so LIMIT can stop in current-work
 * order without ever walking terminal crawl history. Crawl ids are monotonically assigned when a
 * run is created, making this the same fairness direction as the former started_at ordering without
 * paying for a history-sized sort.
 *
 * A run is only resumable once it carries a generation, because that is written with the work set:
 * a run that died before the listing write has nothing to resume and must be recrawled instead.
 */
export async function listResumableCrawlRuns(
  db: ReadableDatabase,
  limit: number,
): Promise<ResumableCrawlRun[]> {
  const result = await db
    .prepare(`
      SELECT r.id, r.shop_key, r.generation
      FROM crawl_run_stages s
      JOIN crawl_runs r ON r.id = s.crawl_run_id
      WHERE s.status = 'pending'
        AND r.generation <> ''
        AND s.ordinal = (
          SELECT MIN(p.ordinal)
          FROM crawl_run_stages p
          WHERE p.crawl_run_id = s.crawl_run_id
            AND p.status = 'pending'
        )
      ORDER BY s.crawl_run_id
      LIMIT ?
    `)
    .bind(limit)
    .all<{ id: number; shop_key: string; generation: string }>();
  return (result.results || []).map((row) => ({
    crawlRunId: Number(row.id),
    shopKey: row.shop_key,
    generation: row.generation,
  }));
}

/** Whether the shop has started a run after this one, whose derived work supersedes it. */
export async function hasNewerCrawlRun(
  db: ReadableDatabase,
  { crawlRunId, shopKey }: { crawlRunId: number; shopKey: string },
): Promise<boolean> {
  const row = await db
    .prepare(`
      SELECT 1 AS newer
      FROM crawl_runs
      WHERE shop_key = ? AND id > ?
      LIMIT 1
    `)
    .bind(shopKey, crawlRunId)
    .first<{ newer: number }>();
  return Boolean(row?.newer);
}