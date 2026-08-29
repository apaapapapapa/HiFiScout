import {
  getCrawlerSettings,
  getShopIntervalMinutes,
  getShopMaxPages,
  getShopRequestDelayMs,
} from "../config.js";
import {
  completeCrawlFetchSession,
  decodeCrawlFetchPage,
  ensureCrawlFetchSession,
  failCrawlFetchSession,
  getCrawlFetchPage,
  getCrawlFetchSession,
  listCrawlFetchPages,
  claimCrawlFetchFinalization,
  type CrawlFetchContinuationPhase,
  type CrawlFetchPageInput,
  type CrawlFetchSessionRow,
} from "../db/crawl-fetch-session-repository.js";
import {
  loadStagedCrawlProducts,
  nextPendingPageKey,
  recordCrawlFetchPageFetched,
  recordCrawlFetchPageIgnored,
  recordCrawlFetchPageParsed,
  setPublishedCrawlPageCount,
  stagedCrawlFetchItemCount,
} from "../db/crawl-fetch-page-repository.js";
import { syncProductSearchEntities } from "../db/product-search-entity-repository.js";
import {
  crawlDispatchToken,
  getShopState,
  markShopFailure,
  releaseShopCrawl,
  tryClaimShopCrawl,
} from "../db/shop-state-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import { errorMessage } from "../types.js";
import {
  matchesDispatchReservation,
  retryAfterExecutionLeaseSeconds,
  type CrawlLifecycleRow,
} from "./crawl-lifecycle.js";
import { recheckShopInventory } from "./inventory-recheck.js";
import { crawlQueueLane } from "./queue-lanes.js";
import { crawlShop } from "./run.js";
import { getShopPlugin } from "./shops/index.js";
import {
  discoverPages,
  initialPageQueue,
  shouldContinueAfterEmpty,
  targetUrl,
} from "./strategies.js";
import { createTransport, isTransportConfigured } from "./transport.js";
import type {
  CrawlPage,
  CrawlQueueLane,
  CrawlQueueMessage,
  CrawlResult,
  CrawlerEnv,
  FetchHtmlPageOptions,
  HtmlTransport,
  RobotsCache,
  ShopPlugin,
} from "./types.js";

type RuntimeEnv = CrawlerEnv & { DB: QueryableDatabase };

interface CrawlContinuationDescriptor {
  sequence: number;
  phase: CrawlFetchContinuationPhase;
  pageKey?: string;
}

export interface ResumableCrawlQueueMessage extends CrawlQueueMessage {
  collectionRunId?: string;
  continuation?: CrawlContinuationDescriptor;
}

export type ResumableCrawlConsumeResult =
  | {
      kind: "retry";
      shopKey: string;
      runId?: string;
      reason: "crawl_in_progress" | "continuation_ahead" | "finalization_in_progress";
      retryAfterSeconds: number;
    }
  | {
      kind: "continued";
      shopKey: string;
      runId: string;
      sequence: number;
      phase: CrawlFetchContinuationPhase;
      pageKey: string | null;
    }
  | { kind: "terminal"; runId?: string; result: CrawlResult };

const EXECUTION_LEASE_MINUTES = 1;
const LEASE_RETRY_SAFETY_SECONDS = 5;
const FINALIZE_RECLAIM_MS = 2 * 60_000;

function workerVersion(env: CrawlerEnv): string | null {
  const metadata = (env as CrawlerEnv & { CF_VERSION_METADATA?: { id?: string } })
    .CF_VERSION_METADATA;
  return metadata?.id || null;
}

function queueForLane(
  env: CrawlerEnv,
  lane: CrawlQueueLane,
): Pick<Queue<CrawlQueueMessage>, "send"> | null {
  const queue =
    lane === "fast"
      ? env.CRAWL_FAST_QUEUE
      : lane === "heavy"
        ? env.CRAWL_HEAVY_QUEUE
        : env.CRAWL_RELAY_QUEUE;
  return queue || env.CRAWL_QUEUE || null;
}

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

function canonicalRunId(shopKey: string, requestedAt: string): string {
  return crawlDispatchToken(shopKey, requestedAt);
}

