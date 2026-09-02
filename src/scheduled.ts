/**
 * Cron handling.
 *
 * Which cron does what is decided here; *which shop* a crawl cron belongs to is decided by
 * `crawler/schedule.ts` from adapter metadata, so adding a shop never touches this file.
 */

import { resumeInterruptedCrawlRuns } from "./crawler/crawl-continuation.js";
import { recoverStalledCrawlRuns } from "./crawler/crawl-run-recovery.js";
import { dispatchScheduledCrawl, recoverStalledCrawlDispatches } from "./crawler/dispatch.js";
import { roundRobinShopForScheduledTime, shopForCronAtScheduledTime } from "./crawler/schedule.js";
import { KNOWLEDGE_CATALOG_VERIFIER_VERSION } from "./catalog/knowledge-verification/verifier.js";
import { runDataQualityRemediationSweep } from "./db/data-quality-remediation-service.js";
import {
  deadLetterOutstandingKnowledgeCatalogVerificationJobsForRun,
  knowledgeCatalogReviewRunLiveness,
  knowledgeCatalogVerificationQueueStatus,
} from "./db/knowledge-catalog-verification-queue-repository.js";
import {
  finishKnowledgeCatalogReviewRunFailure,
  latestKnowledgeCatalogReviewRunState,
  startKnowledgeCatalogRecoveryReviewRun,
} from "./db/knowledge-catalog-review-repository.js";
import {
  claimKnowledgeCatalogVerifierVersion,
  knowledgeCatalogVerifierState,
} from "./db/knowledge-catalog-verifier-state-repository.js";
import { accountReads } from "./db/read-accounting.js";
import {
  countDirtyExactIdentityBacklog,
  repairDirtyExactIdentities,
} from "./db/product-search-exact-identity-dirty.js";
import { repairActiveListingProjectionGaps } from "./db/product-search-gap-repair.js";
import { getSyncHealth, logSyncHealth } from "./health.js";
import type { SyncHealthEnv, SyncHealthReport } from "./health.js";
import {
  dispatchKnowledgeCatalogDailyVerification,
  dispatchKnowledgeCatalogMonthlyRecheck,
} from "./knowledge-catalog/dispatch.js";
import {
  isKnowledgeCatalogQueueDailyWriteLimit,
  shouldDeferKnowledgeCatalogQueueQuotaRecovery,
} from "./knowledge-catalog/queue-write-quota.js";
import { recoverStaleKnowledgeCatalogExportJobs } from "./knowledge-catalog-export/service.js";
import { runRetentionCleanup } from "./maintenance.js";
import { recoverStaleProductAuditExportJobs } from "./product-audit-export/service.js";
import { errorMessage } from "./types.js";
import type { DispatchResult } from "./crawler/types.js";
import type { QueryableDatabase } from "./db/types.js";

/** Five-minute maintenance/watchdog sweep. It no longer starts new shop crawls. */
export const GENERAL_CRON = "*/5 * * * *";
/** One non-dedicated shop is selected on each tick, giving a ten-minute round-robin start cadence. */
export const CRAWL_ROTATION_CRON = "6-56/10 * * * *";

/**
 * Cloudflare Free permits five cron triggers per account. Shops with a dedicated cadence may share
 * one trigger, so production stays under that limit with a slot to spare. Less time-sensitive
 * daily/monthly jobs still piggyback on GENERAL_CRON rather than consuming another trigger. Times
 * are the first five-minute tick after the former dedicated schedule.
 */
const DAILY_MAINTENANCE_UTC_HOUR = 18;
const DAILY_MAINTENANCE_UTC_MINUTE = 20;
const KNOWLEDGE_CATALOG_MONTHLY_UTC_DAY = 1;
const KNOWLEDGE_CATALOG_MONTHLY_UTC_HOUR = 3;
const KNOWLEDGE_CATALOG_MONTHLY_UTC_MINUTE = 25;

const GENERAL_PROJECTION_REPAIR_BATCH_SIZE = 5;
const GENERAL_PROJECTION_REPAIR_MAX_LISTINGS = 20;

