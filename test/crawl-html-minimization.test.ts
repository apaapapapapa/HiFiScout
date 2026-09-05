import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { enrichProductCategories } from "../src/crawler/category-enricher.js";
import type { CollectionProgressState } from "../src/crawler/collection-progress.js";
import { processFetch, processParse } from "../src/crawler/resumable-page-steps.js";
import { processFinalize } from "../src/crawler/resumable-finalize.js";
import { readStagedDetailEvidence } from "../src/crawler/staged-detail-evidence.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import {
  detailEnrichmentProgress,
  nextUncommittedDetailTargetWithInput,
  type DetailEnrichmentPlanContext,
} from "../src/crawler/detail-enrichment-plan.js";
import type { ResumableRuntimeEnv } from "../src/crawler/resumable-queue-contract.js";
import {
  ensureCrawlFetchSession,
  getCrawlFetchSession,
  getCrawlFetchPage,
} from "../src/db/crawl-fetch-session-repository.js";
import {
  recordCrawlFetchDetailPage,
  hasCrawlFetchDetailPage,
} from "../src/db/crawl-fetch-detail-repository.js";
import {
  recordCrawlFetchPageFetched,
  recordCrawlFetchPageParsed,
} from "../src/db/crawl-fetch-page-repository.js";
import { asQueryableDatabase } from "./helpers/d1.js";
import { detailFetchOptions } from "./helpers/fixtures.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const AT = "2026-09-05T00:00:00.000Z";
const PAGE = "https://www.homeshokai.jp/itemlist.php?a=2";
const HTML =
  '<html><a href="/item.php?z=EX1">LUXMAN プリメインアンプ L-505uXII 〇委託販売品 ￥ 250,000 -</a></html>';
const home = getShopPlugin("home-shokai")!;
const fujiya = getShopPlugin("fujiya-avic")!;

async function session(
  db: ReturnType<typeof migratedSqlite>["db"],
  runId: string,
  progressStorage: "d1" | "durable_object" = "d1",
) {
  return (
    await ensureCrawlFetchSession(db, {
      runId,
      progressStorage,
      shopKey: home.key,
      requestedAt: AT,
      maxPages: 1,
      pageLimit: 1,
      pages: [{ key: PAGE, page: PAGE, ordinal: 0 }],
      createdAt: AT,
    })
  ).session;
}

for (const mode of ["d1", "durable_object"] as const) {
  test(`a ${mode} restart after the atomic inline commit resumes without HTML or another seller fetch`, async () => {
    const { db, sqlite } = migratedSqlite();
    const initial = await session(db, "inline", mode);
    const collectionProgress: CollectionProgressState | undefined =
      mode === "durable_object" ? { value: null } : undefined;
    let fetches = 0;
    const interrupted = asQueryableDatabase({
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        await db.batch(statements);
        throw new Error("isolate stopped after commit");
      },
    });
    const options = {
      collectionProgress,
      parseFetchedPage: true,
      fetchHtmlPage: async () => {
        fetches++;
        return HTML;
      },
    };
    const body = {
      shopKey: home.key,
      force: true,
      requestedAt: AT,
      collectionRunId: initial.run_id,
    };
    await assert.rejects(
      processFetch({ DB: interrupted } as ResumableRuntimeEnv, home, initial, body, options),
      /after commit/,
    );
    const resumed = await processFetch(
      { DB: db } as ResumableRuntimeEnv,
      home,
      initial,
      body,
      options,
    );
    assert.equal(resumed.kind, "continued");
    assert.equal(fetches, 1);
    const saved = await getCrawlFetchPage(db, initial.run_id, PAGE);
    assert.equal(saved?.html_text, null);
    assert.equal(saved?.state, "parsed");
    assert.ok((saved?.item_count ?? 0) > 0);
    assert.equal(saved?.html_bytes, new TextEncoder().encode(HTML).byteLength);
    const progress = await getCrawlFetchSession(db, initial.run_id);
    assert.equal(progress?.pages_fetched, 1);
    assert.equal(progress?.pages_parsed, 1);
    assert.equal(progress?.continuation_sequence, 1);
    assert.equal(progress?.next_phase, "finalize");
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) n FROM products").get()?.n,
      0,
      "collection must not publish partial inventory",
    );
  });
}

