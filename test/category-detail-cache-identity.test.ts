import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { crawlShop } from "../src/crawler/run.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { NormalizedCatalogProduct } from "../src/catalog/types.js";
import type { ShopPlugin } from "../src/crawler/types.js";
import { parsedProduct } from "./helpers/fixtures.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const SHOP = "fujiya-avic";
const LISTING_PAGE = "https://www.fujiya-avic.co.jp/shop/c/c/";
const plugin = getShopPlugin(SHOP);
assert.ok(plugin);
const fujiya = plugin;

/** A detail page whose product description names the listing, so it classifies as earphones. */
const detailHtml = (title: string) =>
  `<html><head><meta name="description" content="${title} 完全ワイヤレスイヤホンの中古商品です。"></head><body><h1>${title}</h1></body></html>`;
let targetTitle = "";

function listing(sourceId: string, manufacturer: string, model: string): NormalizedCatalogProduct {
  return normalizeCatalogProduct(
    parsedProduct({
      sourceId,
      manufacturer,
      model,
      title: `${manufacturer} ${model}`,
      sourceUrl: `https://www.fujiya-avic.co.jp/shop/g/g${sourceId}/`,
      priceYen: 12_800,
      stockStatus: "in_stock",
    }),
    fujiya.capabilities.catalog,
  );
}

function adapterFor(products: NormalizedCatalogProduct[]): ShopPlugin {
  return {
    ...fujiya,
    capabilities: { ...fujiya.capabilities, transport: { kind: "direct" } },
    discovery: {
      coverage: fujiya.discovery.coverage,
      policy: { ...fujiya.discovery.policy, extraPageBudget: 0 },
      initialTargets: () => [LISTING_PAGE],
    },
    parse: () => products,
    parseWithStages: () => ({ products, rawParseMs: 0, normalizeMs: 0 }),
  } as unknown as ShopPlugin;
}

async function crawl(
  db: ReturnType<typeof migratedSqlite>["db"],
  products: NormalizedCatalogProduct[],
): Promise<{ detailRequests: string[]; status: string }> {
  const detailRequests: string[] = [];
  const env = {
    DB: db,
    FUJIYA_AVIC_REQUEST_DELAY_MS: "0",
    CRAWL_MIN_ITEM_BASELINE: "100000",
  } as unknown as Parameters<typeof crawlShop>[0];
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    const result = await crawlShop(env, adapterFor(products), {
      force: true,
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/robots.txt")) return new Response("nf", { status: 404 });
        if (url === LISTING_PAGE)
          return new Response("<html><body></body></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        detailRequests.push(url);
        return new Response(detailHtml(url.includes("target-1") ? targetTitle : ""), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }) as unknown as typeof fetch,
    });
    return { detailRequests, status: result.status };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

function row(sqlite: ReturnType<typeof migratedSqlite>["sqlite"], sourceId: string) {
  return sqlite
    .prepare(
      `SELECT manufacturer, manufacturer_id, canonical_manufacturer_id, manufacturer_resolution_status,
              classification_status, primary_category_id, last_changed_at
       FROM products WHERE shop_key = ? AND source_id = ?`,
    )
    .get(SHOP, sourceId) as Record<string, unknown>;
}

/**
 * Six crawls of one detail-classified listing. Crawls 3 and 5 put 20 other unclassified listings
 * ahead of it, so the per-crawl detail budget (20) runs out before the listing is reached.
 */
async function crawlSequence(manufacturer: string, model: string) {
  const { sqlite, db } = migratedSqlite();
  const target = listing("target-1", manufacturer, model);
  targetTitle = target.title;
  let filler = 0;
  const fillers = () =>
    Array.from({ length: 20 }, () => {
      filler += 1;
      return listing(`filler-${filler}`, "Zzfiller", `ZF-${filler}`);
    });
  const sequence = [
    [target],
    [target],
    [...fillers(), target],
    [target],
    [...fillers(), target],
    [target],
  ];
  const crawls: Array<Record<string, unknown>> = [];
  for (const products of sequence) {
    const result = await crawl(db, products);
    crawls.push({
      targetFetched: result.detailRequests.some((url) => url.includes("target-1")),
      ...row(sqlite, "target-1"),
    });
  }
  return crawls;
}

for (const [label, manufacturer, model] of [
  ["a resolved", "LUXMAN", "L-505"],
  ["an unresolved", "Example", "EX-1"],
] as const) {
  test(`${label} manufacturer's detail classification survives crawls that run out of detail budget`, async () => {
    const crawls = await crawlSequence(manufacturer, model);
    if (label === "an unresolved")
      assert.equal(crawls[0]!.manufacturer_resolution_status, "unresolved");
    // The first crawl pays for the detail page; every later crawl reuses the stored answer.
    assert.deepEqual(
      crawls.map((crawl) => crawl.targetFetched),
      [true, false, false, false, false, false],
    );
    assert.deepEqual(
      crawls.map((crawl) => crawl.classification_status),
      Array(6).fill("classified"),
    );
    // Once the cached answer is recorded, an unchanged listing is never rewritten again.
    assert.equal(new Set(crawls.slice(1).map((crawl) => crawl.last_changed_at)).size, 1);
  }, 60_000);
}
