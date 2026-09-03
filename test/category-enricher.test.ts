import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  CATEGORY_CLASSIFICATION_METADATA_VERSION,
  normalizeCatalogProduct,
} from "../src/catalog/product-normalizer.js";
import { enrichProductCategories } from "../src/crawler/category-enricher.js";
import { extractFujiyaDetailCategoryEvidence } from "../src/crawler/shops/fujiya-avic.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import {
  selectExistingCategoryEnrichmentStates,
  selectExistingProducts,
} from "../src/db/product-write-repository.js";
import type { ExistingCategoryEnrichmentState } from "../src/db/types.js";
import { detailFetchOptions, emptyCatalogDb, parsedProduct } from "./helpers/fixtures.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const fujiyaAvicPlugin = getShopPlugin("fujiya-avic");
if (!fujiyaAvicPlugin) throw new Error("fujiya-avic plugin missing");

test("Fujiya unresolved model is classified from product-specific detail evidence", async () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      sourceId: "d10x",
      manufacturer: "LUXMAN",
      model: "D-10X",
      title: "LUXMAN D-10X",
      rawCategory: "DAP",
      sourceUrl: "https://www.fujiya-avic.co.jp/shop/g/gd10x/",
    }),
    fujiyaAvicPlugin.capabilities.catalog,
  );
  assert.equal(product.classificationStatus, "unclassified");
  const result = await enrichProductCategories({
    db: emptyCatalogDb(),
    adapter: fujiyaAvicPlugin,
    products: [product],
    existingRows: [],
    transport: {
      async fetchHtmlPage() {
        return '<html><head><meta name="description" content="LUXMAN D-10X フラグシップSACD/CDプレーヤーの中古商品です。"></head><body><h1>D-10X</h1></body></html>';
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-11T10:00:00Z"),
  });
  const [classified] = result.products;
  assert.equal(classified.primaryCategoryId, "SRC.DISC");
  assert.deepEqual(classified.categoryIds, ["SRC.DISC"]);
  assert.equal(classified.classificationStatus, "classified");
  assert.equal(result.detailRequests, 1);
  assert.equal(result.enrichedCount, 1);
  assert.equal(
    classified.metadata.categoryClassification.detailCheckedAt,
    "2026-08-11T10:00:00.000Z",
  );
});

test("Fujiya detail extraction stops at product-specific metadata and ignores related-product mentions later in the page", () => {
  const evidence = extractFujiyaDetailCategoryEvidence(
    `
    <html><head><meta name="description" content="MODEL10/FB Marantzのプリメインアンプです。"></head>
    <body><h1>MODEL10/FB</h1><p>MODEL10はプリメインアンプです。</p><section>組み合わせにはSACD 10 SACDプレーヤーがおすすめです。</section></body></html>
  `,
    { model: "MODEL10/FB" },
  );
  assert.deepEqual(
    evidence.map((item) => item.categoryIds),
    [["AMP.INTEGRATED"]],
  );
});

test("cached detail classification is reused for the same product identity without another request", async () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      sourceId: "d10x",
      manufacturer: "LUXMAN",
      model: "D-10X",
      title: "LUXMAN D-10X",
      rawCategory: "DAP",
      sourceUrl: "https://www.fujiya-avic.co.jp/shop/g/gd10x/",
    }),
    fujiyaAvicPlugin.capabilities.catalog,
  );
  const existingRows: ExistingCategoryEnrichmentState[] = [
    {
      source_id: "d10x",
      manufacturer_id: product.manufacturerId,
      model: "D-10X",
      title: "LUXMAN D-10X",
      category: "CD/SACDプレーヤー",
      primary_category_id: "cd_sacd_player",
      category_ids: '["cd_sacd_player"]',
      classification_status: "classified",
      search_aliases: "CD/SACDプレーヤー cd player sacd player",
      metadata_json: JSON.stringify({
        categoryClassification: {
          version: CATEGORY_CLASSIFICATION_METADATA_VERSION,
          state: "classified",
          detailCheckedAt: "2026-08-10T10:00:00.000Z",
        },
      }),
    },
  ];
  const result = await enrichProductCategories({
    db: emptyCatalogDb(),
    adapter: fujiyaAvicPlugin,
    products: [product],
    existingRows,
    transport: {
      async fetchHtmlPage() {
        throw new Error("detail fetch must not run");
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-11T10:00:00Z"),
  });
  assert.equal(result.detailRequests, 0);
  assert.equal(result.cacheHits, 1);
  assert.equal(result.products[0].primaryCategoryId, "SRC.DISC");
});