test("an HTML checkpoint written before deployment is parsed without refetching", async () => {
  const { db } = migratedSqlite();
  const initial = await session(db, "legacy");
  await recordCrawlFetchPageFetched(db, {
    runId: initial.run_id,
    pageKey: PAGE,
    currentSequence: 0,
    html: HTML,
    htmlBytes: new TextEncoder().encode(HTML).byteLength,
    fetchedAt: AT,
  });
  const pending = await getCrawlFetchSession(db, initial.run_id);
  assert.ok(pending);
  await processParse(
    { DB: db } as ResumableRuntimeEnv,
    home,
    pending,
    { shopKey: home.key, force: true, requestedAt: AT },
    {
      parseFetchedPage: true,
      fetchHtmlPage: async () => {
        throw new Error("legacy replay must not fetch");
      },
    },
  );
  assert.equal((await getCrawlFetchPage(db, initial.run_id, PAGE))?.html_text, null);
  assert.equal((await getCrawlFetchSession(db, initial.run_id))?.continuation_sequence, 2);
});

test("a parser failure archives the real failed sample and never publishes inventory", async () => {
  const { db, sqlite } = migratedSqlite();
  const initial = await session(db, "bad-parser");
  const archived: Uint8Array[] = [];
  const result = await processFetch(
    {
      DB: db,
      EVIDENCE_BUCKET: {
        put: async (_key: string, body: Uint8Array) => {
          archived.push(body);
        },
      },
    } as unknown as ResumableRuntimeEnv,
    {
      ...home,
      parseWithStages: () => {
        throw new Error("broken parser");
      },
    },
    initial,
    { shopKey: home.key, force: true, requestedAt: AT },
    {
      parseFetchedPage: true,
      fetchHtmlPage: async () => HTML,
    },
  );
  assert.equal(result.kind, "terminal");
  assert.equal((await getCrawlFetchSession(db, initial.run_id))?.status, "failed");
  assert.equal((await getCrawlFetchPage(db, initial.run_id, PAGE))?.html_text, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM products").get()?.n, 0);
  assert.equal(archived.length, 1);
  assert.equal(new TextDecoder().decode(archived[0]), HTML);
});

test("detail evidence and an HTML replay produce the same per-listing classification and decision time", async () => {
  const { db, sqlite } = migratedSqlite();
  await session(db, "detail");
  const product = normalizeCatalogProduct(
    {
      sourceId: "EX1",
      sourceUrl: "https://www.fujiya-avic.co.jp/shop/g/gEX1/",
      manufacturer: "Example",
      model: "EX-1",
      title: "Example EX-1",
      conditionText: "中古",
      priceYen: 12000,
      stockStatus: "in_stock",
    },
    fujiya.capabilities.catalog,
  );
  const html =
    '<meta name="description" content="Example EX-1 完全ワイヤレスイヤホンの中古商品です。">' +
    " ".repeat(100_000);
  const extract = fujiya.capabilities.detailCategoryEvidence!.extract;
  const evidence = await extract(html, product);
  assert.ok(evidence.length > 0);
  await recordCrawlFetchDetailPage(db, {
    runId: "detail",
    targetUrl: product.sourceUrl,
    html,
    evidence,
    fetchedAt: AT,
    htmlBytes: new TextEncoder().encode(html).byteLength,
  });
  const stored = sqlite
    .prepare("SELECT html_text, products_json FROM crawl_fetch_pages WHERE state='ignored'")
    .get();
  assert.equal(stored?.html_text, null);
  assert.ok(String(stored?.products_json).length < 2000);
  assert.equal(await hasCrawlFetchDetailPage(db, "detail", product.sourceUrl), true);
  let extractions = 0;
  const replay = await readStagedDetailEvidence(db, "detail", product, () => {
    extractions++;
    return [];
  });
  assert.deepEqual(replay, evidence);
  assert.equal(extractions, 0);
  const common = {
    db,
    adapter: fujiya,
    products: [product],
    now: new Date(AT),
    existingRows: [],
    fetchOptions: detailFetchOptions(),
  };
  const direct = await enrichProductCategories({
    ...common,
    transport: { fetchHtmlPage: async () => html },
  });
  const staged = await enrichProductCategories({
    ...common,
    transport: {
      fetchHtmlPage: async () => {
        throw new Error("staged evidence must not fetch");
      },
    },
    loadDetailEvidence: async () => replay!,
  });
  assert.deepEqual(staged.products, direct.products);
  assert.equal(staged.products[0]?.classificationStatus, "classified");
  await recordCrawlFetchDetailPage(db, {
    runId: "detail",
    targetUrl: product.sourceUrl,
    evidence: [],
    fetchedAt: "2026-09-06T00:00:00.000Z",
  });
  assert.deepEqual(await readStagedDetailEvidence(db, "detail", product, extract), evidence);
  assert.equal(
    await db
      .prepare(`SELECT 1 FROM crawl_fetch_pages
      WHERE run_id = ? AND page_key = ? AND state = 'ignored' LIMIT 1`)
      .bind("detail", `__hifiscout_category_detail__:${product.sourceUrl}`)
      .first(),
    null,
    "the previous Worker's HTML-only fence must not claim structured evidence",
  );
  await recordCrawlFetchDetailPage(db, {
    runId: "detail",
    targetUrl: product.sourceUrl,
    html: "legacy replay",
    fetchedAt: AT,
  });
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM crawl_fetch_pages WHERE state='ignored'").get()?.n,
    1,
  );
  assert.deepEqual(await readStagedDetailEvidence(db, "detail", product, extract), evidence);
});