/**
 * Identities the five-minute tick claims from the dirty set.
 *
 * Higher than the listing budget above because the unit is different and so is the cost: a clean
 * identity -- the common case, since most changes do not split a group -- is one indexed lookup,
 * and only the genuinely split ones pay for a resync. A crawl commonly touches more distinct
 * identities than this in five minutes, so the queue is expected to carry a backlog between ticks;
 * it drains in `marked_at` order, which is why a busy identity cannot starve a quiet one.
 */
const GENERAL_EXACT_IDENTITY_DIRTY_LIMIT = 25;

export function isDailyMaintenanceSlot(scheduledAt: Date): boolean {
  return (
    scheduledAt.getUTCHours() === DAILY_MAINTENANCE_UTC_HOUR &&
    scheduledAt.getUTCMinutes() === DAILY_MAINTENANCE_UTC_MINUTE
  );
}

export function isKnowledgeCatalogMonthlySlot(scheduledAt: Date): boolean {
  return (
    scheduledAt.getUTCDate() === KNOWLEDGE_CATALOG_MONTHLY_UTC_DAY &&
    scheduledAt.getUTCHours() === KNOWLEDGE_CATALOG_MONTHLY_UTC_HOUR &&
    scheduledAt.getUTCMinutes() === KNOWLEDGE_CATALOG_MONTHLY_UTC_MINUTE
  );
}

function logDispatchResult(cron: string, dispatch: DispatchResult): void {
  const entry = { event: "crawl_dispatch", cron, ...dispatch };
  if (dispatch.status === "rejected" || (dispatch.status === "skipped" && "reason" in dispatch)) {
    console.warn(JSON.stringify(entry));
  } else console.log(JSON.stringify(entry));
}

export type ScheduledSyncHealthReadReason = "general_cron" | "abnormal_dispatch";

export interface ScheduledSyncHealthMeasurement {
  health: SyncHealthReport;
  rowsRead: number;
  rowsWritten: number;
  countedStatements: number;
}

/**
 * Decides when a scheduled trigger is allowed to pay for the full cross-shop health snapshot.
 *
 * GENERAL_CRON is the authoritative five-minute cadence. Ordinary crawl triggers already read and
 * update the one shop they dispatch, so repeating the whole-table snapshot after every successful
 * dispatch only multiplies D1 reads. Rejected/lease-blocked dispatches retain an immediate snapshot
 * because that is the diagnostic path operators need when a trigger did not do its normal work.
 */
export function scheduledSyncHealthReadReason(
  cron: string,
  dispatch: DispatchResult,
): ScheduledSyncHealthReadReason | null {
  if (cron === GENERAL_CRON) return "general_cron";
  if (dispatch.status === "rejected" || (dispatch.status === "skipped" && "reason" in dispatch)) {
    return "abnormal_dispatch";
  }
  return null;
}

/** Reads the authoritative snapshot through D1's own per-statement rows_read accounting. */
export async function measureScheduledSyncHealth(
  env: SyncHealthEnv,
  now = new Date(),
): Promise<ScheduledSyncHealthMeasurement> {
  const accounting = accountReads(env.DB);
  const health = await getSyncHealth({ ...env, DB: accounting.db }, now);
  return {
    health,
    rowsRead: accounting.rowsRead(),
    rowsWritten: accounting.rowsWritten(),
    countedStatements: accounting.countedStatements(),
  };
}

async function logCurrentSyncHealth(
  env: Env,
  cron: string,
  reason: ScheduledSyncHealthReadReason,
  now: Date,
): Promise<void> {
  const measurement = await measureScheduledSyncHealth(env, now);
  logSyncHealth(measurement.health);
  console.log(
    JSON.stringify({
      event: "scheduled_sync_health_d1_usage",
      cron,
      reason,
      status: measurement.health.status,
      rowsRead: measurement.rowsRead,
      rowsWritten: measurement.rowsWritten,
      countedStatements: measurement.countedStatements,
    }),
  );
}

async function logScheduledSyncHealthIfNeeded(
  env: Env,
  cron: string,
  dispatch: DispatchResult,
  now: Date,
): Promise<void> {
  const reason = scheduledSyncHealthReadReason(cron, dispatch);
  if (reason) await logCurrentSyncHealth(env, cron, reason, now);
}

