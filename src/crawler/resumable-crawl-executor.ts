import { getCrawlFetchSession } from "../db/crawl-fetch-session-repository.js";
import {
  crawlDispatchToken,
  getShopState,
  releaseShopDispatch,
} from "../db/shop-state-repository.js";
import type { CrawlDispatchStateRow } from "./crawl-lifecycle.js";
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

async function executeContinuation(
  env: ResumableRuntimeEnv,
  plugin: ShopPlugin,
  body: ResumableCrawlQueueMessage,
  runId: string,
  options: ResumableCrawlConsumeOptions,
): Promise<ResumableCrawlConsumeResult> {
  let session = await ensureSession(env, plugin, body, runId, options);
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

/**
 * Executes one bounded crawl transition for the owning per-shop Durable Object.
 *
 * Durable Object serialization is the single-flight authority. D1 keeps only a stable dispatch
 * generation token so delayed/replayed `/start-crawl` deliveries cannot execute a newer generation.
 */
export async function executeResumableCrawlStep(
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
  const dispatchToken = body.jobId || crawlDispatchToken(plugin.key, body.requestedAt);
  const state = (await getShopState(env.DB, plugin.key)) as CrawlDispatchStateRow | null;
  if (
    state?.dispatch_requested_at !== body.requestedAt ||
    state?.dispatch_token !== dispatchToken
  ) {
    return {
      kind: "terminal",
      runId,
      result: { status: "skipped", reason: "stale_dispatch", shopKey: plugin.key },
    };
  }

  if (!isTransportConfigured(env, plugin.capabilities.transport?.kind)) {
    await releaseShopDispatch(env.DB, plugin.key, dispatchToken);
    return {
      kind: "terminal",
      runId,
      result: { status: "skipped", reason: "configuration_missing", shopKey: plugin.key },
    };
  }

  const result = await executeContinuation(env, plugin, body, runId, options);
  if (result.kind === "terminal") {
    await releaseShopDispatch(env.DB, plugin.key, dispatchToken);
  }
  return result;
}