test("negative, failed and legacy detail outcomes survive restarts without a new seller request", async () => {
  const { db } = migratedSqlite();
  await session(db, "outcomes");
  const product = normalizeCatalogProduct({
    sourceId: "x",
    sourceUrl: "https://example.test/detail",
    title: "EX-1",
    manufacturer: "Example",
    model: "EX-1",
    conditionText: "中古",
    priceYen: 12000,
    stockStatus: "in_stock",
  });
  await recordCrawlFetchDetailPage(db, {
    runId: "outcomes",
    targetUrl: product.sourceUrl,
    evidence: [],
    fetchedAt: AT,
  });
  assert.deepEqual(
    await readStagedDetailEvidence(db, "outcomes", product, () => {
      throw new Error("must not parse again");
    }),
    [],
  );
  const failed = { ...product, sourceUrl: product.sourceUrl + "/failed" };
  await recordCrawlFetchDetailPage(db, {
    runId: "outcomes",
    targetUrl: failed.sourceUrl,
    errorMessage: "HTTP 503",
    fetchedAt: AT,
  });
  assert.equal(await hasCrawlFetchDetailPage(db, "outcomes", failed.sourceUrl), true);
  await assert.rejects(
    readStagedDetailEvidence(db, "outcomes", failed, () => []),
    /HTTP 503/,
  );
  const legacy = { ...product, sourceUrl: product.sourceUrl + "/legacy" };
  await recordCrawlFetchDetailPage(db, {
    runId: "outcomes",
    targetUrl: legacy.sourceUrl,
    html: "<h1>legacy</h1>",
    fetchedAt: AT,
  });
  assert.deepEqual(
    await readStagedDetailEvidence(db, "outcomes", legacy, (html) => [{ value: html }]),
    [{ value: "<h1>legacy</h1>" }],
  );
});

