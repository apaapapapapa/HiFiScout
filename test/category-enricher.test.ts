import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { enrichProductCategories } from "../src/crawler/category-enricher.js";
import { extractFujiyaDetailCategoryEvidence } from "../src/crawler/shops/fujiya-avic.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { CategoryEnrichmentProductRow } from "../src/db/types.js";
import { detailFetchOptions, emptyCatalogDb, parsedProduct } from "./helpers/fixtures.js";

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
  assert.equal(classified.primaryCategoryId, "cd_sacd_player");
  assert.deepEqual(classified.categoryIds, ["cd_sacd_player"]);
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
    [["integrated_amp"]],
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
  const existingRows: CategoryEnrichmentProductRow[] = [
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
          version: 3,
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
  assert.equal(result.products[0].primaryCategoryId, "cd_sacd_player");
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
