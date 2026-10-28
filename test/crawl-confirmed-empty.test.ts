import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { crawlShop } from "../src/crawler/run.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { processFetch, processParse } from "../src/crawler/resumable-page-steps.js";
import {
  readCollectionSession,
  type CollectionProgressState,
} from "../src/crawler/collection-progress.js";
import { collectionProgress } from "../src/db/crawl-fetch-progress.js";
import {
  ensureCrawlFetchSession,
  getCrawlFetchSession,
  listCrawlFetchPages,
} from "../src/db/crawl-fetch-session-repository.js";
import type { ShopPlugin } from "../src/crawler/types.js";
import { parsedProduct } from "./helpers/fixtures.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { recordingDatabase } from "./helpers/query-plan.js";

const shop = getShopPlugin("dynamic-audio")!;
const first = `${shop.baseUrl}/current/`;
const empty = `${shop.baseUrl}/empty/`;
const emptyNotice = "<p>No listings in this category</p>";

function product(id: string) {
  return normalizeCatalogProduct(
    parsedProduct({
      sourceId: id,
      sourceUrl: `${shop.baseUrl}/${id}/`,
      title: "LUXMAN L-505",
      manufacturer: "LUXMAN",
      model: "L-505",
      stockStatus: "in_stock",
      priceYen: 98000,
    }),
    shop.capabilities.catalog,
  );
}

function adapter(discovered: readonly string[] | null = []): ShopPlugin {
  const products = [product("seen")];
  return {
    ...shop,
    discovery: {
      coverage: "partial",
      policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
      initialTargets: () => [first, empty],
      discoverTargets: (_html, page) => (page === empty ? discovered : []),
      isConfirmedEmptyPage: (html, page) => page === empty && html === emptyNotice,
    },
    parse: (html) => (html === "products" ? products : []),
    parseWithStages: (html) => ({
      products: html === "products" ? products : [],
      rawParseMs: 0,
      normalizeMs: 0,
    }),
  };
}

function environment(db: ReturnType<typeof migratedSqlite>["db"]) {
  return {
    DB: db,
    DYNAMIC_AUDIO_REQUEST_DELAY_MS: "0",
    DYNAMIC_AUDIO_MAX_PAGES: "3",
    DYNAMIC_AUDIO_STALE_LISTING_UNKNOWN_HOURS: "168",
    DYNAMIC_AUDIO_STALE_LISTING_EXPIRY_HOURS: "336",
    DYNAMIC_AUDIO_STALE_LISTING_MIN_RUNS: "2",
    CRAWL_MIN_ITEM_BASELINE: "100000",
  };
}

test("only a verified terminal empty category allows aging in an otherwise successful partial crawl", async () => {
  for (const [html, discovered, expected] of [
    [emptyNotice, [], "unknown"],
    ["<html>error</html>", [], "in_stock"],
    [emptyNotice, null, "in_stock"],
    [emptyNotice, [first], "in_stock"],
  ] as const) {
    const { db, sqlite } = migratedSqlite();
    const env = environment(db);
    const fetchFn: typeof fetch = async (input) =>
      new Response(String(input) === empty ? html : "products", {
        status: String(input).endsWith("/robots.txt") ? 404 : 200,
        headers: { "content-type": "text/html" },
      });
    const seed = {
      ...adapter(),
      discovery: { ...adapter().discovery, initialTargets: () => [first] },
      parse: () => [product("seen"), product("old")],
    };
    assert.equal((await crawlShop(env, seed, { force: true, fetchFn })).status, "success");
    sqlite
      .prepare("UPDATE products SET last_seen_at=? WHERE shop_key=? AND source_id='old'")
      .run(new Date(Date.now() - 20 * 86400000).toISOString(), shop.key);
    sqlite
      .prepare("INSERT INTO crawl_runs(shop_key, started_at, status) VALUES (?, ?, 'success')")
      .run(shop.key, new Date().toISOString());
    const result = await crawlShop(env, adapter(discovered), { force: true, fetchFn });
    assert.equal(result.status, "success");
    const old = sqlite
      .prepare("SELECT is_active, stock_status FROM products WHERE shop_key=? AND source_id='old'")
      .get(shop.key);
    assert.equal(old?.is_active, 1);
    assert.equal(old?.stock_status, expected);
  }
});