test("detail plans retain the original minimal extractor input across a restart without replanning", async () => {
  const stored = new Map<string, unknown>();
  const target = {
    url: "https://example.test/detail",
    product: { sourceId: "a", model: "C2", title: "Yamaha C2" },
  };
  let plans = 0;
  const context: DetailEnrichmentPlanContext = {
    storage: {
      get: async <T>(key: string) => structuredClone(stored.get(key)) as T | undefined,
      put: async (key, value) => {
        stored.set(key, structuredClone(value));
      },
      delete: async (key) => {
        stored.delete(key);
      },
    },
    planTargets: async () => {
      plans++;
      return [target];
    },
    isCommitted: async () => false,
    now: () => new Date(AT),
  };
  await detailEnrichmentProgress(context, "plan");
  const restored = await detailEnrichmentProgress(
    {
      ...context,
      planTargets: async () => {
        throw new Error("must not replan");
      },
    },
    "plan",
  );
  assert.equal(plans, 1);
  assert.equal(restored.decidedAt, AT);
  assert.deepEqual(await nextUncommittedDetailTargetWithInput(context, restored), target);
  const chunk = [...stored.values()].find(
    (value) => typeof value === "object" && value !== null && "targets" in value,
  ) as { targets: string[] };
  assert.deepEqual(
    chunk.targets,
    [target.url],
    "older releases must still see URL strings on rollback",
  );
});

test("finalization publishes structured detail evidence once without seller I/O or synthetic R2 archives", async () => {
  const { db, sqlite } = migratedSqlite();
  const runId = "finalize-evidence";
  const sourceUrl = "https://www.fujiya-avic.co.jp/shop/g/gEX1/";
  const listingUrl = "https://www.fujiya-avic.co.jp/shop/c/c/";
  const product = normalizeCatalogProduct(
    {
      sourceId: "EX1",
      sourceUrl,
      manufacturer: "Example",
      model: "EX-1",
      title: "Example EX-1",
      conditionText: "中古",
      priceYen: 12000,
      stockStatus: "in_stock",
    },
    fujiya.capabilities.catalog,
  );
  await ensureCrawlFetchSession(db, {
    runId,
    shopKey: fujiya.key,
    requestedAt: AT,
    maxPages: 1,
    pageLimit: 1,
    pages: [{ key: listingUrl, page: listingUrl, ordinal: 0 }],
    createdAt: AT,
  });
  await recordCrawlFetchPageParsed(db, {
    runId,
    pageKey: listingUrl,
    products: [product],
    discoveredPages: [],
    parsedAt: AT,
    currentSequence: 0,
    nextPageKey: null,
    coverageIncomplete: false,
    reachedEnd: false,
    fetched: { at: AT, htmlBytes: 200 },
  });
  const evidence = await fujiya.capabilities.detailCategoryEvidence!.extract(
    '<meta name="description" content="Example EX-1 完全ワイヤレスイヤホンの中古商品です。">',
    product,
  );
  await recordCrawlFetchDetailPage(db, { runId, targetUrl: sourceUrl, evidence, fetchedAt: AT });
  const ready = await getCrawlFetchSession(db, runId);
  assert.ok(ready);
  const originalFetch = globalThis.fetch;
  let sellerRequests = 0;
  let archives = 0;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /");
    sellerRequests++;
    throw new Error("finalization must not fetch seller content");
  };
  try {
    const env = {
      DB: db,
      FUJIYA_AVIC_REQUEST_DELAY_MS: "0",
      EVIDENCE_BUCKET: {
        put: async () => {
          archives++;
        },
      },
    } as unknown as ResumableRuntimeEnv;
    const options = { requireStagedDetailFetches: true, detailDecisionAt: AT };
    const result = await processFinalize(env, fujiya, ready, options);
    assert.equal(result.kind, "terminal");
    if (result.kind === "terminal")
      assert.equal(result.result.status, "success", JSON.stringify(result));
    assert.equal((await getCrawlFetchSession(db, runId))?.status, "completed");
    assert.equal(
      sqlite.prepare("SELECT classification_status FROM products WHERE source_id='EX1'").get()
        ?.classification_status,
      "classified",
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM price_history").get()?.n, 1);
    await processFinalize(env, fujiya, ready, options);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM price_history").get()?.n, 1);
    assert.equal(sellerRequests, 0);
    assert.equal(archives, 0);
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) n FROM crawl_fetch_pages WHERE html_text IS NOT NULL OR products_json IS NOT NULL",
        )
        .get()?.n,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
