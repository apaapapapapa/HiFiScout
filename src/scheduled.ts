/**
 * Cron handling.
 *
 * Which cron does what is decided here; *which shop* a crawl cron belongs to is decided by
 * `crawler/schedule.ts` from adapter metadata, so adding a shop never touches this file.
 */

import { dispatchDueCrawls, dispatchScheduledCrawl } from "./crawler/dispatch.js";
import { sharedSweepExclusions, shopForCron } from "./crawler/schedule.js";
import { KNOWLEDGE_CATALOG_VERIFIER_VERSION } from "./catalog/knowledge-verification/verifier.js";
import { runDataQualityRemediationSweep } from "./db/data-quality-remediation-service.js";
import { knowledgeCatalogVerificationQueueStatus } from "./db/knowledge-catalog-verification-queue-repository.js";
import {
  claimKnowledgeCatalogVerifierVersion,
  knowledgeCatalogVerifierState,
} from "./db/knowledge-catalog-verifier-state-repository.js";
import { getSyncHealth, logSyncHealth } from "./health.js";
import {
  dispatchKnowledgeCatalogDailyVerification,
  dispatchKnowledgeCatalogMonthlyRecheck,
} from "./knowledge-catalog/dispatch.js";
import { runRetentionCleanup } from "./maintenance.js";
import { errorMessage } from "./types.js";
import type { DispatchResult } from "./crawler/types.js";

/** The shared sweep. Also the trigger that gets a chance to bootstrap a verifier rollout. */
export const GENERAL_CRON = "*/5 * * * *";
export const DAILY_MAINTENANCE_CRON = "17 18 * * *";
export const KNOWLEDGE_CATALOG_MONTHLY_CRON = "23 3 1 * *";

function logDispatchResult(cron: string, dispatch: DispatchResult): void {
  const entry = { event: "crawl_dispatch", cron, ...dispatch };
  if (dispatch.status === "rejected" || (dispatch.status === "skipped" && "reason" in dispatch)) {
    console.warn(JSON.stringify(entry));
  } else console.log(JSON.stringify(entry));
}

/**
 * Retention cleanup and the daily verification dispatch are independent, so both are attempted
 * even when one fails — but the first failure is still rethrown so the cron is reported as failed.
 */
async function runDailyMaintenance(env: Env) {
  const [retention, catalog] = await Promise.allSettled([
    runRetentionCleanup(env),
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
  if (catalog.status === "rejected") {
    console.error(
      JSON.stringify({
        event: "knowledge_catalog_daily_dispatch_failed",
        message: errorMessage(catalog.reason),
      }),
    );
  }
  if (retention.status === "rejected") throw retention.reason;
  if (catalog.status === "rejected") throw catalog.reason;
  return { retention: retention.value, catalog: catalog.value };
}

export async function runScheduled(cron: string, env: Env) {
  if (cron === DAILY_MAINTENANCE_CRON) return runDailyMaintenance(env);
  if (cron === KNOWLEDGE_CATALOG_MONTHLY_CRON) return dispatchKnowledgeCatalogMonthlyRecheck(env);
  const dedicated = shopForCron(cron);
  const dispatch = dedicated
    ? await dispatchScheduledCrawl(env, dedicated.key)
    : await dispatchDueCrawls(env, { excludeShopKeys: sharedSweepExclusions() });
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

  const [state, queue] = await Promise.all([
    knowledgeCatalogVerifierState(env.DB),
    knowledgeCatalogVerificationQueueStatus(env.DB),
  ]);
  if (queue.latestRunId) {
    return { status: "skipped", reason: "knowledge_catalog_queue_already_bootstrapped" };
  }

  // A rollout that claimed the version but never finished keeps its version; anything else
  // bootstraps at 0 so the run is treated as a plain first fill rather than a rollout.
  const verifierVersion =
    state?.version === KNOWLEDGE_CATALOG_VERIFIER_VERSION && state.status !== "success"
      ? KNOWLEDGE_CATALOG_VERIFIER_VERSION
      : 0;
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
 * Crawl dispatch, catalog verification rollout, and data-quality replay are independent bounded
 * tasks. Remediation shares the five-minute trigger but never performs a recrawl.
 */
export function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): void {
  ctx.waitUntil(runScheduled(controller.cron, env));
  if (controller.cron === GENERAL_CRON) {
    ctx.waitUntil(bootstrapKnowledgeCatalogReview(env));
    ctx.waitUntil(runDataQualityRemediationSweep(env.DB));
  }
}
