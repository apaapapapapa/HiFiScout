import { getCrawlerSettings, getShopRequestDelayMs } from "../config.js";
import {
  decodeCrawlFetchPage,
  getCrawlFetchPage,
  listCrawlFetchPages,
  type CrawlFetchPageInput,
  type CrawlFetchSessionRow,
} from "../db/crawl-fetch-session-repository.js";
import {
  nextPendingPageKey,
  recordCrawlFetchPageFetched,
  recordCrawlFetchPageIgnored,
  recordCrawlFetchPageParsed,
  stagedCrawlFetchItemCount,
} from "../db/crawl-fetch-page-repository.js";
import { errorMessage } from "../types.js";
import {
  type ResumableCrawlConsumeOptions,
  type ResumableCrawlConsumeResult,
  type ResumableCrawlQueueMessage,
  type ResumableRuntimeEnv,
  workerVersion,
} from "./resumable-queue-contract.js";
import { continued, failCollection } from "./resumable-session.js";
import { discoverPages, shouldContinueAfterEmpty, targetUrl } from "./strategies.js";
import { createTransport } from "./transport.js";
import type { FetchHtmlPageOptions, RobotsCache, ShopPlugin } from "./types.js";

export async function processFetch(
  env: ResumableRuntimeEnv,
  plugin: ShopPlugin,
  session: CrawlFetchSessionRow,
  body: ResumableCrawlQueueMessage,
  options: ResumableCrawlConsumeOptions,
): Promise<ResumableCrawlConsumeResult> {
  const pageKey = session.next_page_key;
  if (!pageKey) throw new Error(`fetch continuation has no page: ${session.run_id}`);
  const row = await getCrawlFetchPage(env.DB, session.run_id, pageKey);
  if (!row) throw new Error(`crawl frontier page not found: ${pageKey}`);
  if (row.state !== "pending") return continued(env, plugin, body, session.run_id, options);

  const settings = getCrawlerSettings(env);
  const requestDelayMs = getShopRequestDelayMs(env, plugin.definition, settings.requestDelayMs);
  const transport = options.fetchHtmlPage
    ? null
    : createTransport(env, plugin.capabilities.transport?.kind, globalThis.fetch);
  const robotsCache: RobotsCache = new Map();
  const fetchOptions: FetchHtmlPageOptions = {
    baseUrl: plugin.baseUrl,
    userAgent: settings.userAgent,
    requestDelayMs,
    fetchFn: globalThis.fetch,
    robotsCache,
  };
  const startedAtMs = Date.now();
  try {
    let html: string;
    try {
      html = options.fetchHtmlPage
        ? await options.fetchHtmlPage(pageKey, fetchOptions)
        : await transport!.fetchHtmlPage(pageKey, fetchOptions);
    } catch (error) {
      if (/HTTP 404/.test(errorMessage(error))) {
        const previousItems = await stagedCrawlFetchItemCount(env.DB, session.run_id);
        if (shouldContinueAfterEmpty(plugin) || previousItems === 0) {
          const pages = await listCrawlFetchPages(env.DB, session.run_id);
          await recordCrawlFetchPageIgnored(env.DB, {
            runId: session.run_id,
            pageKey,
            ignoredAt: new Date().toISOString(),
            currentSequence: session.continuation_sequence,
            nextPageKey: nextPendingPageKey(pages, pageKey),
          });
          return continued(env, plugin, body, session.run_id, options);
        }
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
    await transport?.close?.().catch((error: unknown) =>
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
  return continued(env, plugin, body, session.run_id, options);
}

export async function processParse(
  env: ResumableRuntimeEnv,
  plugin: ShopPlugin,
  session: CrawlFetchSessionRow,
  body: ResumableCrawlQueueMessage,
  options: ResumableCrawlConsumeOptions,
): Promise<ResumableCrawlConsumeResult> {
  const pageKey = session.next_page_key;
  if (!pageKey) throw new Error(`parse continuation has no page: ${session.run_id}`);
  const row = await getCrawlFetchPage(env.DB, session.run_id, pageKey);
  if (!row) throw new Error(`crawl frontier page not found: ${pageKey}`);
  if (row.state !== "fetched" || row.html_text == null) {
    return continued(env, plugin, body, session.run_id, options);
  }

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
  return continued(env, plugin, body, session.run_id, options);
}
