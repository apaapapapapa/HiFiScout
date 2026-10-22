import { evaluateInventoryCollectionSafety } from "../src/data-quality/quality-evaluator.js";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import {
  MAX_STALE_LISTING_BATCH_SIZE,
  getCrawlerSettings,
  getShopIntervalMinutes,
  getShopMaxPages,
  getShopStaleListingSettings,
} from "../src/config.js";
import { isCrawlQuietHours } from "../src/crawler/crawl-window.js";
import { hifidoRecheckPage } from "../src/crawler/shops/hifido.js";
import { crawlShop } from "../src/crawler/run.js";
import { processFinalize } from "../src/crawler/resumable-finalize.js";
import { recordCrawlFetchDetailPage } from "../src/db/crawl-fetch-detail-repository.js";
import {
  ensureCrawlFetchSession,
  getCrawlFetchSession,
} from "../src/db/crawl-fetch-session-repository.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { NormalizedCatalogProduct } from "../src/catalog/types.js";
import type { CrawlerEnv, ShopPlugin } from "../src/crawler/types.js";
import { parsedProduct } from "./helpers/fixtures.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

// A partial-coverage shop: its crawl never deactivates a listing merely for being absent.
const SHOP = "dynamic-audio";
const LISTING_PAGE = "https://dynamicaudio5used.wordpress.com/";
const plugin = getShopPlugin(SHOP);
assert.ok(plugin);
const dynamicAudio = plugin;
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

function listing(sourceId: string): NormalizedCatalogProduct {
  return normalizeCatalogProduct(
    parsedProduct({
      sourceId,
      manufacturer: "LUXMAN",
      model: `L-${sourceId}`,
      title: `LUXMAN L-${sourceId}`,
      sourceUrl: `${LISTING_PAGE}${sourceId}/`,
      priceYen: 98_000,
      stockStatus: "in_stock",
    }),
    dynamicAudio.capabilities.catalog,
  );
}

function adapterFor(products: NormalizedCatalogProduct[]): ShopPlugin {
  return {
    ...dynamicAudio,
    discovery: {
      coverage: dynamicAudio.discovery.coverage,
      policy: { ...dynamicAudio.discovery.policy, extraPageBudget: 0 },
      initialTargets: () => [LISTING_PAGE],
    },
    parse: () => products,
    parseWithStages: () => ({ products, rawParseMs: 0, normalizeMs: 0 }),
  } as unknown as ShopPlugin;
}

const EXPIRY_ENV = {
  DYNAMIC_AUDIO_STALE_LISTING_UNKNOWN_HOURS: "168",
  DYNAMIC_AUDIO_STALE_LISTING_EXPIRY_HOURS: "336",
  DYNAMIC_AUDIO_STALE_LISTING_MIN_RUNS: "2",
};

