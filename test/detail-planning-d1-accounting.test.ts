import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { planStagedCategoryDetailFetchesWithDbUsage } from "../src/crawler/category-enrichment-pacing.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { NormalizedCatalogProduct } from "../src/catalog/types.js";
import { accountReads } from "../src/db/read-accounting.js";
import { hasCrawlFetchDetailPage } from "../src/db/crawl-fetch-detail-repository.js";
import { asQueryableDatabase } from "./helpers/d1.js";
import { parsedProduct } from "./helpers/fixtures.js";

const loadedPlugin = getShopPlugin("fujiya-avic");
if (!loadedPlugin) throw new Error("fujiya-avic plugin missing");
const plugin = loadedPlugin;

function pluginWithBudget(maxRequestsPerCrawl: number) {
  return {
    ...plugin,
    capabilities: {
      ...plugin.capabilities,
      catalog: {
        ...plugin.capabilities.catalog,
        categoryPolicy: {
          ...plugin.capabilities.catalog?.categoryPolicy,
          enrichment: { maxRequestsPerCrawl, cacheHours: 168 },
        },
      },
    },
  };
}

function products(count: number): NormalizedCatalogProduct[] {
  return Array.from({ length: count }, (_, index) =>
    normalizeCatalogProduct(
      parsedProduct({
        sourceId: `source-${index}`,
        manufacturer: "Example",
        model: `MODEL-${index}`,
        title: `Example MODEL-${index}`,
        rawCategory: "unknown seller category",
        sourceUrl: `https://www.fujiya-avic.co.jp/shop/g/gsource-${index}/`,
      }),
      plugin.capabilities.catalog,
    ),
  );
}

/** D1 double whose meta reports the rows each real planning statement logically examines. */
function planningDatabase(staged: readonly NormalizedCatalogProduct[]) {
  const stagedPages = staged.map((product, index) => ({
    page_key: `page-${index}`,
    products_json: JSON.stringify([product]),
  }));
  const build = (sql: string, binds: unknown[]) => ({
    bind: (...next: unknown[]) => build(sql, next),
    async all() {
      let results: unknown[] = [];
      let rowsRead = 0;
      if (/FROM crawl_fetch_pages/u.test(sql)) {
        results = stagedPages;
        rowsRead = stagedPages.length;
      } else if (/FROM knowledge_catalog_manufacturer_aliases/u.test(sql)) {
        // Reference evidence is independent of detail target count and staged cardinality.
        rowsRead = 7;
      } else if (/FROM products/u.test(sql)) {
        // The unique source ids in this bounded chunk are the only listing rows examined.
        rowsRead = Math.max(0, binds.length - 1);
      }
      return { results, meta: { rows_read: rowsRead, rows_written: 0 } };
    },
  });
  return asQueryableDatabase({
    prepare: (sql: string) => build(sql, []),
    async batch() {
      throw new Error("planning must not write or batch statements");
    },
  });
}

test("planning rows read do not grow with detail target count", async () => {
  const staged = products(100);
  const observations = [];
  for (const targetCount of [1, 10, 100]) {
    const plan = await planStagedCategoryDetailFetchesWithDbUsage(
      { DB: planningDatabase(staged) },
      pluginWithBudget(targetCount),
      `run-targets-${targetCount}`,
      new Date("2026-09-03T00:00:00.000Z"),
    );
    observations.push(plan.dbUsage);
    assert.equal(plan.targets.length, targetCount);
    assert.equal(plan.dbUsage.stagedRowsRead, staged.length);
  }

  assert.deepEqual(
    observations.map((usage) => usage.rowsRead),
    [207, 207, 207],
    "S is fixed, so changing M must not repeat staged, catalog, or existing-listing reads",
  );
});

test("planning rows read scale with staged input, not staged input times target count", async () => {
  const observations = [];
  for (const stagedCount of [5, 50, 150]) {
    const plan = await planStagedCategoryDetailFetchesWithDbUsage(
      { DB: planningDatabase(products(stagedCount)) },
      pluginWithBudget(3),
      `run-staged-${stagedCount}`,
      new Date("2026-09-03T00:00:00.000Z"),
    );
    observations.push({ stagedCount, plan });
    assert.equal(plan.targets.length, 3);
    assert.equal(plan.dbUsage.stagedRowsRead, stagedCount);
    assert.equal(plan.dbUsage.existingListingRowsRead, stagedCount);
    assert.equal(plan.dbUsage.catalogRowsRead, 7);
    assert.equal(plan.dbUsage.rowsRead, stagedCount * 2 + 7);
    assert.equal(plan.dbUsage.rowsWritten, 0);
  }

  assert.deepEqual(
    observations.map(({ plan }) => plan.dbUsage.rowsRead),
    [17, 107, 307],
  );
});

test("indexed detail fence accounting is linear in targets and independent of staged size", async () => {
  const fenceDb = asQueryableDatabase({
    prepare(sql: string) {
      assert.match(sql, /FROM crawl_fetch_pages/u);
      return {
        bind() {
          return {
            async all() {
              return {
                results: [],
                meta: { rows_read: 1, rows_written: 0 },
              };
            },
          };
        },
      };
    },
  });

  for (const targetCount of [1, 10, 100]) {
    const accounting = accountReads(fenceDb);
    for (let index = 0; index < targetCount; index += 1) {
      await hasCrawlFetchDetailPage(
        accounting.db,
        "run-fence",
        `https://shop.test/detail/${index}`,
      );
    }
    assert.equal(accounting.rowsRead(), targetCount);
    assert.equal(accounting.statementCount(), targetCount);
  }
});
