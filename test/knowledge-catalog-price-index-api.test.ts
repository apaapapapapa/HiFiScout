import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES } from "../src/api/price-index.js";
import { PUBLIC_API_SCHEMAS } from "../src/api/public-route-contracts.js";
import { loadKnowledgeCatalogPriceIndexes } from "../src/db/knowledge-catalog-price-index-read.js";
import {
  productSearchDetail,
  searchProducts,
} from "../src/db/product-search-price-index-repository.js";
import { asQueryableDatabase, captureDatabase } from "./helpers/d1.js";
import { entityRow, offerRow } from "./helpers/product-search.js";
import { productQuery } from "./helpers/product-query.js";

function priceIndexRow(catalogProductId = 12, askingSampleCount = 4) {
  return {
    catalog_product_id: catalogProductId,
    asking_sample_count: askingSampleCount,
    asking_listing_count: askingSampleCount,
    asking_shop_count: 2,
    latest_asking_observed_at: "2026-09-05T00:00:00.000Z",
    asking_median_yen: 310_000,
    asking_min_yen: 280_000,
    asking_max_yen: 360_000,
    recent_asking_median_yen: 320_000,
    listing_end_sample_count: 2,
    listing_end_median_yen: 300_000,
    sold_out_signal_count: 1,
    deactivated_signal_count: 1,
    last_computed_at: "2026-08-28T00:00:00.000Z",
  };
}

function isPriceIndexRead(sql: string): boolean {
  return /FROM knowledge_catalog_price_indexes/.test(sql);
}

test("price-index public read uses only the persistent projection for requested ids", async () => {
  const db = captureDatabase((statement) =>
    isPriceIndexRead(statement.sql) ? [priceIndexRow()] : [],
  );

  const summaries = await loadKnowledgeCatalogPriceIndexes(db, [12, 12, null]);

  assert.equal(summaries.get(12)?.asking_median_yen, 310_000);
  assert.equal(summaries.get(12)?.recent_asking_median_yen, 320_000);
  const summary = summaries.get(12)!;
  const schema = PUBLIC_API_SCHEMAS.ProductPriceIndexSummary;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(summary).filter((key) => !Object.hasOwn(schema.properties ?? {}, key)),
    [],
    "every serialized price-index field must be declared in the public response contract",
  );
  for (const key of schema.required ?? []) {
    assert.ok(Object.hasOwn(summary, key), `missing required price-index field: ${key}`);
  }
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /FROM knowledge_catalog_price_indexes/);
  assert.match(db.calls[0].sql, /WHERE catalog_product_id IN \(\?\)/);
  assert.doesNotMatch(db.calls[0].sql, /knowledge_catalog_price_index_samples/);
  assert.doesNotMatch(db.calls[0].sql, /knowledge_catalog_price_index_rollup/);
  assert.doesNotMatch(db.calls[0].sql, /ROW_NUMBER|COUNT\(\*\) OVER|GROUP BY/);
  assert.deepEqual(db.calls[0].binds, [12, PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES]);
});

test("price-index public read reports D1 rows at request granularity", async () => {
  const statement = () => ({
    bind: () => statement(),
    async all() {
      return {
        results: [priceIndexRow()],
        meta: { rows_read: 2, rows_written: 0 },
      };
    },
  });
  const db = asQueryableDatabase({ prepare: () => statement() });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    await loadKnowledgeCatalogPriceIndexes(db, [12]);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(JSON.parse(lines.at(-1) || "{}"), {
    event: "price_index_public_read_d1_usage",
    requestedProducts: 1,
    projectionRows: 1,
    rowsRead: 2,
    rowsWritten: 0,
    countedStatements: 1,
    statementCount: 1,
  });
});

test("defensive projection omits an index below the named asking-sample threshold", async () => {
  const db = captureDatabase((statement) =>
    isPriceIndexRead(statement.sql) ? [priceIndexRow(12, 2)] : [],
  );

  const summaries = await loadKnowledgeCatalogPriceIndexes(db, [12]);

  assert.equal(PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES, 3);
  assert.equal(summaries.size, 0);
});

test("product search exposes price_index only for resolved catalog products with enough evidence", async () => {
  const resolved = entityRow({ id: 12, entity_key: "c-12", catalog_product_id: 12 });
  const unresolved = entityRow({
    id: 13,
    entity_key: "l-13",
    entity_kind: "unresolved_listing",
    catalog_product_id: null,
    fallback_listing_id: 13,
  });
  const db = captureDatabase((statement) => {
    if (/SELECT e\.id, e\.entity_key/.test(statement.sql)) return [resolved, unresolved];
    if (isPriceIndexRead(statement.sql)) return [priceIndexRow(12)];
    return [];
  });

  const response = await searchProducts(db, productQuery("?inStock=false"));

  assert.equal(response.items[0]?.price_index?.asking_sample_count, 4);
  assert.equal(response.items[0]?.price_index?.listing_end_median_yen, 300_000);
  assert.ok(!Object.hasOwn(response.items[1] || {}, "price_index"));
  const priceIndexCall = db.calls.find((statement) => isPriceIndexRead(statement.sql));
  assert.ok(priceIndexCall);
  assert.deepEqual(priceIndexCall.binds, [12, PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES]);
});

test("product detail exposes the same optional price-index contract", async () => {
  const db = captureDatabase((statement) => {
    if (/FROM product_search_entities e WHERE e\.entity_key/.test(statement.sql)) {
      return [entityRow({ id: 12, entity_key: "c-12", catalog_product_id: 12 })];
    }
    if (isPriceIndexRead(statement.sql)) return [priceIndexRow(12)];
    if (/FROM product_search_entity_offers m/.test(statement.sql)) {
      return [offerRow({ listing_product_id: 100, price_yen: 300_000 })];
    }
    return [];
  });

  const detail = await productSearchDetail(db, "c-12");

  assert.ok(detail);
  assert.equal(detail.product.price_index?.asking_median_yen, 310_000);
  assert.equal(detail.product.price_index?.sold_out_signal_count, 1);
  assert.equal(detail.offers.length, 1);
});
