import { getCrawlerSettings, getShopRequestDelayMs } from "../config.js";
import { getCrawlFetchDetailPage } from "../db/crawl-fetch-detail-repository.js";
import {
  claimCrawlFetchFinalization,
  completeCrawlFetchSession,
  failCrawlFetchSession,
  firstCrawlFetchPageKey,
  getCrawlFetchSession,
  type CrawlFetchSessionRow,
} from "../db/crawl-fetch-session-repository.js";
import {
  loadStagedCrawlProducts,
  setPublishedCrawlPageCount,
} from "../db/crawl-fetch-page-repository.js";
import { syncProductSearchEntities } from "../db/product-search-entity-repository.js";
import { accountReads, dbUsageMetrics, sumDbUsageMetrics } from "../db/read-accounting.js";
import type { QueryableDatabase } from "../db/types.js";
import { errorMessage } from "../types.js";
import { recheckShopInventory } from "./inventory-recheck.js";
import {
  type ResumableCrawlConsumeOptions,
  type ResumableCrawlConsumeResult,
  type ResumableRuntimeEnv,
  workerVersion,
} from "./resumable-queue-contract.js";
import { crawlShop } from "./run.js";
import { createTransport } from "./transport.js";
import type { CrawlResult, FetchHtmlPageOptions, HtmlTransport, ShopPlugin } from "./types.js";

const FINALIZE_RECLAIM_MS = 2 * 60_000;

/**
 * The pinned enrichment instant, when the caller supplied one that is actually a time.
 *
 * The value crosses a queue message, so an unparseable one is possible; letting it through would
 * reach `toISOString()` inside enrichment and fail the crawl over a field that only exists to make
 * two clocks agree. Falling back to the crawl's own clock restores exactly the behaviour this
 * refines, which is a far smaller loss than the run.
 */
function pinnedEnrichmentInstant(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function stagedFetchFunction(
  env: ResumableRuntimeEnv,
  detailDb: QueryableDatabase,
  plugin: ShopPlugin,
  runId: string,
  syntheticUrl: string,
  originalTransport: HtmlTransport,
  requireStagedDetailFetches: boolean,
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

    if (plugin.capabilities.detailCategoryEvidence) {
      const staged = await getCrawlFetchDetailPage(detailDb, runId, url);
      if (staged?.error_message) throw new Error(staged.error_message);
      if (staged?.html_text != null) {
        return new Response(staged.html_text, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (requireStagedDetailFetches) {
        throw new Error(`category detail fetch was not paced by CrawlScheduler: ${url}`);
      }
    }

    const html = await originalTransport.fetchHtmlPage(url, originalOptions);
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
}

export async function processFinalize(
  env: ResumableRuntimeEnv,
  plugin: ShopPlugin,
  session: CrawlFetchSessionRow,
  options: ResumableCrawlConsumeOptions,
): Promise<ResumableCrawlConsumeResult> {
  const claimedAtDate = new Date();
  const claimedAt = claimedAtDate.toISOString();
  const staleBefore = new Date(claimedAtDate.getTime() - FINALIZE_RECLAIM_MS).toISOString();
  const claimed = await claimCrawlFetchFinalization(env.DB, session.run_id, claimedAt, staleBefore);
  if (!claimed) {
    const refreshed = await getCrawlFetchSession(env.DB, session.run_id);
    if (refreshed?.status === "completed") {
      return {
        kind: "terminal",
        runId: session.run_id,
        result: { status: "skipped", reason: "stale_dispatch", shopKey: plugin.key },
      };
    }
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
  const stagedAccounting = accountReads(env.DB);
  const products = await loadStagedCrawlProducts(stagedAccounting.db, session.run_id);
  const seedAccounting = accountReads(env.DB);
  const seedUrl =
    (await firstCrawlFetchPageKey(seedAccounting.db, session.run_id)) || `${plugin.baseUrl}/`;
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
    parseWithStages: () => ({ products, rawParseMs: 0, normalizeMs: 0 }),
  };

  const originalTransport = createTransport(
    env,
    plugin.capabilities.transport?.kind,
    globalThis.fetch,
  );
  // The instant the Durable Object planned this run's detail fetches. Enrichment alone is pinned to
  // it -- the crawl's own clock stays current -- so the eligibility policy cannot drift between
  // planning and finalization while the paced fetches run.
  const enrichmentDecidedAt = pinnedEnrichmentInstant(options.detailDecisionAt);
  const detailReplayAccounting = accountReads(env.DB);
  try {
    const result = await crawlShop(env, publishAdapter, {
      force: true,
      ...(enrichmentDecidedAt ? { enrichmentDecidedAt } : {}),
      fetchFn: stagedFetchFunction(
        env,
        detailReplayAccounting.db,
        plugin,
        session.run_id,
        syntheticUrl,
        originalTransport,
        options.requireStagedDetailFetches === true,
      ),
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
      if (result.crawlRunId != null) {
        await setPublishedCrawlPageCount(env.DB, result.crawlRunId, claimedSession.pages_parsed);
      }
      await failCrawlFetchSession(env.DB, {
        runId: session.run_id,
        failedAt: finishedAt,
        message: result.error,
        crawlRunId: result.crawlRunId,
      });
    }
    return { kind: "terminal", runId: session.run_id, result };
  } finally {
    const finalizationDbUsage = sumDbUsageMetrics(
      dbUsageMetrics(stagedAccounting),
      dbUsageMetrics(seedAccounting),
      dbUsageMetrics(detailReplayAccounting),
    );
    console.log(
      JSON.stringify({
        event: "crawl_finalization_db_usage",
        shopKey: plugin.key,
        runId: session.run_id,
        stagedCount: products.length,
        stagedRowsRead: stagedAccounting.rowsRead(),
        seedRowsRead: seedAccounting.rowsRead(),
        detailEvidenceRowsRead: detailReplayAccounting.rowsRead(),
        ...finalizationDbUsage,
      }),
    );
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