test("successful unresolved detail checks are cached briefly, but fetch failures remain retryable", async () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      sourceId: "unknown",
      manufacturer: "Example",
      model: "ABC-123",
      title: "Example ABC-123",
      rawCategory: "DAP",
      sourceUrl: "https://www.fujiya-avic.co.jp/shop/g/gunknown/",
    }),
    fujiyaAvicPlugin.capabilities.catalog,
  );
  const checked = await enrichProductCategories({
    db: emptyCatalogDb(),
    adapter: fujiyaAvicPlugin,
    products: [product],
    existingRows: [],
    transport: {
      async fetchHtmlPage() {
        return "<html><body><h1>ABC-123</h1><p>中古商品です。</p></body></html>";
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-11T10:00:00Z"),
  });
  assert.equal(checked.products[0].classificationStatus, "unclassified");
  assert.equal(
    checked.products[0].metadata.categoryClassification.detailCheckedAt,
    "2026-08-11T10:00:00.000Z",
  );
  const failed = await enrichProductCategories({
    db: emptyCatalogDb(),
    adapter: fujiyaAvicPlugin,
    products: [product],
    existingRows: [],
    transport: {
      async fetchHtmlPage() {
        throw new Error("temporary failure");
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-11T11:00:00Z"),
  });
  assert.equal(failed.detailRequests, 1);
  assert.equal(failed.products[0].metadata.categoryClassification.detailCheckedAt, undefined);
});

test("lightweight existing rows preserve cache, identity, budget, and target sequence", async () => {
  const cached = normalizeCatalogProduct(
    parsedProduct({
      sourceId: "cached",
      manufacturer: "LUXMAN",
      model: "D-10X",
      title: "LUXMAN D-10X",
      rawCategory: "DAP",
      sourceUrl: "https://www.fujiya-avic.co.jp/shop/g/gcached/",
    }),
    fujiyaAvicPlugin.capabilities.catalog,
  );
  const uncached = normalizeCatalogProduct(
    parsedProduct({
      sourceId: "uncached",
      manufacturer: "Example",
      model: "UNKNOWN-1",
      title: "Example UNKNOWN-1",
      rawCategory: "DAP",
      sourceUrl: "https://www.fujiya-avic.co.jp/shop/g/guncached/",
    }),
    fujiyaAvicPlugin.capabilities.catalog,
  );
  const { sqlite, db } = migratedSqlite();
  sqlite
    .prepare(`
      INSERT INTO products(
        shop_key, source_id, manufacturer, manufacturer_id, model, title, category,
        primary_category_id, category_ids, classification_status, search_aliases, metadata_json,
        source_url, first_seen_at, last_seen_at, last_changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      fujiyaAvicPlugin.key,
      cached.sourceId,
      cached.manufacturer,
      cached.manufacturerId,
      cached.model,
      cached.title,
      "CD/SACDプレーヤー",
      "cd_sacd_player",
      '["cd_sacd_player"]',
      "classified",
      "CD/SACDプレーヤー cd player sacd player",
      JSON.stringify({
        categoryClassification: {
          version: CATEGORY_CLASSIFICATION_METADATA_VERSION,
          state: "classified",
          detailCheckedAt: "2026-08-10T10:00:00.000Z",
        },
      }),
      cached.sourceUrl,
      "2026-08-10T10:00:00.000Z",
      "2026-08-10T10:00:00.000Z",
      "2026-08-10T10:00:00.000Z",
    );

  const sourceIds = [cached.sourceId, uncached.sourceId];
  const [fullRows, lightweightRows] = await Promise.all([
    selectExistingProducts(db, fujiyaAvicPlugin.key, sourceIds),
    selectExistingCategoryEnrichmentStates(db, fujiyaAvicPlugin.key, sourceIds),
  ]);
  const run = async (existingRows: ExistingCategoryEnrichmentState[]) => {
    const targets: string[] = [];
    const result = await enrichProductCategories({
      db,
      adapter: fujiyaAvicPlugin,
      products: [cached, uncached],
      existingRows,
      transport: {
        async fetchHtmlPage(url) {
          targets.push(url);
          return "<html><body><h1>UNKNOWN-1</h1><p>中古商品です。</p></body></html>";
        },
      },
      fetchOptions: detailFetchOptions(),
      now: new Date("2026-08-11T10:00:00Z"),
    });
    return { result, targets };
  };

  const before = await run(fullRows);
  const after = await run(lightweightRows);

  assert.deepEqual(after.targets, before.targets);
  assert.equal(after.result.detailRequests, before.result.detailRequests);
  assert.equal(after.result.cacheHits, before.result.cacheHits);
  assert.deepEqual(after.result.products, before.result.products);
});
