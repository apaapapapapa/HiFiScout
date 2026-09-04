import { getCrawlerSettings, getShopRequestDelayMs } from "../config.js";
import {
  decodeCrawlFetchPage,
  getCrawlFetchPage,
  type CrawlFetchPageInput,
  type CrawlFetchSessionRow,
} from "../db/crawl-fetch-session-repository.js";
import {
  crawlFetchFrontierProbe,
  knownCrawlFetchPageKeys,
  recordCrawlFetchPageFetched,
  recordCrawlFetchPageIgnored,
  recordCrawlFetchPageParsed,
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
        // One bounded probe answers both questions this branch asks -- whether the run has staged
        // anything, and which page comes next -- where it used to reread the run's frontier.
        const frontier = await crawlFetchFrontierProbe(env.DB, session.run_id, pageKey);
        if (shouldContinueAfterEmpty(plugin) || !frontier.hasStagedItems) {
          await recordCrawlFetchPageIgnored(env.DB, {
            runId: session.run_id,
            pageKey,
            ignoredAt: new Date().toISOString(),
            currentSequence: session.continuation_sequence,
            nextPageKey: frontier.nextPendingPageKey,
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
  let parsed;
  try {
    parsed = plugin.parseWithStages(row.html_text, page);
  } catch (error) {
    return failCollection(env, plugin, session.run_id, error);
  }
  const products = parsed.products;
  const discoveryStartedAt = performance.now();
  const discovered = discoverPages(plugin, row.html_text, page);
  const discoverMs = performance.now() - discoveryStartedAt;
  const parseMs = parsed.rawParseMs + parsed.normalizeMs;

  const discoveredCandidates = (discovered || []).map((candidate) => ({
    key: targetUrl(plugin, candidate),
    page: candidate,
  }));
  const known = await knownCrawlFetchPageKeys(
    env.DB,
    session.run_id,
    discoveredCandidates.map((candidate) => candidate.key),
  );
  // Authoritative, and bounded: three index seeks rather than a materialization of the frontier.
  const frontier = await crawlFetchFrontierProbe(env.DB, session.run_id, pageKey);
  const accepted: CrawlFetchPageInput[] = [];
  let coverageIncomplete = discovered == null;
  // Ordinals are allocated densely from 0 and no path deletes a page row within a run, so the next
  // ordinal is also the frontier's size. If that ever stops holding, this over-counts and the page
  // limit bites earlier -- coverage marked incomplete, never a page silently dropped.
  let frontierCount = frontier.nextOrdinal;
  let nextOrdinal = frontier.nextOrdinal;

  for (const candidate of discoveredCandidates) {
    if (known.has(candidate.key)) continue;
    if (frontierCount >= session.page_limit) {
      coverageIncomplete = true;
      continue;
    }
    // Add locally as well as in D1 so duplicate candidates in the same discovery result cannot
    // consume multiple ordinals or inflate the aggregate update.
    known.add(candidate.key);
    frontierCount += 1;
    accepted.push({ key: candidate.key, page: candidate.page, ordinal: nextOrdinal++ });
  }

  if (!products.length && plugin.discovery.discoverTargets) coverageIncomplete = true;
  const reachedEnd =
    products.length === 0 && frontier.hasStagedItems && !shouldContinueAfterEmpty(plugin);
  let nextPageKey = frontier.nextPendingPageKey || accepted[0]?.key || null;
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
      rawParseMs: parsed.rawParseMs,
      normalizeMs: parsed.normalizeMs,
      discoverMs,
      parserPipelineMs: parseMs + discoverMs,
      discoveredCount: accepted.length,
      coverageIncomplete,
      reachedEnd,
      workerVersion: workerVersion(env),
    }),
  );
  return continued(env, plugin, body, session.run_id, options);
}
