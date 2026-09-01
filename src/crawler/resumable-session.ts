import { getCrawlerSettings, getShopIntervalMinutes, getShopMaxPages } from "../config.js";
import {
  ensureCrawlFetchSession,
  failCrawlFetchSession,
  getCrawlFetchSession,
  type CrawlFetchPageInput,
  type CrawlFetchSessionRow,
} from "../db/crawl-fetch-session-repository.js";
import { getShopState, markShopFailure } from "../db/shop-state-repository.js";
import { errorMessage } from "../types.js";
import {
  canonicalRunId,
  continuationFromSession,
  workerVersion,
  type ResumableCrawlConsumeOptions,
  type ResumableCrawlConsumeResult,
  type ResumableCrawlQueueMessage,
  type ResumableRuntimeEnv,
} from "./resumable-queue-contract.js";
import { initialPageQueue, targetUrl } from "./strategies.js";
import type { CrawlPage, ShopPlugin } from "./types.js";

function buildContinuationMessage(
  plugin: ShopPlugin,
  source: ResumableCrawlQueueMessage,
  session: CrawlFetchSessionRow,
): ResumableCrawlQueueMessage {
  const continuation = continuationFromSession(session);
  if (!continuation) throw new Error(`active crawl session has no continuation: ${session.run_id}`);
  return {
    ...source,
    shopKey: plugin.key,
    requestedAt: session.requested_at,
    jobId: source.jobId || canonicalRunId(plugin.key, session.requested_at),
    lane: undefined,
    collectionRunId: session.run_id,
    continuation,
  };
}

function pageInputs(plugin: ShopPlugin, pages: readonly CrawlPage[]): CrawlFetchPageInput[] {
  return pages.map((page, ordinal) => ({ key: targetUrl(plugin, page), page, ordinal }));
}

export async function ensureSession(
  env: ResumableRuntimeEnv,
  plugin: ShopPlugin,
  body: ResumableCrawlQueueMessage,
  runId: string,
): Promise<CrawlFetchSessionRow> {
  const existing = await getCrawlFetchSession(env.DB, runId);
  if (existing) return existing;
  const settings = getCrawlerSettings(env);
  const state = await getShopState(env.DB, plugin.key);
  const intervalMinutes = getShopIntervalMinutes(env, plugin.definition);
  const maxPages = getShopMaxPages(env, plugin.definition, settings.maxPagesPerShop);
  const pageLimit = maxPages + plugin.discovery.policy.extraPageBudget;
  const now = new Date(body.requestedAt);
  const initial = initialPageQueue(plugin, maxPages, env, { now, intervalMinutes, state });
  const createdAt = new Date().toISOString();
  const result = await ensureCrawlFetchSession(env.DB, {
    runId,
    shopKey: plugin.key,
    requestedAt: body.requestedAt,
    maxPages,
    pageLimit,
    pages: pageInputs(plugin, initial),
    createdAt,
  });
  if (result.created) {
    console.log(
      JSON.stringify({
        event: "crawl_fetch_session_started",
        shopKey: plugin.key,
        runId,
        requestedAt: body.requestedAt,
        pageLimit,
        initialPages: initial.length,
        workerVersion: workerVersion(env),
      }),
    );
  }
  return result.session;
}

export async function failCollection(
  env: ResumableRuntimeEnv,
  plugin: ShopPlugin,
  runId: string,
  error: unknown,
): Promise<ResumableCrawlConsumeResult> {
  const failedAt = new Date().toISOString();
  const message = errorMessage(error);
  const state = await getShopState(env.DB, plugin.key);
  await markShopFailure(env.DB, plugin.key, failedAt, message, state?.consecutive_failures || 0);
  await failCrawlFetchSession(env.DB, { runId, failedAt, message });
  console.warn(
    JSON.stringify({
      event: "crawl_fetch_collection_failed",
      shopKey: plugin.key,
      runId,
      message,
      workerVersion: workerVersion(env),
    }),
  );
  return {
    kind: "terminal",
    runId,
    result: {
      status: "failed",
      shopKey: plugin.key,
      crawlRunId: null,
      error: message,
      dataQuality: null,
    },
  };
}

export async function continued(
  env: ResumableRuntimeEnv,
  plugin: ShopPlugin,
  body: ResumableCrawlQueueMessage,
  runId: string,
  options: ResumableCrawlConsumeOptions,
): Promise<ResumableCrawlConsumeResult> {
  void options;
  const session = await getCrawlFetchSession(env.DB, runId);
  if (!session) throw new Error(`crawl fetch session disappeared: ${runId}`);
  const continuationMessage = buildContinuationMessage(plugin, body, session);
  return {
    kind: "continued",
    shopKey: plugin.key,
    runId,
    sequence: session.continuation_sequence,
    phase: session.next_phase || "finalize",
    pageKey: session.next_page_key,
    continuationMessage,
  };
}
