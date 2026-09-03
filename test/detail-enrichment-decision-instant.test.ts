import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  CATEGORY_CLASSIFICATION_METADATA_VERSION,
  normalizeCatalogProduct,
} from "../src/catalog/product-normalizer.js";
import { crawlShop } from "../src/crawler/run.js";
import { resolveProductCatalogFields } from "../src/db/model-repository.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { NormalizedCatalogProduct } from "../src/catalog/types.js";
import type { ShopPlugin } from "../src/crawler/types.js";
import { parsedProduct } from "./helpers/fixtures.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

/**
 * Category enrichment is time-dependent: a listing whose unresolved category was checked less than
 * `cacheHours` ago is suppressed, and once that window elapses the same listing becomes a detail
 * target. A resumable crawl asks that question twice -- the Durable Object asks it to plan which
 * detail pages to pace, and finalization asks it again to decide what evidence it needs -- with the
 * paced seller requests in between. Left on two clocks, a cache entry expiring during those fetches
 * makes finalization require a detail page the plan never staged, which the fail-closed staged
 * transport reports as `category detail fetch was not paced by CrawlScheduler` and fails the crawl.
 *
 * `enrichmentDecidedAt` is what keeps the two answers identical. These tests pin it at the seam it
 * actually crosses: `crawlShop`, which runs enrichment on its own observation instant unless told
 * otherwise.
 */

const SHOP = "fujiya-avic";
const SOURCE_ID = "decision-instant-1";
const LISTING_PAGE = "https://www.fujiya-avic.co.jp/shop/c/c/";
const DETAIL_URL = "https://www.fujiya-avic.co.jp/shop/g/gdecision-instant-1/";
const HOUR_MS = 60 * 60_000;

/** The shop's own enrichment window; a check older than this makes the listing a target again. */
const CACHE_HOURS = 168;

const plugin = getShopPlugin(SHOP);
assert.ok(plugin, "fujiya-avic plugin missing");
const fujiyaAvic = plugin;

const DETAIL_HTML =
  '<html><head><meta name="description" content="Example EX-1 完全ワイヤレスイヤホンの中古商品です。"></head><body><h1>EX-1</h1></body></html>';

function unclassifiedListing(): NormalizedCatalogProduct {
  const product = normalizeCatalogProduct(
    parsedProduct({
      sourceId: SOURCE_ID,
      manufacturer: "Example",
      model: "EX-1",
      title: "Example EX-1",
      sourceUrl: DETAIL_URL,
      priceYen: 12_800,
      stockStatus: "in_stock",
    }),
    fujiyaAvic.capabilities.catalog,
  );
  assert.equal(product.classificationStatus, "unclassified");
  return product;
}

/**
 * The row that makes the decision time matter: a previous crawl checked this identity's detail page
 * and resolved nothing, so the shop waits out `cacheHours` before spending another request on it.
 *
 * The identity columns are taken from the product as the catalog resolver leaves it, not from the
 * parsed listing, because that is the shape the enricher compares against. A fixture that guessed
 * them would silently stop matching and quietly test nothing.
 */
function insertUnresolvedCheck(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  product: NormalizedCatalogProduct,
  detailCheckedAt: Date,
): void {
  sqlite
    .prepare(`
      INSERT INTO products (
        shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at,
        is_active,
        manufacturer, raw_manufacturer, manufacturer_id, model, raw_model,
        classification_status, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'unclassified', ?)
    `)
    .run(
      SHOP,
      product.sourceId,
      product.title,
      product.sourceUrl,
      detailCheckedAt.toISOString(),
      detailCheckedAt.toISOString(),
      detailCheckedAt.toISOString(),
      product.manufacturer,
      product.manufacturer,
      product.manufacturerId ?? "",
      product.model ?? "",
      product.model ?? "",
      JSON.stringify({
        categoryClassification: {
          version: CATEGORY_CLASSIFICATION_METADATA_VERSION,
          state: "unresolved",
          detailCheckedAt: detailCheckedAt.toISOString(),
        },
      }),
    );
}

/** A crawl whose listings are supplied directly, so only the enrichment decision is under test. */
function stagedAdapter(products: NormalizedCatalogProduct[]): ShopPlugin {
  return {
    ...fujiyaAvic,
    capabilities: { ...fujiyaAvic.capabilities, transport: { kind: "direct" } },
    discovery: {
      coverage: fujiyaAvic.discovery.coverage,
      policy: { ...fujiyaAvic.discovery.policy, extraPageBudget: 0 },
      initialTargets: () => [LISTING_PAGE],
    },
    parse: () => products,
    parseWithStages: () => ({ products, rawParseMs: 0, normalizeMs: 0 }),
  } as unknown as ShopPlugin;
}

interface CrawlOutcome {
  detailRequests: string[];
  status: string;
}

async function crawlWithCheckAged(
  hoursSinceCheck: number,
  enrichmentDecidedAt?: Date,
): Promise<CrawlOutcome> {
  const { sqlite, db } = migratedSqlite();
  const product = unclassifiedListing();
  const [resolved] = await resolveProductCatalogFields(db, [product], { shopKey: SHOP });
  assert.ok(resolved);
  insertUnresolvedCheck(sqlite, resolved, new Date(Date.now() - hoursSinceCheck * HOUR_MS));

  const detailRequests: string[] = [];
  const env = {
    DB: db,
    FUJIYA_AVIC_REQUEST_DELAY_MS: "0",
  } as unknown as Parameters<typeof crawlShop>[0];

  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  let result;
  try {
    result = await crawlShop(env, stagedAdapter([product]), {
      force: true,
      ...(enrichmentDecidedAt ? { enrichmentDecidedAt } : {}),
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/robots.txt")) return new Response("not found", { status: 404 });
        if (url === LISTING_PAGE) {
          return new Response("<html><body></body></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        detailRequests.push(url);
        return new Response(DETAIL_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }) as unknown as typeof fetch,
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  return { detailRequests, status: result.status };
}

test("an enrichment window that elapses mid-crawl turns the listing into a detail target", async () => {
  // The precondition the pinning exists for. Without it this is what finalization sees once the
  // paced fetches have carried the run past the window the plan was built inside.
  const fresh = await crawlWithCheckAged(CACHE_HOURS - 1);
  assert.equal(fresh.status, "success");
  assert.deepEqual(fresh.detailRequests, [], "inside the window the listing is suppressed");

  const expired = await crawlWithCheckAged(CACHE_HOURS + 1);
  assert.equal(expired.status, "success");
  assert.deepEqual(expired.detailRequests, [DETAIL_URL], "past it the same listing is required");
});

test("a pinned decision instant keeps enrichment on the clock the plan was built with", async () => {
  // Same expired row as above, but evaluated at an instant two hours back -- inside the window, as
  // the Durable Object was when it planned. The plan staged no detail page for this listing, so
  // finalization must not ask for one.
  const pinned = await crawlWithCheckAged(CACHE_HOURS + 1, new Date(Date.now() - 2 * HOUR_MS));

  assert.equal(pinned.status, "success");
  assert.deepEqual(
    pinned.detailRequests,
    [],
    "the pinned instant, not the crawl's own clock, decides eligibility",
  );
});