function continuationFromSession(
  session: CrawlFetchSessionRow,
): CrawlContinuationDescriptor | null {
  if (!session.next_phase) return null;
  return {
    sequence: session.continuation_sequence,
    phase: session.next_phase,
    ...(session.next_page_key ? { pageKey: session.next_page_key } : {}),
  };
}

async function sendContinuation(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  source: ResumableCrawlQueueMessage,
  session: CrawlFetchSessionRow,
): Promise<void> {
  const continuation = continuationFromSession(session);
  if (!continuation) return;
  const lane = source.lane || crawlQueueLane(plugin);
  const queue = queueForLane(env, lane);
  if (!queue) throw new Error(`crawl queue binding is not configured for ${plugin.key}`);
  const message: ResumableCrawlQueueMessage = {
    ...source,
    shopKey: plugin.key,
    requestedAt: session.requested_at,
    jobId: source.jobId || canonicalRunId(plugin.key, session.requested_at),
    lane,
    collectionRunId: session.run_id,
    continuation,
  };
  await queue.send(message);
  console.log(
    JSON.stringify({
      event: "crawl_fetch_continuation_enqueued",
      shopKey: plugin.key,
      runId: session.run_id,
      sequence: continuation.sequence,
      phase: continuation.phase,
      pageKey: continuation.pageKey || null,
      lane,
      workerVersion: workerVersion(env),
    }),
  );
}

function pageInputs(plugin: ShopPlugin, pages: readonly CrawlPage[]): CrawlFetchPageInput[] {
  return pages.map((page, ordinal) => ({ key: targetUrl(plugin, page), page, ordinal }));
}