async function crawl(
  db: ReturnType<typeof migratedSqlite>["db"],
  products: NormalizedCatalogProduct[],
  vars: Record<string, string>,
) {
  const env = {
    DB: db,
    DYNAMIC_AUDIO_REQUEST_DELAY_MS: "0",
    CRAWL_MIN_ITEM_BASELINE: "100000",
    ...vars,
  } as unknown as Parameters<typeof crawlShop>[0];
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await crawlShop(env, adapterFor(products), {
      force: true,
      fetchFn: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/robots.txt")) return new Response("nf", { status: 404 });
        return new Response("<html><body></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }) as unknown as typeof fetch,
    });
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/** A shop with one current listing, one unseen for 20 days and one unseen for 10 days. */
async function seededShop(successfulRuns: number) {
  const database = migratedSqlite();
  const { sqlite, db } = database;
  await crawl(db, ["seen", "ancient", "aging"].map(listing), {});
  sqlite
    .prepare("UPDATE products SET last_seen_at = ? WHERE shop_key = ? AND source_id = ?")
    .run(daysAgo(20), SHOP, "ancient");
  sqlite
    .prepare("UPDATE products SET last_seen_at = ? WHERE shop_key = ? AND source_id = ?")
    .run(daysAgo(10), SHOP, "aging");
  sqlite.prepare("DELETE FROM crawl_runs WHERE shop_key = ?").run(SHOP);
  for (let run = 0; run < successfulRuns; run += 1)
    sqlite
      .prepare("INSERT INTO crawl_runs(shop_key, started_at, status) VALUES (?, ?, 'success')")
      .run(SHOP, daysAgo(run + 1));
  return database;
}

function state(sqlite: ReturnType<typeof migratedSqlite>["sqlite"], sourceId: string) {
  return {
    ...(sqlite
      .prepare("SELECT is_active, stock_status FROM products WHERE shop_key = ? AND source_id = ?")
      .get(SHOP, sourceId) as { is_active: number; stock_status: string }),
  };
}

test("a partial crawl marks old stock unknown without ending listings and owes their derived work", async () => {
  const { sqlite, db } = await seededShop(2);
  const result = await crawl(db, [listing("seen")], EXPIRY_ENV);

  assert.equal(result.status, "success");
  assert.equal(result.status === "success" && result.deactivateMissing, false);
  assert.equal(result.status === "success" && result.deactivatedCount, 0);
  assert.deepEqual(state(sqlite, "ancient"), { is_active: 1, stock_status: "unknown" });
  assert.deepEqual(state(sqlite, "aging"), { is_active: 1, stock_status: "unknown" });
  assert.deepEqual(state(sqlite, "seen"), { is_active: 1, stock_status: "in_stock" });
  const message = sqlite
    .prepare("SELECT message FROM crawl_runs WHERE shop_key = ? ORDER BY id DESC LIMIT 1")
    .get(SHOP) as { message: string };
  assert.match(message.message, /stale_expiry=\{"deactivated":0,"unknown":2\}/);

  // A later sighting restores both stale cohorts from seller evidence.
  await crawl(db, [listing("seen"), listing("aging"), listing("ancient")], EXPIRY_ENV);
  assert.deepEqual(state(sqlite, "aging"), { is_active: 1, stock_status: "in_stock" });
  assert.deepEqual(state(sqlite, "ancient"), { is_active: 1, stock_status: "in_stock" });
});

test("expiry waits until the shop's recent crawls have kept succeeding", async () => {
  const { sqlite, db } = await seededShop(1);
  await crawl(db, [listing("seen")], EXPIRY_ENV);
  assert.deepEqual(state(sqlite, "ancient"), { is_active: 1, stock_status: "in_stock" });
  assert.deepEqual(state(sqlite, "aging"), { is_active: 1, stock_status: "in_stock" });
});

test("staged collection counts listing work, excluding appended category detail receipts", async () => {
  for (const unfinishedState of [null, "pending", "ignored"] as const) {
    const incomplete = unfinishedState !== null;
    const { sqlite, db } = await seededShop(2);
    const at = new Date().toISOString();
    const runId = `planned-pages-${unfinishedState}`;
    await ensureCrawlFetchSession(db, {
      runId,
      shopKey: SHOP,
      requestedAt: at,
      maxPages: 50,
      pageLimit: 50,
      createdAt: at,
      pages: [
        { key: LISTING_PAGE, page: LISTING_PAGE, ordinal: 0 },
        ...(incomplete
          ? [{ key: `${LISTING_PAGE}page2`, page: `${LISTING_PAGE}page2`, ordinal: 1 }]
          : []),
      ],
    });
    sqlite
      .prepare(
        "UPDATE crawl_fetch_pages SET state = 'parsed', products_json = ?, item_count = 1 WHERE run_id = ? AND ordinal = 0",
      )
      .run(JSON.stringify([listing("seen")]), runId);
    if (unfinishedState) {
      sqlite
        .prepare("UPDATE crawl_fetch_pages SET state = ? WHERE run_id = ? AND ordinal = 1")
        .run(unfinishedState, runId);
    }
    // Both legacy HTML and current extracted-evidence rows are appended as ignored. They do not
    // count as missing listing pages, even when classification extraction was blocked by WAF.
    for (let detail = 0; detail < 20; detail += 1) {
      await recordCrawlFetchDetailPage(db, {
        runId,
        targetUrl: `${LISTING_PAGE}detail/${detail}`,
        fetchedAt: at,
        ...(detail % 2 ? { evidence: [] } : { errorMessage: "unexpected_http_202" }),
      });
    }
    sqlite
      .prepare(
        "UPDATE crawl_fetch_sessions SET pages_fetched = 1, pages_parsed = 1, next_phase = 'finalize', next_page_key = NULL WHERE run_id = ?",
      )
      .run(runId);
    const session = await getCrawlFetchSession(db, runId);
    assert.ok(session);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("nf", { status: 404 });
    try {
      await processFinalize(
        {
          DB: db,
          DYNAMIC_AUDIO_REQUEST_DELAY_MS: "0",
          CRAWL_MIN_ITEM_BASELINE: "100000",
          ...EXPIRY_ENV,
        } as unknown as Parameters<typeof processFinalize>[0],
        adapterFor([listing("seen")]),
        session,
        {},
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(state(sqlite, "ancient"), {
      is_active: 1,
      stock_status: incomplete ? "in_stock" : "unknown",
    });
    const row = sqlite
      .prepare("SELECT message FROM crawl_runs WHERE shop_key = ? ORDER BY id DESC LIMIT 1")
      .get(SHOP) as { message: string };
    if (incomplete) assert.match(row.message, /coverage_unreliable/);
    else assert.match(row.message, /stale_expiry=\{"deactivated":0,"unknown":2\}/);
  }
});

test("expiry is off unless the shop configures it", async () => {
  const { sqlite, db } = await seededShop(5);
  await crawl(db, [listing("seen")], {});
  assert.deepEqual(state(sqlite, "ancient"), { is_active: 1, stock_status: "in_stock" });
  assert.deepEqual(state(sqlite, "aging"), { is_active: 1, stock_status: "in_stock" });
});

/** Shop-scoped variables are composed at runtime, so they are not keys of `CrawlerEnv`. */
const vars = (values: Record<string, string>) => values as unknown as CrawlerEnv;

test("stale-listing settings come from the shop definition, with floors, overrides and a kill switch", () => {
  const hifido = getShopPlugin("hifido")!.definition;
  const defaults = getShopStaleListingSettings({}, hifido);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.unknownAfterHours, 21 * 24);
  assert.equal(defaults.expireAfterHours, 28 * 24);
  // A shop that declares nothing never expires listings unless configured.
  const ippinkan = getShopPlugin("ippinkan")!.definition;
  assert.equal(getShopStaleListingSettings({}, ippinkan).enabled, false);
  assert.equal(
    getShopStaleListingSettings(vars({ IPPINKAN_STALE_LISTING_EXPIRY_HOURS: "720" }), ippinkan)
      .enabled,
    true,
  );
  assert.equal(
    getShopStaleListingSettings(vars({ HIFIDO_STALE_LISTING_EXPIRY_ENABLED: "false" }), hifido)
      .enabled,
    false,
  );
  assert.equal(
    getShopStaleListingSettings(
      vars({
        HIFIDO_STALE_LISTING_EXPIRY_ENABLED: "false",
        HIFIDO_STALE_LISTING_UNKNOWN_ENABLED: "true",
      }),
      hifido,
    ).enabled,
    true,
  );
  assert.equal(
    getShopStaleListingSettings(vars({ HIFIDO_STALE_LISTING_UNKNOWN_ENABLED: "false" }), hifido)
      .enabled,
    false,
  );
  // Neither horizon may come within twice the touch interval of the present.
  const tight = getShopStaleListingSettings(
    vars({
      PRODUCT_TOUCH_INTERVAL_MINUTES: "2880",
      HIFIDO_STALE_LISTING_EXPIRY_HOURS: "1",
      HIFIDO_STALE_LISTING_UNKNOWN_HOURS: "1",
      HIFIDO_STALE_LISTING_BATCH_SIZE: "100000",
    }),
    hifido,
  );
  assert.equal(tight.unknownAfterHours, 96);
  assert.equal(tight.expireAfterHours, 96);
  assert.equal(tight.batchSize, MAX_STALE_LISTING_BATCH_SIZE);
});

test("Hifido's horizons outlast the longest gap its clock-driven rotation leaves a still-listed page", () => {
  const hifido = getShopPlugin("hifido")!;
  const intervalMinutes = getShopIntervalMinutes({}, hifido.definition);
  const maxPages = getShopMaxPages({}, hifido.definition, 1);
  const hourMs = 60 * 60_000;
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const lastSeen = new Map<number, number>();
  let worstGapMs = 0;
  // Every scheduled crawl outside the nightly pause visits the page the rotation names.
  for (let at = start; at < start + 60 * 24 * hourMs; at += intervalMinutes * 60_000) {
    if (isCrawlQuietHours(at)) continue;
    const page = hifidoRecheckPage(maxPages, {}, { now: new Date(at), intervalMinutes });
    if (page == null) continue;
    const previous = lastSeen.get(page);
    if (previous != null) worstGapMs = Math.max(worstGapMs, at - previous);
    lastSeen.set(page, at);
  }
  const touchMs = getCrawlerSettings({}).productTouchIntervalMinutes * 60_000;
  const settings = getShopStaleListingSettings({}, hifido.definition);
  assert.ok(worstGapMs > 0);
  assert.ok(
    settings.unknownAfterHours * hourMs > worstGapMs + touchMs,
    `unknown after ${settings.unknownAfterHours}h, rotation gap ${worstGapMs / hourMs}h`,
  );
});

test("inventory collection safety uses acquisition evidence, not classification severity", () => {
  const good = {
    successful: true,
    parsedPages: 4,
    parseFailures: 0,
    fetchFailures: 0,
    uncertainCoverage: false,
    expectedPages: 4,
    fetchedPages: 4,
    itemCount: 100,
    previousItemCount: 105,
    minItemRatio: 0.5,
    minItemBaseline: 30,
    previousSuccessAt: "2026-10-22T00:00:00.000Z",
    previousFailures: 0,
    observedAt: "2026-10-22T01:00:00.000Z",
    intervalMinutes: 60,
  };
  assert.equal(
    evaluateInventoryCollectionSafety({ ...good, qualityStatus: "critical" } as typeof good)
      .allowed,
    true,
  );
  for (const [override, reason] of [
    [{ successful: false }, "collection_failed"],
    [{ parseFailures: 1 }, "parse_incomplete"],
    [{ fetchFailures: 1 }, "fetch_failed"],
    [{ fetchedPages: 3 }, "coverage_unreliable"],
    [{ uncertainCoverage: true }, "coverage_unreliable"],
    [{ itemCount: 10 }, "item_count_drop"],
    [{ previousSuccessAt: "2026-10-01T00:00:00.000Z" }, "success_gap"],
    [{ previousFailures: 2 }, "recovering_after_failure"],
  ] as const) {
    const result = evaluateInventoryCollectionSafety({ ...good, ...override });
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.includes(reason));
  }
});

test("successful-run counts do not override an outage; a recovered collection resumes aging", async () => {
  const { sqlite, db } = await seededShop(5);
  sqlite
    .prepare(
      "UPDATE shop_sync_state SET last_success_at=?, consecutive_failures=2 WHERE shop_key=?",
    )
    .run(daysAgo(10), SHOP);
  await crawl(db, [listing("seen")], EXPIRY_ENV);
  assert.equal(state(sqlite, "ancient").stock_status, "in_stock");
  const message = sqlite
    .prepare("SELECT message FROM crawl_runs WHERE shop_key=? ORDER BY id DESC LIMIT 1")
    .get(SHOP)!.message;
  assert.match(String(message), /success_gap/);
  await crawl(db, [listing("seen")], EXPIRY_ENV);
  assert.equal(state(sqlite, "ancient").stock_status, "unknown");
});
