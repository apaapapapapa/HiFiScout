import {
  finishCrawlRunInterrupted,
  listStalledCrawlRuns,
  type StalledCrawlRunRow,
} from "../db/crawl-run-repository.js";
import { listShopStates, markShopFailure } from "../db/shop-state-repository.js";
import { readCrawlLifecycle, type CrawlDispatchStateRow } from "./crawl-lifecycle.js";
import type { QueryableDatabase } from "../db/types.js";

/**
 * Minimum age before a run with no owning dispatch reservation can be classified as orphaned.
 *
 * A valid Phase-7 dispatch is never age-expired here: the scheduler re-delivers the same token to
 * its Durable Object, which can resume from D1. This window only protects recently released runs
 * from being classified while their terminal writes are still settling.
 */
const STALLED_RUN_ORPHAN_MINUTES = 25;
/** One bounded page per sweep; a backlog drains over successive five-minute ticks. */
const STALLED_RUN_BATCH_SIZE = 20;

const INTERRUPTED_MESSAGE =
  "crawl run abandoned: no terminal outcome recorded after its dispatch reservation was released";

/** The abandonment message, extended with the last durable crawl heartbeat. */
export function interruptedRunMessage(run: StalledCrawlRunRow): string {
  const parts = [`stage=${run.current_stage || "none"}`, `pagesDone=${run.pages_done || 0}`];
  if (run.last_progress_at) parts.push(`lastProgressAt=${run.last_progress_at}`);
  return `${INTERRUPTED_MESSAGE} (${parts.join(", ")})`;
}

export interface StalledCrawlRunRecovery {
  crawlRunId: number;
  shopKey: string;
  startedAt: string;
  /** Whether this recovery also recorded the interruption against shop health. */
  recordedFailure: boolean;
}

export interface RecoverStalledCrawlRunsOptions {
  now?: Date;
  graceMinutes?: number;
  limit?: number;
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether an orphaned run is still the shop's open question.
 *
 * Any valid dispatch reservation means the Durable Object still owns a recoverable generation, so
 * neither the run nor shop health may be rewritten by this D1 sweep. A later terminal outcome is
 * authoritative as well.
 */
export function shouldRecordStalledRunFailure(
  state: CrawlDispatchStateRow | undefined,
  run: StalledCrawlRunRow,
): boolean {
  if (!state) return false;
  if (readCrawlLifecycle(state).phase === "dispatched") return false;
  const startedAtMs = timestampMs(run.started_at);
  if (startedAtMs == null) return false;
  const lastSuccessMs = timestampMs(state.last_success_at);
  const lastErrorMs = timestampMs(state.last_error_at);
  return (
    (lastSuccessMs == null || lastSuccessMs < startedAtMs) &&
    (lastErrorMs == null || lastErrorMs < startedAtMs)
  );
}

/**
 * Closes only crawl runs whose Durable Object generation is no longer reserved.
 *
 * A reserved Phase-7 generation is recoverable regardless of age: the scheduler watchdog sends the
 * same immutable token back to the same DO. Therefore this sweep must never race a live/recoverable
 * dispatch merely because wall-clock time passed.
 */
export async function recoverStalledCrawlRuns(
  db: QueryableDatabase,
  {
    now = new Date(),
    graceMinutes = 0,
    limit = STALLED_RUN_BATCH_SIZE,
  }: RecoverStalledCrawlRunsOptions = {},
): Promise<StalledCrawlRunRecovery[]> {
  const abandonedAfterMinutes = STALLED_RUN_ORPHAN_MINUTES + Math.max(0, graceMinutes);
  const startedBefore = new Date(now.getTime() - abandonedAfterMinutes * 60_000).toISOString();
  const stalled = await listStalledCrawlRuns(db, { startedBefore, limit });
  if (!stalled.length) return [];

  const states = new Map(
    ((await listShopStates(db)) as CrawlDispatchStateRow[]).map((row) => [row.shop_key, row]),
  );
  const recoveredAt = now.toISOString();
  const recovered: StalledCrawlRunRecovery[] = [];

  for (const run of stalled) {
    const state = states.get(run.shop_key);
    if (state && readCrawlLifecycle(state).phase === "dispatched") continue;

    const message = interruptedRunMessage(run);
    const closed = await finishCrawlRunInterrupted(db, run.id, {
      finishedAt: recoveredAt,
      message,
    });
    if (!closed) continue;

    const recordedFailure = shouldRecordStalledRunFailure(state, run);
    if (recordedFailure) {
      await markShopFailure(
        db,
        run.shop_key,
        recoveredAt,
        message,
        Number(state?.consecutive_failures || 0),
      );
    }
    recovered.push({
      crawlRunId: run.id,
      shopKey: run.shop_key,
      startedAt: run.started_at,
      recordedFailure,
    });
    console.warn(
      JSON.stringify({
        event: "crawl_run_recovered",
        shopKey: run.shop_key,
        crawlRunId: run.id,
        startedAt: run.started_at,
        recoveredAt,
        abandonedAfterMinutes,
        recordedFailure,
        stoppedInStage: run.current_stage || null,
        pagesDone: run.pages_done || 0,
        lastProgressAt: run.last_progress_at || null,
      }),
    );
  }

  return recovered;
}