async function ensureSession(
  env: RuntimeEnv,
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

async function failCollection(
  env: RuntimeEnv,
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

async function continued(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  body: ResumableCrawlQueueMessage,
  runId: string,
): Promise<ResumableCrawlConsumeResult> {
  const session = await getCrawlFetchSession(env.DB, runId);
  if (!session) throw new Error(`crawl fetch session disappeared: ${runId}`);
  await sendContinuation(env, plugin, body, session);
  return {
    kind: "continued",
    shopKey: plugin.key,
    runId,
    sequence: session.continuation_sequence,
    phase: session.next_phase || "finalize",
    pageKey: session.next_page_key,
  };
}

async function processFetch(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  session: CrawlFetchSessionRow,
  body: ResumableCrawlQueueMessage,
): Promise<ResumableCrawlConsumeResult> {
  const pageKey = session.next_page_key;
  if (!pageKey) throw new Error(`fetch continuation has no page: ${session.run_id}`);
  const row = await getCrawlFetchPage(env.DB, session.run_id, pageKey);
  if (!row) throw new Error(`crawl frontier page not found: ${pageKey}`);
  if (row.state !== "pending") return continued(env, plugin, body, session.run_id);

  const settings = getCrawlerSettings(env);
  const requestDelayMs = getShopRequestDelayMs(env, plugin.definition, settings.requestDelayMs);
  const transport = createTransport(env, plugin.capabilities.transport?.kind, globalThis.fetch);
  const robotsCache: RobotsCache = new Map();
  const startedAtMs = Date.now();
  try {
    let html: string;
    try {
      html = await transport.fetchHtmlPage(pageKey, {
        baseUrl: plugin.baseUrl,
        userAgent: settings.userAgent,
        requestDelayMs,
        fetchFn: globalThis.fetch,
        robotsCache,
      });
    } catch (error) {
      if (/HTTP 404/.test(errorMessage(error)) && shouldContinueAfterEmpty(plugin)) {
        const pages = await listCrawlFetchPages(env.DB, session.run_id);
        await recordCrawlFetchPageIgnored(env.DB, {
          runId: session.run_id,
          pageKey,
          ignoredAt: new Date().toISOString(),
          currentSequence: session.continuation_sequence,
          nextPageKey: nextPendingPageKey(pages, pageKey),
        });
        return continued(env, plugin, body, session.run_id);
      }
      return failCollection(env, plugin, session.run_id, error);
    }

    const fetchedAt = new Date().toISOString();
    const htmlBytes = new TextEncoder().encode(html).byteLength;
    await recordCrawlFetchPageFetched(env.DB, {
      runId: session.run_id,
      pageKey,
      html,
      htmlBytes,
      fetchedAt,
      currentSequence: session.continuation_sequence,
    });
    console.log(
      JSON.stringify({
        event: "crawl_fetch_page_fetched",
        shopKey: plugin.key,
        runId: session.run_id,
        page: row.ordinal,
        pageKey,
        htmlBytes,
        durationMs: Date.now() - startedAtMs,
        workerVersion: workerVersion(env),
      }),
    );
  } finally {
    await transport.close?.().catch((error: unknown) =>
      console.warn(
        JSON.stringify({
          event: "crawl_fetch_transport_close_failed",
          shopKey: plugin.key,
          runId: session.run_id,
          message: errorMessage(error),
        }),
      ),
    );
  }
  return continued(env, plugin, body, session.run_id);
}

async function processParse(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  session: CrawlFetchSessionRow,
  body: ResumableCrawlQueueMessage,
): Promise<ResumableCrawlConsumeResult> {
  const pageKey = session.next_page_key;
  if (!pageKey) throw new Error(`parse continuation has no page: ${session.run_id}`);
  const row = await getCrawlFetchPage(env.DB, session.run_id, pageKey);
  if (!row) throw new Error(`crawl frontier page not found: ${pageKey}`);
  if (row.state !== "fetched" || row.html_text == null)
    return continued(env, plugin, body, session.run_id);

  const page = decodeCrawlFetchPage(row);
  const parseStartedAt = performance.now();
  let products;
  try {
    products = plugin.parse(row.html_text, page);
  } catch (error) {
    return failCollection(env, plugin, session.run_id, error);
  }
  const parseMs = performance.now() - parseStartedAt;
  const discovered = discoverPages(plugin, row.html_text, page);
  const pages = await listCrawlFetchPages(env.DB, session.run_id);
  const known = new Set(pages.map((candidate) => candidate.page_key));
  const accepted: CrawlFetchPageInput[] = [];
  let coverageIncomplete = discovered == null;
  let nextOrdinal = pages.reduce((max, candidate) => Math.max(max, candidate.ordinal), -1) + 1;

  if (discovered) {
    for (const candidate of discovered) {
      const key = targetUrl(plugin, candidate);
      if (known.has(key)) continue;
      if (known.size >= session.page_limit) {
        coverageIncomplete = true;
        continue;
      }
      known.add(key);
      accepted.push({ key, page: candidate, ordinal: nextOrdinal++ });
    }
  }

  const previousItems = await stagedCrawlFetchItemCount(env.DB, session.run_id);
  if (!products.length && plugin.discovery.discoverTargets) coverageIncomplete = true;
  const reachedEnd =
    products.length === 0 && previousItems > 0 && !shouldContinueAfterEmpty(plugin);
  let nextPageKey = nextPendingPageKey(pages, pageKey) || accepted[0]?.key || null;
  if (reachedEnd && nextPageKey) coverageIncomplete = true;
  if (reachedEnd) nextPageKey = null;

  await recordCrawlFetchPageParsed(env.DB, {
    runId: session.run_id,
    pageKey,
    products,
    discoveredPages: accepted,
    parsedAt: new Date().toISOString(),
    currentSequence: session.continuation_sequence,
    nextPageKey,
    coverageIncomplete,
    reachedEnd,
  });
  console.log(
    JSON.stringify({
      event: "crawl_fetch_page_parsed",
      shopKey: plugin.key,
      runId: session.run_id,
      page: row.ordinal,
      pageKey,
      htmlBytes: row.html_bytes,
      itemCount: products.length,
      parseMs,
      discoveredCount: accepted.length,
      coverageIncomplete,
      reachedEnd,
      workerVersion: workerVersion(env),
    }),
  );
  return continued(env, plugin, body, session.run_id);
}

function stagedFetchFunction(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  syntheticUrl: string,
  originalTransport: HtmlTransport,
): typeof fetch {
  const settings = getCrawlerSettings(env);
  const originalOptions: FetchHtmlPageOptions = {
    baseUrl: plugin.baseUrl,
    userAgent: settings.userAgent,
    requestDelayMs: getShopRequestDelayMs(env, plugin.definition, settings.requestDelayMs),
    fetchFn: globalThis.fetch,
    robotsCache: new Map(),
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === syntheticUrl) {
      return new Response("<!doctype html><title>staged crawl</title>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (new URL(url).pathname === "/robots.txt") return globalThis.fetch(input, init);
    const html = await originalTransport.fetchHtmlPage(url, originalOptions);
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
}

async function processFinalize(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  session: CrawlFetchSessionRow,
): Promise<ResumableCrawlConsumeResult> {
  const claimedAtDate = new Date();
  const claimedAt = claimedAtDate.toISOString();
  const staleBefore = new Date(claimedAtDate.getTime() - FINALIZE_RECLAIM_MS).toISOString();
  const claimed = await claimCrawlFetchFinalization(env.DB, session.run_id, claimedAt, staleBefore);
  if (!claimed) {
    const refreshed = await getCrawlFetchSession(env.DB, session.run_id);
    if (refreshed?.status === "completed")
      return {
        kind: "terminal",
        runId: session.run_id,
        result: { status: "skipped", reason: "stale_dispatch", shopKey: plugin.key },
      };
    if (refreshed?.status === "failed") {
      return {
        kind: "terminal",
        runId: session.run_id,
        result: {
          status: "failed",
          shopKey: plugin.key,
          crawlRunId: refreshed.final_crawl_run_id,
          error: refreshed.error_message || "crawl collection failed",
          dataQuality: null,
        },
      };
    }
    return {
      kind: "retry",
      shopKey: plugin.key,
      runId: session.run_id,
      reason: "finalization_in_progress",
      retryAfterSeconds: 60,
    };
  }

  const claimedSession = await getCrawlFetchSession(env.DB, session.run_id);
  if (!claimedSession) throw new Error(`crawl fetch session disappeared: ${session.run_id}`);
  const products = await loadStagedCrawlProducts(env.DB, session.run_id);
  const pages = await listCrawlFetchPages(env.DB, session.run_id);
  const seedUrl = pages[0]?.page_key || `${plugin.baseUrl}/`;
  const synthetic = new URL(seedUrl);
  synthetic.searchParams.set("__hifiscout_staged_run", session.run_id);
  const syntheticUrl = synthetic.toString();
  const {
    transport: ignoredTransport,
    diagnostics: ignoredDiagnostics,
    ...safeCapabilities
  } = plugin.capabilities;
  void ignoredTransport;
  void ignoredDiagnostics;
  const publishAdapter: ShopPlugin = {
    ...plugin,
    capabilities: { ...safeCapabilities, transport: { kind: "direct" } },
    discovery: {
      coverage: claimedSession.coverage_incomplete ? "partial" : plugin.discovery.coverage,
      policy: { ...plugin.discovery.policy, extraPageBudget: 0 },
      initialTargets: () => [syntheticUrl],
    },
    parse: () => products,
  };

  const originalTransport = createTransport(
    env,
    plugin.capabilities.transport?.kind,
    globalThis.fetch,
  );
  try {
    const result = await crawlShop(env, publishAdapter, {
      force: true,
      fetchFn: stagedFetchFunction(env, plugin, syntheticUrl, originalTransport),
    });
    const finishedAt = new Date().toISOString();
    if (result.status === "success") {
      await setPublishedCrawlPageCount(env.DB, result.crawlRunId, claimedSession.pages_parsed);
      let finalResult: CrawlResult = { ...result, pageCount: claimedSession.pages_parsed };
      if (plugin.capabilities.inventoryRecheck) {
        const inventoryRecheck = await recheckShopInventory(env, plugin);
        if (inventoryRecheck.status === "checked" && inventoryRecheck.sourceId) {
          await syncProductSearchEntities(env.DB, plugin.key, [inventoryRecheck.sourceId]);
        }
        finalResult = { ...finalResult, inventoryRecheck };
      }
      await completeCrawlFetchSession(env.DB, {
        runId: session.run_id,
        finalizedAt: finishedAt,
        crawlRunId: result.crawlRunId,
      });
      console.log(
        JSON.stringify({
          event: "crawl_fetch_session_published",
          shopKey: plugin.key,
          runId: session.run_id,
          crawlRunId: result.crawlRunId,
          pageCount: claimedSession.pages_parsed,
          itemCount: result.itemCount,
          coverageIncomplete: Boolean(claimedSession.coverage_incomplete),
          lastCompletedPage: claimedSession.last_completed_page,
          workerVersion: workerVersion(env),
        }),
      );
      return { kind: "terminal", runId: session.run_id, result: finalResult };
    }

    if (result.status === "failed") {
      if (result.crawlRunId != null)
        await setPublishedCrawlPageCount(env.DB, result.crawlRunId, claimedSession.pages_parsed);
      await failCrawlFetchSession(env.DB, {
        runId: session.run_id,
        failedAt: finishedAt,
        message: result.error,
        crawlRunId: result.crawlRunId,
      });
    }
    return { kind: "terminal", runId: session.run_id, result };
  } finally {
    await originalTransport.close?.().catch((error: unknown) =>
      console.warn(
        JSON.stringify({
          event: "crawl_finalize_transport_close_failed",
          shopKey: plugin.key,
          runId: session.run_id,
          message: errorMessage(error),
        }),
      ),
    );
  }
}

async function executeContinuation(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  body: ResumableCrawlQueueMessage,
  runId: string,
): Promise<ResumableCrawlConsumeResult> {
  let session = await ensureSession(env, plugin, body, runId);
  if (session.status === "completed")
    return {
      kind: "terminal",
      runId,
      result: { status: "skipped", reason: "stale_dispatch", shopKey: plugin.key },
    };
  if (session.status === "failed")
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

  const deliveredSequence = body.continuation?.sequence ?? 0;
  if (deliveredSequence > session.continuation_sequence)
    return {
      kind: "retry",
      shopKey: plugin.key,
      runId,
      reason: "continuation_ahead",
      retryAfterSeconds: 5,
    };
  if (deliveredSequence < session.continuation_sequence) return continued(env, plugin, body, runId);

  const canonical = continuationFromSession(session);
  if (!canonical) throw new Error(`active crawl session has no continuation: ${runId}`);
  if (
    body.continuation &&
    (body.continuation.phase !== canonical.phase ||
      (body.continuation.pageKey || null) !== (canonical.pageKey || null))
  ) {
    return continued(env, plugin, body, runId);
  }

  if (canonical.phase === "fetch") return processFetch(env, plugin, session, body);
  if (canonical.phase === "parse") return processParse(env, plugin, session, body);
  session = (await getCrawlFetchSession(env.DB, runId)) || session;
  return processFinalize(env, plugin, session);
}

export async function consumeResumableCrawlMessage(
  env: RuntimeEnv,
  body: ResumableCrawlQueueMessage,
): Promise<ResumableCrawlConsumeResult> {
  const plugin = getShopPlugin(body.shopKey);
  if (!plugin)
    return {
      kind: "terminal",
      result: { status: "skipped", reason: "unknown_shop", shopKey: body.shopKey },
    };
  if (!body.requestedAt)
    return {
      kind: "terminal",
      result: { status: "skipped", reason: "not_due", shopKey: plugin.key },
    };
  if (!isTransportConfigured(env, plugin.capabilities.transport?.kind))
    return {
      kind: "terminal",
      result: { status: "skipped", reason: "configuration_missing", shopKey: plugin.key },
    };

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
    if (retryAfterSeconds != null)
      return {
        kind: "retry",
        shopKey: plugin.key,
        runId,
        reason: "crawl_in_progress",
        retryAfterSeconds,
      };
    return {
      kind: "terminal",
      runId,
      result: { status: "skipped", reason: "stale_dispatch", shopKey: plugin.key },
    };
  }

  let terminal = false;
  try {
    const result = await executeContinuation(env, plugin, body, runId);
    terminal = result.kind === "terminal";
    return result;
  } finally {
    if (terminal) await releaseShopCrawl(env.DB, plugin.key, crawlLeaseToken, body.requestedAt);
    else await releaseExecutionLease(env.DB, plugin.key, crawlLeaseToken);
  }
}