/**
 * Repair only a small listing-scoped slice on every five-minute sweep. Crawl, Product Identity and
 * Product Search are separate bounded writes; a Worker hard-kill can therefore leave a verified
 * Identity match pointing at its old fallback entity even though neither subsystem is otherwise
 * unhealthy. Daily repair is too slow for a user-facing search read model, while this bounded pass
 * gives the interrupted transition a deterministic five-minute convergence path without turning
 * the scheduler into a shop-wide rebuild.
 */
export async function repairGeneralCronProjectionGaps(db: QueryableDatabase) {
  const result = await repairActiveListingProjectionGaps(db, {
    batchSize: GENERAL_PROJECTION_REPAIR_BATCH_SIZE,
    maxListings: GENERAL_PROJECTION_REPAIR_MAX_LISTINGS,
    // The exact-identity peer scan is the expensive, lowest-priority phase, and every tick pays for
    // its selector even when there is nothing to repair. `repairHourlyExactIdentityGaps` owns it.
    phases: "coverage",
  });
  // The outstanding-gap count is deliberately not requested here: it is the one unbounded query in
  // the repair, and this caller only needs to know whether it did anything. `runDailyMaintenance`
  // pays for the authoritative number once a day.
  if (result.repairedCount > 0) {
    console.log(
      JSON.stringify({
        event: "general_product_search_projection_repair",
        ...result,
      }),
    );
  }

  // The change-driven half of exact-identity repair rides on this tick rather than taking a slot of
  // its own in the task table. That is the whole claim being made: with the identity known up front
  // the check is an indexed lookup of one group, so it is cheap enough to run twelve times an hour,
  // where the scan it replaces was not cheap enough to run once. Keeping it here also keeps the
  // per-tick task count -- and the D1 concurrency that count exists to bound -- unchanged.
  const dirty = await repairDirtyExactIdentities(db, {
    limit: GENERAL_EXACT_IDENTITY_DIRTY_LIMIT,
  });
  if (dirty.claimedIdentities > 0) {
    console.log(JSON.stringify({ event: "general_exact_identity_dirty_repair", ...dirty }));
  }
  return { ...result, dirtyExactIdentities: dirty };
}