test("a wholly empty crawl remains a parser failure even with explicit empty evidence", async () => {
  const { db } = migratedSqlite();
  const plugin = {
    ...adapter(),
    discovery: { ...adapter().discovery, initialTargets: () => [empty] },
  };
  const result = await crawlShop(environment(db), plugin, {
    force: true,
    fetchFn: async (input) =>
      new Response(emptyNotice, {
        status: String(input).endsWith("/robots.txt") ? 404 : 200,
        headers: { "content-type": "text/html" },
      }),
  });
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /no products parsed/);
});

test("confirmed-empty safety survives inline/split parsing and lost DO progress without repeated work", async () => {
  for (const inline of [false, true]) {
    for (const [html, discovered, incomplete] of [
      [emptyNotice, [], 0],
      ["<html>error</html>", [], 1],
      [emptyNotice, null, 1],
      [emptyNotice, [first], 1],
    ] as const) {
      const { db } = migratedSqlite();
      const recording = recordingDatabase(db);
      const env = environment(recording.db);
      const runId = "confirmed-empty-recovery";
      const at = new Date().toISOString();
      const { session } = await ensureCrawlFetchSession(db, {
        runId,
        shopKey: shop.key,
        requestedAt: at,
        createdAt: at,
        progressStorage: "durable_object",
        maxPages: 3,
        pageLimit: 3,
        pages: [first, empty, `${shop.baseUrl}/after/`].map((key, ordinal) => ({
          key,
          page: key,
          ordinal,
        })),
      });
      const state: CollectionProgressState = {
        value: { runId, progress: collectionProgress(session) },
      };
      const current = async () => {
        const row = await readCollectionSession(db, runId, state);
        assert.ok(row);
        return row;
      };
      const body = {
        shopKey: shop.key,
        force: true,
        requestedAt: at,
        jobId: runId,
        collectionRunId: runId,
      };
      const plugin = adapter(discovered);
      const options = {
        collectionProgress: state,
        parseFetchedPage: inline,
        fetchHtmlPage: async (url: string) => (url === empty ? html : "products"),
      };
      await processFetch(env, plugin, await current(), body, options);
      if (!inline) await processParse(env, plugin, await current(), body, options);
      if (!inline) await processFetch(env, plugin, await current(), body, options);
      const before = structuredClone(state.value);
      const emptySession = await current();
      const run = inline ? processFetch : processParse;
      const result = await run(env, plugin, emptySession, body, options);
      const committed = structuredClone(state.value);
      assert.equal(committed?.progress.coverage_incomplete, incomplete);
      assert.equal(committed?.progress.pages_parsed, 2);
      assert.equal(committed?.progress.next_phase, "fetch");
      // The D1 page receipt committed, but its DO cursor write was lost.
      state.value = before;
      recording.executed.length = 0;
      const replay = await run(
        env,
        {
          ...plugin,
          parseWithStages() {
            throw new Error("duplicate parse");
          },
          discovery: {
            ...plugin.discovery,
            isConfirmedEmptyPage() {
              throw new Error("duplicate evidence check");
            },
          },
        },
        emptySession,
        body,
        {
          ...options,
          fetchHtmlPage: async () => {
            throw new Error("duplicate HTTP");
          },
        },
      );
      assert.deepEqual(replay, result);
      assert.deepEqual(state.value, committed);
      assert.ok(recording.executed.every(({ sql }) => /^\s*SELECT\b/u.test(sql)));
      await processFetch(env, plugin, await current(), body, options);
      if (!inline) await processParse(env, plugin, await current(), body, options);
      assert.equal((await getCrawlFetchSession(db, runId))?.coverage_incomplete, incomplete);
      assert.equal((await getCrawlFetchSession(db, runId))?.next_phase, "finalize");
      const pages = await listCrawlFetchPages(db, runId);
      assert.equal(pages[1]?.state, "parsed");
      assert.equal(pages[1]?.item_count, 0);
    }
  }
});
