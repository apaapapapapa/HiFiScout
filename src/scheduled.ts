/**
 * Cron handling.
 *
 * Which cron does what is decided here; *which shop* a crawl cron belongs to is decided by
 * `crawler/schedule.ts` from adapter metadata and the deterministic round-robin policy.
 */

import { dispatchScheduledCrawl, recoverStalledCrawlDispatches } from "./crawler/dispatch.js";
import { ROUND_ROBIN_CRAWL_CRON, shopForCron, shopForRoundRobinSlot } from "./crawler/schedule.js";
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

/** Five-minute watchdog/maintenance trigger. Normal crawl starts use separate staggered triggers. */
export const GENERAL_CRON = "*/5 * * * *";
export const DAILY_MAINTENANCE_CRON = "17 18 * * *";
export const KNOWLEDGE_CATALOG_MONTHLY_CRON = "23 3 1 * *";

const GENERAL_PROJECTION_REPAIR_BATCH_SIZE = 5;
const GENERAL_PROJECTION_REPAIR_MAX_LISTINGS = 20;

function logDispatchResult(cron: string, dispatch: DispatchResult): void {
  const entry = { event: "crawl_dispatch", cron, ...dispatch };
  if (dispatch.status === "rejected" || (dispatch.status === "skipped" && "reason" in dispatch)) {
    console.warn(JSON.stringify(entry));
  } else console.log(JSON.stringify(entry));
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
  if (result.repairedCount > 0 || result.remainingGapCount > 0) {
    console.log(
      JSON.stringify({
        event: "general_product_search_projection_repair",
        ...result,
      }),
    );
  }
  return result;
}

/**
 * Retention, projection self-healing and daily verification are independent, so all are attempted
 * even when one fails — but the first failure is still rethrown so the cron is reported as failed.
 */
async function runDailyMaintenance(env: Env) {
  const [retention, projectionRepair, catalog] = await Promise.allSettled([
    runRetentionCleanup(env),
    repairActiveListingProjectionGaps(env.DB),
    dispatchKnowledgeCatalogDailyVerification(env),
  ]);
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

export async function runScheduled(cron: string, env: Env, scheduledTimeMs = Date.now()) {
  if (cron === DAILY_MAINTENANCE_CRON) return runDailyMaintenance(env);
  if (cron === KNOWLEDGE_CATALOG_MONTHLY_CRON) return dispatchKnowledgeCatalogMonthlyRecheck(env);

  const scheduledAt = new Date(scheduledTimeMs);
  let dispatch: DispatchResult;
  const dedicated = shopForCron(cron);
  if (dedicated) {
    dispatch = await dispatchScheduledCrawl(env, dedicated.key, { now: scheduledAt });
  } else if (cron === ROUND_ROBIN_CRAWL_CRON) {
    const shop = shopForRoundRobinSlot(scheduledTimeMs);
    dispatch = shop
      ? await dispatchScheduledCrawl(env, shop.key, { now: scheduledAt })
      : { status: "skipped", queued: [] };
  } else if (cron === GENERAL_CRON) {
    const recovered = await recoverStalledCrawlDispatches(env, { now: scheduledAt });
    dispatch = recovered.length
      ? { status: "queued", queued: recovered }
      : { status: "skipped", queued: [] };
  } else {
    dispatch = { status: "skipped", queued: [] };
  }

  logDispatchResult(cron, dispatch);
  const health = await getSyncHealth(env);
  logSyncHealth(health);
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

/**
 * Crawl watchdog, catalog verification rollout, and data-quality replay are independent bounded
 * tasks. Normal crawl starts are staggered onto dedicated or 15-minute round-robin triggers.
 */
export function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): void {
  ctx.waitUntil(runScheduled(controller.cron, env, controller.scheduledTime));
  if (controller.cron === GENERAL_CRON) {
    ctx.waitUntil(bootstrapKnowledgeCatalogReview(env));
    ctx.waitUntil(repairGeneralCronProjectionGaps(env.DB));
    // Keep the cron claim itself listing-scoped. Projection code is also listing-scoped, but a
    // worker-level timeout cannot be caught reliably inside a ten-job sweep; claiming one job makes
    // the lease/retry boundary match the expensive projection boundary.
    ctx.waitUntil(runDataQualityRemediationSweep(env.DB, { claimLimit: 1 }));
    ctx.waitUntil(recoverStaleProductAuditExportJobs(env.DB, env.PRODUCT_AUDIT_EXPORT_QUEUE));
    ctx.waitUntil(recoverStaleKnowledgeCatalogExportJobs(env.DB, env.PRODUCT_AUDIT_EXPORT_QUEUE));
  }
}