/** `Promise.allSettled`'s per-operation outcome, for work that must not be started in parallel. */
async function settled<T>(operation: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await operation() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

/**
 * Retention, projection self-healing and daily verification are independent, so all are attempted
 * even when one fails — but the first failure is still rethrown so the cron is reported as failed.
 */
async function runDailyMaintenance(env: Env) {
  // Awaited one at a time rather than through `Promise.allSettled` on three already-running
  // promises. These are the heaviest statements the system issues — a retention drain, the
  // unbounded gap count, a verification dispatch — and starting them together made the daily slot
  // the single largest concurrent load on the one D1 instance. The semantics are unchanged: all
  // three are still attempted, and the first failure is still the one rethrown.
  const retention = await settled(() => runRetentionCleanup(env));
  const projectionRepair = await settled(() =>
    repairActiveListingProjectionGaps(env.DB, { countRemainingGaps: true }),
  );
  const catalog = await settled(() => dispatchKnowledgeCatalogDailyVerification(env));
  if (retention.status === "rejected") {
    console.error(
      JSON.stringify({
        event: "daily_retention_failed",
        message: errorMessage(retention.reason),
      }),
    );
  }
  if (projectionRepair.status === "rejected") {
    console.error(
      JSON.stringify({
        event: "product_search_projection_repair_failed",
        message: errorMessage(projectionRepair.reason),
      }),
    );
  }
  if (catalog.status === "rejected") {
    console.error(
      JSON.stringify({
        event: "knowledge_catalog_daily_dispatch_failed",
        message: errorMessage(catalog.reason),
      }),
    );
  }
  if (retention.status === "rejected") throw retention.reason;
  if (projectionRepair.status === "rejected") throw projectionRepair.reason;
  if (catalog.status === "rejected") throw catalog.reason;
  return {
    retention: retention.value,
    projectionRepair: projectionRepair.value,
    catalog: catalog.value,
  };
}

export async function runScheduled(cron: string, env: Env, scheduledAt = new Date()) {
  if (cron === GENERAL_CRON) {
    // Runs are reconciled before dispatches: an abandoned run records the shop failure, and the
    // backoff that failure applies is what stops a shop that keeps timing out from being redialled
    // on the very next tick.
    await recoverStalledCrawlRuns(env.DB, { now: scheduledAt });
    const recovered = await recoverStalledCrawlDispatches(env, { now: scheduledAt });
    const dispatch: DispatchResult = recovered.length
      ? ({ status: "queued", queued: recovered } satisfies DispatchResult)
      : ({ status: "skipped", queued: [] } satisfies DispatchResult);
    await logScheduledSyncHealthIfNeeded(env, cron, dispatch, scheduledAt);
    return dispatch;
  }

  const dedicated = shopForCronAtScheduledTime(cron, scheduledAt);
  const rotating =
    cron === CRAWL_ROTATION_CRON ? roundRobinShopForScheduledTime(scheduledAt) : null;
  const selected = dedicated || rotating;
  const dispatch: DispatchResult = selected
    ? await dispatchScheduledCrawl(env, selected.key, { now: scheduledAt })
    : { status: "skipped", queued: [] };

  logDispatchResult(cron, dispatch);
  await logScheduledSyncHealthIfNeeded(env, cron, dispatch, scheduledAt);
  return dispatch;
}

/**
 * How long a `running` review run with no live jobs is left alone before it is declared stranded.
 *
 * Nothing can move such a run, so its own last write already settles the question; this only has to
 * outlast the moment a job spends between states, so a finalizer mid-flight is never failed out
 * from under itself.
 */
const STRANDED_REVIEW_RUN_MS = 30 * 60 * 1000;

/**
 * How long a `running` review run that still looks deliverable is left alone.
 *
 * Two states look deliverable but need not be. A run interrupted before it created any jobs has
 * nothing to deliver, and a run interrupted between inserting `queued` rows and sending their
 * messages has rows no consumer will ever claim -- in both cases every later bootstrap would report
 * `knowledge_catalog_review_in_progress` forever. Neither can be told apart from healthy work by
 * inspection, so they are told apart by silence instead. Job and domain leases are bounded at 1800
 * seconds, so a genuinely working run cannot be quiet this long, and the threshold is well clear of
 * that ceiling rather than equal to it.
 */
const STALLED_REVIEW_RUN_MS = 120 * 60 * 1000;

/** Why a stranded run was failed, recorded on the run and read back by the recovery below. */
const STRANDED_REVIEW_RUN_MESSAGE = "knowledge_catalog_review_run_stranded_without_live_jobs";

interface StrandedReviewRun {
  runId: number;
  totalJobs: number;
  lastActivityAt: string;
}

/**
 * A review run that says `running` but that nothing will finish.
 *
 * The finalizer is what moves a run to `success`, and the dead-letter consumer is what moves a run
 * whose finalizer died to `failed`. Those are two separate writes, so a finalizer that dead-letters
 * while D1 is refusing writes closes the job without failing the run, and the run then says
 * `running` with every one of its jobs terminal.
 *
 * A hard kill during dispatch strands a run just as permanently while leaving it looking busy: no
 * jobs at all, or `queued` rows whose queue messages were never sent. Progress, not job state, is
 * therefore what decides -- a run is stranded once nothing about it has moved for long enough, and
 * how long that is depends only on whether anything could still have moved it.
 */
async function strandedKnowledgeCatalogReviewRun(
  db: Env["DB"],
  run: { id?: unknown; started_at?: unknown },
  now: Date,
): Promise<StrandedReviewRun | null> {
  const runId = Number(run.id || 0);
  if (!runId) return null;
  const liveness = await knowledgeCatalogReviewRunLiveness(db, runId);
  // A run with no jobs has no timestamp of its own; it is dated by when it started.
  const lastActivityAt = liveness.lastActivityAt || String(run.started_at || "");
  const lastActivity = Date.parse(lastActivityAt);
  if (!Number.isFinite(lastActivity)) return null;
  const deliverable = liveness.liveJobs > 0 || liveness.totalJobs === 0;
  const idleFor = deliverable ? STALLED_REVIEW_RUN_MS : STRANDED_REVIEW_RUN_MS;
  if (now.getTime() - lastActivity < idleFor) return null;
  return { runId, totalJobs: liveness.totalJobs, lastActivityAt };
}

/**
 * One-shot rollout of a new verifier version.
 *
 * The version claim is an atomic conditional write, so of the many Worker instances that run the
 * general cron exactly one starts the rollout. The losers fall through and only dispatch when the
 * queue has never been bootstrapped at all.
 */
export async function bootstrapKnowledgeCatalogReview(env: Env, now = new Date()) {
  const startedAt = now.toISOString();
  const claimed = await claimKnowledgeCatalogVerifierVersion(
    env.DB,
    KNOWLEDGE_CATALOG_VERIFIER_VERSION,
    startedAt,
  );
  if (claimed) {
    console.log(
      JSON.stringify({
        event: "knowledge_catalog_verifier_rollout_started",
        verifierVersion: KNOWLEDGE_CATALOG_VERIFIER_VERSION,
        mode: "daily_candidates_queue",
      }),
    );
    return dispatchKnowledgeCatalogDailyVerification(env, {
      now,
      preferRetries: false,
      verifierVersion: KNOWLEDGE_CATALOG_VERIFIER_VERSION,
    });
  }

  const [state, queue, latestReview] = await Promise.all([
    knowledgeCatalogVerifierState(env.DB),
    knowledgeCatalogVerificationQueueStatus(env.DB),
    latestKnowledgeCatalogReviewRunState(env.DB),
  ]);

  // A rollout that claimed the version but never finished keeps its version; anything else
  // bootstraps at 0 so the run is treated as a plain first fill rather than a rollout.
  const verifierVersion =
    state?.version === KNOWLEDGE_CATALOG_VERIFIER_VERSION && state.status !== "success"
      ? KNOWLEDGE_CATALOG_VERIFIER_VERSION
      : 0;

  let reviewStatus = latestReview?.status;
  let reviewMessage = latestReview?.message;
  if (reviewStatus === "running") {
    const stranded = await strandedKnowledgeCatalogReviewRun(env.DB, latestReview ?? {}, now);
    if (!stranded) {
      return { status: "skipped", reason: "knowledge_catalog_review_in_progress" };
    }
    // Nothing can advance this run any more, and `running` is what makes the branch above skip
    // every later tick, so leaving it would block Knowledge Catalog review forever.
    await finishKnowledgeCatalogReviewRunFailure(
      env.DB,
      stranded.runId,
      now.toISOString(),
      STRANDED_REVIEW_RUN_MESSAGE,
    );
    console.warn(
      JSON.stringify({
        event: "knowledge_catalog_stranded_review_run_failed",
        runId: stranded.runId,
        totalJobs: stranded.totalJobs,
        lastActivityAt: stranded.lastActivityAt,
      }),
    );
    // Recovery runs in this same tick rather than the next one. The bootstrap is hourly, so
    // returning here would leave the catalog waiting another hour for the successor run it
    // already knows it needs.
    reviewStatus = "failed";
    reviewMessage = STRANDED_REVIEW_RUN_MESSAGE;
  }
  if (reviewStatus === "failed") {
    const failedRunId = Number(latestReview?.id || 0);
    if (
      await shouldDeferKnowledgeCatalogQueueQuotaRecovery(env.DB, failedRunId, reviewMessage, now)
    ) {
      return { status: "skipped", reason: "knowledge_catalog_queue_daily_write_limit" };
    }
    const recoveryRunId = failedRunId
      ? await startKnowledgeCatalogRecoveryReviewRun(env.DB, failedRunId, startedAt)
      : null;
    if (!recoveryRunId) {
      return { status: "skipped", reason: "knowledge_catalog_recovery_already_claimed" };
    }
    try {
      const abandonedJobs = await deadLetterOutstandingKnowledgeCatalogVerificationJobsForRun(
        env.DB,
        failedRunId,
        startedAt,
        `abandoned_after_failed_run:${failedRunId}`,
      );
      console.warn(
        JSON.stringify({
          event: "knowledge_catalog_failed_run_recovery_started",
          failedRunId,
          recoveryRunId,
          abandonedJobs,
          verifierVersion,
        }),
      );
      return await dispatchKnowledgeCatalogDailyVerification(env, {
        now,
        preferRetries: true,
        verifierVersion,
        runId: recoveryRunId,
      });
    } catch (error) {
      await finishKnowledgeCatalogReviewRunFailure(
        env.DB,
        recoveryRunId,
        new Date().toISOString(),
        `knowledge_catalog_recovery_dispatch_failed:${errorMessage(error)}`,
      );
      throw error;
    }
  }
  if (queue.latestRunId) {
    return { status: "skipped", reason: "knowledge_catalog_queue_already_bootstrapped" };
  }
  console.log(
    JSON.stringify({
      event: "knowledge_catalog_queue_rollout_started",
      verifierVersion,
      mode: "daily_candidates_queue",
    }),
  );
  return dispatchKnowledgeCatalogDailyVerification(env, {
    now,
    preferRetries: false,
    verifierVersion,
  });
}

/**
 * The exact-identity split-membership phase, on its own hourly cadence.
 *
 * Its selector is the only one that joins `products` to itself on identity, so unlike the coverage
 * and stale-fallback phases it cannot be answered from an index alone: a tick pays for it across
 * every active listing even when nothing is drifting. The drift it repairs is also the least
 * user-visible of the three -- two listings for one product sitting in separate search entities --
 * so paying for it twelve times an hour bought very little and cost the D1 read budget a great
 * deal. The cheaper phases keep the five-minute cadence they need.
 */
export async function repairHourlyExactIdentityGaps(db: QueryableDatabase) {
  const result = await repairActiveListingProjectionGaps(db, {
    batchSize: GENERAL_PROJECTION_REPAIR_BATCH_SIZE,
    maxListings: GENERAL_PROJECTION_REPAIR_MAX_LISTINGS,
    // Only this phase. The phases share one work budget, so running the cheap ones here too would
    // let a sustained coverage backlog spend the whole budget and skip the phase this task is for.
    phases: "exact-identity",
  });
  // This scan is now a safety net rather than the repair path, so what it finds is the measurement
  // that decides whether the net can be loosened -- which only works if a repair here means what the
  // metric claims it means.
  //
  // It does not mean that on its own. The change-driven pass claims a bounded batch, so a genuinely
  // recorded identity that has not yet reached the front of the queue can be repaired here first,
  // and that is ordinary backlog rather than a trigger that failed to fire. The two are only
  // distinguishable against the queue: with nothing outstanding, a repair here is a coverage hole and
  // nothing else. Reporting them as one number would have counted the drain of the migration's own
  // seed as hundreds of trigger misses.
  if (result.repairedCount > 0) {
    const backlog = await countDirtyExactIdentityBacklog(db);
    const entry = { repairedListings: result.repairedCount, dirtyBacklog: backlog, ...result };
    if (backlog === 0) {
      console.warn(JSON.stringify({ event: "exact_identity_dirty_set_missed", ...entry }));
    } else {
      console.log(JSON.stringify({ event: "exact_identity_full_scan_drained_backlog", ...entry }));
    }
  }
  return result;
}

/**
 * A failed review caused by the free-tier daily Queue write ceiling needs a different cadence from
 * the ordinary one-shot bootstrap. Probe only that condition every ten minutes. On the same UTC
 * day it is a no-op; after the quota day rolls over it delegates to the normal atomic recovery path.
 */
export async function recoverKnowledgeCatalogQueueQuota(env: Env, now = new Date()) {
  const latestReview = await latestKnowledgeCatalogReviewRunState(env.DB);
  const failedRunId = Number(latestReview?.id || 0);
  if (
    latestReview?.status !== "failed" ||
    !failedRunId ||
    !isKnowledgeCatalogQueueDailyWriteLimit(latestReview.message)
  ) {
    return { status: "skipped", reason: "knowledge_catalog_no_queue_quota_failure" };
  }
  if (
    await shouldDeferKnowledgeCatalogQueueQuotaRecovery(
      env.DB,
      failedRunId,
      latestReview.message,
      now,
    )
  ) {
    return { status: "skipped", reason: "knowledge_catalog_queue_daily_write_limit" };
  }
  return bootstrapKnowledgeCatalogReview(env, now);
}

interface ScheduledWork {
  name: string;
  run(env: Env): Promise<unknown>;
}

interface MaintenanceTask extends ScheduledWork {
  /** General-cron ticks between two runs of this task. `1` is every five minutes. */
  everyTicks: number;
  /**
   * Which tick of its cadence this task lands on, so two tasks sharing a cadence do not stack.
   *
   * Stated per task rather than taken from the table's ordering: deriving it from array position
   * meant inserting one task silently moved every task after it onto a different tick, which is how
   * a new hourly task pushed the 18:20 UTC daily slot from four concurrent tasks to five.
   */
  offset: number;
}

const GENERAL_CRON_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Background work the general cron owns, and how often each piece actually needs to run.
 *
 * Every entry here used to be started on every five-minute tick, all at once. D1 is a single
 * Durable Object shared by every caller, so that turned each tick into a burst of concurrent query
 * trees against one instance — enough to have it reset under its own CPU limit, which takes down
 * whatever else was talking to D1 at that moment, crawl consumers included.
 *
 * Two properties fix that, and both matter: the projection repair is the one five-minute exception
 * because it is the bounded convergence path for user-facing search; less urgent work is rotated,
 * and everything that is due runs one after another rather than together.
 */
const MAINTENANCE_TASKS: readonly MaintenanceTask[] = [
  {
    // Derived work an interrupted crawl left owing. The pending stages are durable in D1 before any
    // of them is attempted, so the sweep is the dispatch: there is no window in which a run is owed
    // a continuation that was never sent. Kept the most frequent of these because it is the one
    // that finishes crawls.
    name: "resume_interrupted_crawl_runs",
    everyTicks: 2,
    offset: 0,
    run: (env) => resumeInterruptedCrawlRuns(env.DB),
  },
  {
    // Keep the cron claim itself listing-scoped. Projection code is also listing-scoped, but a
    // worker-level timeout cannot be caught reliably inside a ten-job sweep; claiming one job makes
    // the lease/retry boundary match the expensive projection boundary.
    name: "data_quality_remediation_sweep",
    everyTicks: 2,
    offset: 1,
    run: (env) => runDataQualityRemediationSweep(env.DB, { claimLimit: 1 }),
  },
  {
    // This is the bounded convergence mechanism promised by repairGeneralCronProjectionGaps: if a
    // crawl commits between sweeps, stale fallback search state is repaired by the very next tick.
    name: "product_search_projection_repair",
    everyTicks: 1,
    offset: 2,
    run: (env) => repairGeneralCronProjectionGaps(env.DB),
  },
  {
    // Split out of the five-minute sweep because its selector is the only one that cannot be
    // answered from an index, so it was charging the read budget for a full identity self-join
    // every tick to repair the least user-visible drift of the three.
    name: "product_search_exact_identity_repair",
    everyTicks: 12,
    offset: 0,
    run: (env) => repairHourlyExactIdentityGaps(env.DB),
  },
  // Both export recoveries treat a job as stuck after two minutes, so they stay near the old
  // cadence: stretching them to an hour would leave a user-visible export sitting for an hour to
  // save two bounded index lookups. Sequencing, not starvation, is what these two needed.
  {
    name: "stale_product_audit_export_jobs",
    everyTicks: 2,
    offset: 3,
    run: (env) => recoverStaleProductAuditExportJobs(env.DB, env.PRODUCT_AUDIT_EXPORT_QUEUE),
  },
  {
    name: "stale_knowledge_catalog_export_jobs",
    everyTicks: 2,
    offset: 4,
    run: (env) => recoverStaleKnowledgeCatalogExportJobs(env.DB, env.PRODUCT_AUDIT_EXPORT_QUEUE),
  },
  {
    // The normal bootstrap remains hourly. This narrow task adds a ten-minute recovery path after a
    // known daily Queue quota failure without making every five-minute tick exceed the D1 task
    // budget that GENERAL_CRON serialization is intended to enforce.
    name: "knowledge_catalog_queue_quota_recovery",
    everyTicks: 2,
    offset: 5,
    run: (env) => recoverKnowledgeCatalogQueueQuota(env),
  },
  {
    // A one-shot rollout that has already happened costs a conditional write and three reads every
    // time it is asked. Hourly is plenty for the ordinary bootstrap; quota recovery is handled by
    // the narrow ten-minute task above.
    name: "knowledge_catalog_review_bootstrap",
    everyTicks: 12,
    offset: 6,
    run: (env) => bootstrapKnowledgeCatalogReview(env),
  },
];

/**
 * The tasks due on this tick.
 *
 * The tick number comes from the wall clock rather than a counter so it survives isolate churn, and
 * each task's own offset is what spreads same-cadence tasks over different ticks instead of
 * stacking them on the ones divisible by their period.
 */
export function dueMaintenanceTasks(scheduledAt: Date): MaintenanceTask[] {
  const tick = Math.floor(scheduledAt.getTime() / GENERAL_CRON_INTERVAL_MS);
  return MAINTENANCE_TASKS.filter((task) => (tick + task.offset) % task.everyTicks === 0);
}

/**
 * Runs the due maintenance one task at a time.
 *
 * Sequential is the point: these are independent, and a few seconds of ordering costs none of them
 * anything it cares about, while starting them together is what made a tick a burst.
 *
 * One task failing must not skip the rest, so each is caught on its own. That does mean a failure
 * here no longer surfaces as the cron's own outcome — a named `scheduled_maintenance_failed` line
 * is a better signal than an anonymous cron exception that could have come from any of seven
 * places, which is what the fan-out produced.
 */
async function runGeneralCronMaintenance(env: Env, scheduledAt: Date): Promise<void> {
  const tasks: ScheduledWork[] = [...dueMaintenanceTasks(scheduledAt)];
  if (isDailyMaintenanceSlot(scheduledAt)) {
    tasks.push({ name: "daily_maintenance", run: runDailyMaintenance });
  }
  if (isKnowledgeCatalogMonthlySlot(scheduledAt)) {
    tasks.push({
      name: "knowledge_catalog_monthly_recheck",
      run: dispatchKnowledgeCatalogMonthlyRecheck,
    });
  }
  for (const task of tasks) {
    // Measured per task rather than per tick: the point of the number is to say which task is
    // spending the day's read budget, which a tick-level total cannot answer.
    const accounting = accountReads(env.DB);
    const measuredEnv = { ...env, DB: accounting.db } as Env;
    try {
      await task.run(measuredEnv);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "scheduled_maintenance_failed",
          task: task.name,
          message: errorMessage(error),
          rowsRead: accounting.rowsRead(),
        }),
      );
      continue;
    }
    if (accounting.rowsRead() > 0) {
      console.log(
        JSON.stringify({
          event: "scheduled_maintenance_d1_usage",
          task: task.name,
          rowsRead: accounting.rowsRead(),
          rowsWritten: accounting.rowsWritten(),
          countedStatements: accounting.countedStatements(),
        }),
      );
    }
  }
}

