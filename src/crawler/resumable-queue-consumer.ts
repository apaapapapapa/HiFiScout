import { getCrawlFetchSession } from "../db/crawl-fetch-session-repository.js";
import {
  getShopState,
  releaseShopCrawl,
  tryClaimShopCrawl,
} from "../db/shop-state-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import {
  matchesDispatchReservation,
  retryAfterExecutionLeaseSeconds,
  type CrawlLifecycleRow,
} from "./crawl-lifecycle.js";
import { processFinalize } from "./resumable-finalize.js";
import { processFetch, processParse } from "./resumable-page-steps.js";
import {
  canonicalRunId,
  continuationFromSession,
  type ResumableCrawlConsumeOptions,
  type ResumableCrawlConsumeResult,
  type ResumableCrawlQueueMessage,
  type ResumableRuntimeEnv,
} from "./resumable-queue-contract.js";
import { continued, ensureSession } from "./resumable-session.js";
import { getShopPlugin } from "./shops/index.js";
import { isTransportConfigured } from "./transport.js";
import type { ShopPlugin } from "./types.js";

export type {
  CrawlContinuationDescriptor,
  ResumableCrawlConsumeOptions,
  ResumableCrawlConsumeResult,
  ResumableCrawlQueueMessage,
} from "./resumable-queue-contract.js";

const EXECUTION_LEASE_MINUTES = 1;
const LEASE_RETRY_SAFETY_SECONDS = 5;

async function releaseExecutionLease(
  db: QueryableDatabase,
  shopKey: string,
  crawlLeaseToken: string,
): Promise<void> {
  await db
    .prepare(`
    UPDATE shop_sync_state SET crawl_lease_token = NULL, crawl_lease_until = NULL
    WHERE shop_key = ? AND crawl_lease_token = ?
  `)
    .bind(shopKey, crawlLeaseToken)
    .run();
}

async function executeContinuation(
  env: ResumableRuntimeEnv,
  plugin: ShopPlugin,
  body: ResumableCrawlQueueMessage,
  runId: string,
  options: ResumableCrawlConsumeOptions,
): Promise<ResumableCrawlConsumeResult> {
  let session = await ensureSession(env, plugin, body, runId);
  if (session.status === "completed") {
    return {
      kind: "terminal",
      runId,
      result: { status: "skipped", reason: "stale_dispatch", shopKey: plugin.key },
    };
  }
  if (session.status === "failed") {
    return {
      kind: "terminal",
      runId,
      result: {
        status: "failed",
        shopKey: plugin.key,
        crawlRunId: session.final_crawl_run_id,
        error: session.error_message || "crawl collection failed",
        dataQuality: null,
      },
    };
  }

  if (options.initializeOnly && !body.continuation) {
    return continued(env, plugin, body, runId, options);
  }

  const deliveredSequence = body.continuation?.sequence ?? 0;
  if (deliveredSequence > session.continuation_sequence) {
    return {
      kind: "retry",
      shopKey: plugin.key,
      runId,
      reason: "continuation_ahead",
      retryAfterSeconds: 5,
    };
  }
  if (deliveredSequence < session.continuation_sequence) {
    return continued(env, plugin, body, runId, options);
  }

  const canonical = continuationFromSession(session);
  if (!canonical) throw new Error(`active crawl session has no continuation: ${runId}`);
  if (
    body.continuation &&
    (body.continuation.phase !== canonical.phase ||
      (body.continuation.pageKey || null) !== (canonical.pageKey || null))
  ) {
    return continued(env, plugin, body, runId, options);
  }

  if (canonical.phase === "fetch") return processFetch(env, plugin, session, body, options);
  if (canonical.phase === "parse") return processParse(env, plugin, session, body, options);
  session = (await getCrawlFetchSession(env.DB, runId)) || session;
  return processFinalize(env, plugin, session, options);
}

export async function consumeResumableCrawlMessage(
  env: ResumableRuntimeEnv,
  body: ResumableCrawlQueueMessage,
  options: ResumableCrawlConsumeOptions = {},
): Promise<ResumableCrawlConsumeResult> {
  const plugin = getShopPlugin(body.shopKey);
  if (!plugin) {
    return {
      kind: "terminal",
      result: { status: "skipped", reason: "unknown_shop", shopKey: body.shopKey },
    };
  }
  if (!body.requestedAt) {
    return {
      kind: "terminal",
      result: { status: "skipped", reason: "not_due", shopKey: plugin.key },
    };
  }

  const runId = body.collectionRunId || canonicalRunId(plugin.key, body.requestedAt);
  const claimedAtDate = new Date();
  const claimedAt = claimedAtDate.toISOString();
  const crawlLeaseToken = await tryClaimShopCrawl(
    env.DB,
    plugin.key,
    body.requestedAt,
    claimedAt,
    EXECUTION_LEASE_MINUTES,
  );
  if (!crawlLeaseToken) {
    const state = (await getShopState(env.DB, plugin.key)) as CrawlLifecycleRow | null;
    const retryAfterSeconds = matchesDispatchReservation(state, plugin.key, body.requestedAt)
      ? retryAfterExecutionLeaseSeconds(state, claimedAtDate, LEASE_RETRY_SAFETY_SECONDS)
      : null;
    if (retryAfterSeconds != null) {
      return {
        kind: "retry",
        shopKey: plugin.key,
        runId,
        reason: "crawl_in_progress",
        retryAfterSeconds,
      };
    }
    return {
      kind: "terminal",
      runId,
      result: { status: "skipped", reason: "stale_dispatch", shopKey: plugin.key },
    };
  }

  let terminal = false;
  try {
    if (!isTransportConfigured(env, plugin.capabilities.transport?.kind)) {
      terminal = true;
      return {
        kind: "terminal",
        runId,
        result: { status: "skipped", reason: "configuration_missing", shopKey: plugin.key },
      };
    }
    const result = await executeContinuation(env, plugin, body, runId, options);
    terminal = result.kind === "terminal";
    return result;
  } finally {
    if (terminal) await releaseShopCrawl(env.DB, plugin.key, crawlLeaseToken, body.requestedAt);
    else await releaseExecutionLease(env.DB, plugin.key, crawlLeaseToken);
  }
}
