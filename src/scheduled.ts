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
import { repairActiveListingProjectionGaps } from "./db/product-search-gap-repair.js";
import { getSyncHealth, logSyncHealth } from "./health.js";
import {
  dispatchKnowledgeCatalogDailyVerification,
  dispatchKnowledgeCatalogMonthlyRecheck,
} from "./knowledge-catalog/dispatch.js";
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

async function logCurrentSyncHealth(env: Env): Promise<void> {
  const health = await getSyncHealth(env);
  logSyncHealth(health);
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
  return result;
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
    await logCurrentSyncHealth(env);
    return recovered.length
      ? ({ status: "queued", queued: recovered } satisfies DispatchResult)
      : ({ status: "skipped", queued: [] } satisfies DispatchResult);
  }

  const dedicated = shopForCronAtScheduledTime(cron, scheduledAt);
  const rotating =
    cron === CRAWL_ROTATION_CRON ? roundRobinShopForScheduledTime(scheduledAt) : null;
  const selected = dedicated || rotating;
  const dispatch: DispatchResult = selected
    ? await dispatchScheduledCrawl(env, selected.key, { now: scheduledAt })
    : { status: "skipped", queued: [] };

  logDispatchResult(cron, dispatch);
  await logCurrentSyncHealth(env);
  return dispatch;
}

/**
 * One-shot rollout of a new verifier version.
 *
 * The version claim is an atomic conditional write, so of the many Worker instances that run the
 * general cron exactly one starts the rollout. The losers fall through and only dispatch when the
 * queue has never been bootstrapped at all.
 */
export async function bootstrapKnowledgeCatalogReview(env: Env) {
  const now = new Date();
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

  if (latestReview?.status === "running") {
    return { status: "skipped", reason: "knowledge_catalog_review_in_progress" };
  }
  if (latestReview?.status === "failed") {
    const failedRunId = Number(latestReview.id || 0);
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

interface ScheduledWork {
  name: string;
  run(env: Env): Promise<unknown>;
}

interface MaintenanceTask extends ScheduledWork {
  /**
   * General-cron ticks between two runs of this task. `1` is every five minutes.
   *
   * Tasks are additionally offset by their position in the table, so two tasks that share a cadence
   * never land on the same tick.
   */
  everyTicks: number;
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
 * Two properties fix that, and both matter: nothing here is frequent enough to deserve a
 * five-minute cadence, and the ones that are due run one after another rather than together.
 */
const MAINTENANCE_TASKS: readonly MaintenanceTask[] = [
  {
    // Derived work an interrupted crawl left owing. The pending stages are durable in D1 before any
    // of them is attempted, so the sweep is the dispatch: there is no window in which a run is owed
    // a continuation that was never sent. Kept the most frequent of these because it is the one
    // that finishes crawls.
    name: "resume_interrupted_crawl_runs",
    everyTicks: 2,
    run: (env) => resumeInterruptedCrawlRuns(env.DB),
  },
  {
    // Keep the cron claim itself listing-scoped. Projection code is also listing-scoped, but a
    // worker-level timeout cannot be caught reliably inside a ten-job sweep; claiming one job makes
    // the lease/retry boundary match the expensive projection boundary.
    name: "data_quality_remediation_sweep",
    everyTicks: 2,
    run: (env) => runDataQualityRemediationSweep(env.DB, { claimLimit: 1 }),
  },
  {
    name: "product_search_projection_repair",
    everyTicks: 6,
    run: (env) => repairGeneralCronProjectionGaps(env.DB),
  },
  // Both export recoveries treat a job as stuck after two minutes, so they stay near the old
  // cadence: stretching them to an hour would leave a user-visible export sitting for an hour to
  // save two bounded index lookups. Sequencing, not starvation, is what these two needed.
  {
    name: "stale_product_audit_export_jobs",
    everyTicks: 2,
    run: (env) => recoverStaleProductAuditExportJobs(env.DB, env.PRODUCT_AUDIT_EXPORT_QUEUE),
  },
  {
    name: "stale_knowledge_catalog_export_jobs",
    everyTicks: 2,
    run: (env) => recoverStaleKnowledgeCatalogExportJobs(env.DB, env.PRODUCT_AUDIT_EXPORT_QUEUE),
  },
  {
    // A one-shot rollout that has already happened costs a conditional write and three reads every
    // time it is asked. Hourly is plenty for a bootstrap that only has to fire once.
    name: "knowledge_catalog_review_bootstrap",
    everyTicks: 12,
    run: (env) => bootstrapKnowledgeCatalogReview(env),
  },
];

/**
 * The tasks due on this tick.
 *
 * The tick number comes from the wall clock rather than a counter so it survives isolate churn, and
 * the `+ index` offset is what spreads same-cadence tasks over different ticks instead of stacking
 * them on the ones divisible by their period.
 */
export function dueMaintenanceTasks(scheduledAt: Date): MaintenanceTask[] {
  const tick = Math.floor(scheduledAt.getTime() / GENERAL_CRON_INTERVAL_MS);
  return MAINTENANCE_TASKS.filter((task, index) => (tick + index) % task.everyTicks === 0);
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
    try {
      await task.run(env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "scheduled_maintenance_failed",
          task: task.name,
          message: errorMessage(error),
        }),
      );
    }
  }
}

/**
 * Two task trees per tick, not seven: the crawl watchdog, which every cron runs, and whichever
 * background maintenance is due. Remediation shares the five-minute trigger but never recrawls.
 */
export function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): void {
  const scheduledAt = new Date(controller.scheduledTime);
  ctx.waitUntil(runScheduled(controller.cron, env, scheduledAt));
  if (controller.cron === GENERAL_CRON) {
    ctx.waitUntil(runGeneralCronMaintenance(env, scheduledAt));
  }
}