/**
 * Runs the GENERAL_CRON watchdog and maintenance as one sequential task tree.
 *
 * The watchdog and maintenance both issue D1 work. Starting them through separate `waitUntil`
 * calls lets the two query trees contend inside the same isolate, undermining the maintenance
 * serialization above. Maintenance must still run when the watchdog fails, while the watchdog
 * failure must remain visible as the cron outcome.
 */
export async function runGeneralCronTick<T>(
  scheduledWork: () => Promise<T>,
  maintenanceWork: () => Promise<void>,
): Promise<T> {
  const scheduledResult = await settled(scheduledWork);
  const maintenanceResult = await settled(maintenanceWork);
  if (scheduledResult.status === "rejected") throw scheduledResult.reason;
  if (maintenanceResult.status === "rejected") throw maintenanceResult.reason;
  return scheduledResult.value;
}

/**
 * GENERAL_CRON uses one task tree so its D1 work is serialized. Other crawl crons keep the direct
 * scheduled path because they do not own the general maintenance sweep.
 */
export function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): void {
  const scheduledAt = new Date(controller.scheduledTime);
  if (controller.cron === GENERAL_CRON) {
    ctx.waitUntil(
      runGeneralCronTick(
        () => runScheduled(controller.cron, env, scheduledAt),
        () => runGeneralCronMaintenance(env, scheduledAt),
      ),
    );
    return;
  }
  ctx.waitUntil(runScheduled(controller.cron, env, scheduledAt));
}
