import {
  finishCrawlRunInterrupted,
  listStalledCrawlRuns,
  type StalledCrawlRunRow,
} from "../db/crawl-run-repository.js";
import { listShopStates, markShopFailure } from "../db/shop-state-repository.js";
import { readCrawlLifecycle, type CrawlLifecycleRow } from "./crawl-lifecycle.js";
import { CRAWL_EXECUTION_LEASE_MINUTES } from "./dispatch.js";
import type { QueryableDatabase } from "../db/types.js";

/**
 * Extra wait beyond the execution lease before a run counts as abandoned.
 *
 * The lease already outlives the platform's own invocation limit, so the grace only covers clock
 * skew between the Worker that opened the run and the sweep that closes it.
 */
const STALLED_RUN_GRACE_MINUTES = 5;
/** One bounded page per sweep; a backlog drains over successive five-minute ticks. */
const STALLED_RUN_BATCH_SIZE = 20;

const INTERRUPTED_MESSAGE =
  "crawl run abandoned: no terminal outcome recorded before the execution lease expired";

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
 * Whether the abandoned run is still the shop's open question.
 *
 * This is the stalled signature the incident showed: an attempt with no terminal timestamp after
 * it. If a later crawl already recorded success or failure, that outcome is the current truth and
 * re-reporting this run would inflate the failure count and the backoff derived from it. A shop
 * whose lease is live is likewise left alone — that execution will record its own outcome.
 */
export function shouldRecordStalledRunFailure(
  state: CrawlLifecycleRow | undefined,
  run: StalledCrawlRunRow,
  now: Date,
): boolean {
  if (!state) return false;
  if (readCrawlLifecycle(state, now).phase === "executing") return false;
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
 * Closes crawl runs that no consumer can still finish, and makes the interruption visible.
 *
 * Without this, a hard-terminated crawl leaves `crawl_runs` permanently `running` and leaves shop
 * health reporting only an advancing attempt: the shop looks busy rather than broken, which is how
 * a shop went three days without a completed crawl while no failure was ever recorded. Recording
 * the failure also applies the normal backoff, so a shop that keeps timing out stops being retried
 * every rotation tick.
 *
 * The sweep is shop-agnostic by construction: it reads `crawl_runs`, not the shop registry.
 */
export async function recoverStalledCrawlRuns(
  db: QueryableDatabase,
  {
    now = new Date(),
    graceMinutes = STALLED_RUN_GRACE_MINUTES,
    limit = STALLED_RUN_BATCH_SIZE,
  }: RecoverStalledCrawlRunsOptions = {},
): Promise<StalledCrawlRunRecovery[]> {
  const abandonedAfterMinutes = CRAWL_EXECUTION_LEASE_MINUTES + Math.max(0, graceMinutes);
  const startedBefore = new Date(now.getTime() - abandonedAfterMinutes * 60_000).toISOString();
  const stalled = await listStalledCrawlRuns(db, { startedBefore, limit });
  if (!stalled.length) return [];

  const states = new Map(
    ((await listShopStates(db)) as CrawlLifecycleRow[]).map((row) => [row.shop_key, row]),
  );
  const recoveredAt = now.toISOString();
  const recovered: StalledCrawlRunRecovery[] = [];

  for (const run of stalled) {
    const closed = await finishCrawlRunInterrupted(db, run.id, {
      finishedAt: recoveredAt,
      message: INTERRUPTED_MESSAGE,
    });
    if (!closed) continue;

    const state = states.get(run.shop_key);
    const recordedFailure = shouldRecordStalledRunFailure(state, run, now);
    if (recordedFailure) {
      await markShopFailure(
        db,
        run.shop_key,
        recoveredAt,
        INTERRUPTED_MESSAGE,
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
      }),
    );
  }

  return recovered;
}
