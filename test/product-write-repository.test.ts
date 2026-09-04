import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  deactivateProductsBySourceIds,
  selectExistingCategoryEnrichmentStates,
  selectExistingProducts,
  selectProductsForHistory,
  upsertProducts,
} from "../src/db/product-write-repository.js";
import type { CatalogProductUpsertInput } from "../src/catalog/types.js";
import { captureDatabase } from "./helpers/d1.js";
import type { CapturedStatement } from "./helpers/d1.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { queryPlan, readsThroughIndex, recordingDatabase } from "./helpers/query-plan.js";

type ExistingFixture = Record<string, unknown> & { id: number; source_id: string };

/** Replays the three lookups `upsertProducts()` performs against a single existing listing. */
function upsertResults(existing: ExistingFixture | null) {
  const rows = existing ? [existing] : [];
  return (statement: CapturedStatement) => {
    if (/SELECT id, source_id, manufacturer/.test(statement.sql)) return rows;
    if (/SELECT id, source_id FROM products/.test(statement.sql)) {
      return existing ? [{ id: existing.id, source_id: existing.source_id }] : [];
    }
    if (/SELECT id, source_id, price_yen/.test(statement.sql)) return rows;
    return [];
  };
}

test("history lookup chunks large source-id sets below D1 variable limits", async () => {
  const db = captureDatabase();
  const ids = Array.from({ length: 1001 }, (_, index) => `source-${index}`);

  await selectProductsForHistory(db, "fujiya-avic", ids, 50);

  assert.equal(db.calls.length, 21);
  assert.ok(db.calls.every((call) => call.binds.length <= 51));
  assert.ok(db.calls.every((call) => /source_id IN/.test(call.sql)));
});

test("existing product lookup only reads source ids observed in the current crawl", async () => {
  const db = captureDatabase();
  await selectExistingProducts(db, "hifido", ["a", "b"]);

  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].binds, ["hifido", "a", "b"]);
  assert.match(db.calls[0].sql, /source_id IN \(\?,\?\)/);
  assert.doesNotMatch(db.calls[0].sql, /WHERE shop_key = \?\s*$/m);
});

test("category enrichment lookup selects only its ten decision fields", async () => {
  const lightweight = captureDatabase();
  const full = captureDatabase();

  await selectExistingCategoryEnrichmentStates(lightweight, "hifido", ["a", "b"]);
  await selectExistingProducts(full, "hifido", ["a", "b"]);

  const lightweightSql = lightweight.calls[0]?.sql || "";
  const fullSql = full.calls[0]?.sql || "";
  const projection = lightweightSql
    .slice(
      lightweightSql.indexOf("SELECT") + "SELECT".length,
      lightweightSql.lastIndexOf("FROM products"),
    )
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  const fullProjection = fullSql
    .slice(fullSql.indexOf("SELECT") + "SELECT".length, fullSql.lastIndexOf("FROM products"))
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);

  assert.deepEqual(projection, [
    "source_id",
    "title",
    "model",
    "manufacturer_id",
    "category",
    "primary_category_id",
    "category_ids",
    "classification_status",
    "search_aliases",
    "metadata_json",
  ]);
  assert.ok(projection.length < fullProjection.length);
  assert.doesNotMatch(lightweightSql, /product_admin_overrides|price_yen|stock_status/u);
});

test("category enrichment lookup deduplicates source ids before bounded chunking", async () => {
  const db = captureDatabase();

  await selectExistingCategoryEnrichmentStates(db, "hifido", ["a", "a", "b", "b"], 1);

  assert.equal(db.calls.length, 2);
  assert.deepEqual(
    db.calls.map((call) => call.binds),
    [
      ["hifido", "a"],
      ["hifido", "b"],
    ],
  );
});

test("category enrichment lookup uses the existing shop/source identity index", async () => {
  const { sqlite, db } = migratedSqlite();
  sqlite
    .prepare(`
      INSERT INTO products(
        shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at
      ) VALUES ('hifido', 'a', 'A', 'https://shop.test/a', '2026-09-03', '2026-09-03', '2026-09-03')
    `)
    .run();
  const recording = recordingDatabase(db);

  await selectExistingCategoryEnrichmentStates(recording.db, "hifido", ["a"]);

  const statement = recording.executed[0];
  assert.ok(statement);
  assert.ok(
    readsThroughIndex(queryPlan(sqlite, statement), "products", "sqlite_autoindex_products_1"),
  );
});

test("missing products are deactivated in bounded source-id chunks", async () => {
  const db = captureDatabase();
  const ids = Array.from({ length: 121 }, (_, index) => `source-${index}`);

  const changed = await deactivateProductsBySourceIds(db, "formusic", ids, 50);

  assert.equal(changed, 3);
  assert.equal(db.calls.length, 3);
  assert.ok(db.calls.every((call) => call.binds.length <= 51));
  assert.ok(db.calls.every((call) => /source_id IN/.test(call.sql)));
  assert.ok(db.calls.every((call) => /is_active = 1/.test(call.sql)));
});

test("new listings persist raw and resolved fields with a valid bind shape", async () => {
  const product: CatalogProductUpsertInput = {
    sourceId: "p1",
    manufacturer: "TAD",
    rawManufacturer: "Technical Audio Devices",
    normalizedRawManufacturer: "technicalaudiodevices",
    manufacturerId: "tad",
    manufacturerResolutionStatus: "resolved",
    manufacturerResolutionMethod: "verified_alias",
    manufacturerResolutionConfidence: "high",
    model: "D1000 MK2",
    rawModel: "D-1000 MKII",
    normalizedModel: "D1000MK2",
    modelResolutionStatus: "resolved",
    modelResolutionMethod: "seller_model",
    modelResolutionConfidence: "medium",
    title: "TAD D-1000 MKII",
    category: "CD/SACD player",
    rawCategory: "SACD",
    primaryCategoryId: "cd_sacd_player",
    classificationStatus: "classified",
    conditionText: "used",
    priceYen: 1000000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/p1",
  };
  const db = captureDatabase(upsertResults(null));

  await upsertProducts(db, "hifido", [product], "2026-08-15T00:00:00.000Z");

  const insert = db.batched.find((statement) => /INSERT INTO products/.test(statement.sql));
  assert.ok(insert);
  assert.equal((insert.sql.match(/\?/g) || []).length, insert.binds.length);
  assert.match(insert.sql, /raw_manufacturer, normalized_raw_manufacturer/);
  assert.match(insert.sql, /canonical_manufacturer_id, manufacturer_resolution_status/);
  assert.match(insert.sql, /model, raw_model, normalized_model/);
  assert.ok(insert.binds.includes("Technical Audio Devices"));
  assert.ok(insert.binds.includes("D-1000 MKII"));
});

test("unchanged products are not rewritten on every crawl", async () => {
  const product: CatalogProductUpsertInput = {
    sourceId: "p1",
    manufacturer: "TAD",
    model: "ME1TX",
    title: "ME1TX",
    category: "スピーカー",
    conditionText: "中古",
    priceYen: 1000000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/p1",
  };
  const existing = {
    id: 1,
    source_id: "p1",
    manufacturer: "TAD",
    model: "ME1TX",
    title: "ME1TX",
    category: "スピーカー",
    condition_text: "中古",
    price_yen: 1000000,
    stock_status: "in_stock",
    source_url: "https://example.test/p1",
    last_seen_at: "2026-08-11T00:00:00.000Z",
    is_active: 1,
  };
  const db = captureDatabase(upsertResults(existing));

  const result = await upsertProducts(db, "hifido", [product], "2026-08-11T00:30:00.000Z", {
    touchIntervalMinutes: 1440,
  });

  assert.equal(result.changedCount, 0);
  assert.equal(result.activityCount, 0);
  assert.equal(result.touchedCount, 0);
  assert.equal(db.batched.length, 0);
});

test("unchanged products receive a low-frequency last-seen heartbeat", async () => {
  const product: CatalogProductUpsertInput = {
    sourceId: "p1",
    manufacturer: "TAD",
    model: "ME1TX",
    title: "ME1TX",
    category: "スピーカー",
    conditionText: "中古",
    priceYen: 1000000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/p1",
  };
  const existing = {
    id: 1,
    source_id: "p1",
    manufacturer: "TAD",
    model: "ME1TX",
    title: "ME1TX",
    category: "スピーカー",
    condition_text: "中古",
    price_yen: 1000000,
    stock_status: "in_stock",
    source_url: "https://example.test/p1",
    last_seen_at: "2026-08-09T00:00:00.000Z",
    is_active: 1,
  };
  const db = captureDatabase(upsertResults(existing));

  const result = await upsertProducts(db, "hifido", [product], "2026-08-11T00:30:00.000Z", {
    touchIntervalMinutes: 1440,
  });

  assert.equal(result.changedCount, 0);
  assert.equal(result.activityCount, 0);
  assert.equal(result.touchedCount, 1);
  assert.equal(db.batched.length, 1);
  assert.match(db.batched[0].sql, /last_seen_at/);
});

test("catalog normalization changes do not create user-facing activity", async () => {
  const existing = {
    id: 1,
    source_id: "p1",
    manufacturer: "TAD",
    raw_manufacturer: "TAD",
    manufacturer_id: "tad",
    model: "D100",
    title: "D100",
    category: "その他",
    raw_category: "プレーヤー",
    primary_category_id: "other",
    category_ids: '["other"]',
    classification_status: "unclassified",
    search_aliases: "その他 other",
    condition_text: "中古",
    price_yen: 500000,
    stock_status: "in_stock",
    source_url: "https://example.test/p1",
    last_seen_at: "2026-08-11T00:00:00.000Z",
    is_active: 1,
  };
  const product: CatalogProductUpsertInput = {
    sourceId: "p1",
    manufacturer: "TAD",
    rawManufacturer: "TAD",
    manufacturerId: "tad",
    model: "D100",
    title: "D100",
    category: "CD/SACDプレーヤー",
    rawCategory: "プレーヤー",
    primaryCategoryId: "cd_sacd_player",
    categoryIds: ["cd_sacd_player"],
    classificationStatus: "classified",
    searchAliases: "CD/SACDプレーヤー cd player sacd player",
    conditionText: "中古",
    priceYen: 500000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/p1",
  };
  const db = captureDatabase(upsertResults(existing));

  const result = await upsertProducts(db, "hifido", [product], "2026-08-11T01:00:00.000Z");

  assert.equal(result.changedCount, 1);
  assert.equal(result.activityCount, 0);
  assert.ok(db.batched.some((statement) => /UPDATE products SET/.test(statement.sql)));
  assert.ok(db.batched.some((statement) => /product_categories/.test(statement.sql)));
});

test("seller-visible listing changes create user-facing activity", async () => {
  const existing = {
    id: 1,
    source_id: "p1",
    manufacturer: "TAD",
    raw_manufacturer: "TAD",
    manufacturer_id: "tad",
    model: "ME1TX",
    title: "ME1TX",
    category: "スピーカー",
    raw_category: "スピーカー",
    primary_category_id: "speaker",
    category_ids: '["speaker"]',
    classification_status: "classified",
    search_aliases: "スピーカー speaker",
    condition_text: "中古 A",
    price_yen: 1000000,
    stock_status: "in_stock",
    source_url: "https://example.test/p1",
    last_seen_at: "2026-08-11T00:00:00.000Z",
    is_active: 1,
  };
  const product: CatalogProductUpsertInput = {
    sourceId: "p1",
    manufacturer: "TAD",
    rawManufacturer: "TAD",
    manufacturerId: "tad",
    model: "ME1TX",
    title: "ME1TX",
    category: "スピーカー",
    rawCategory: "スピーカー",
    primaryCategoryId: "speaker",
    categoryIds: ["speaker"],
    classificationStatus: "classified",
    searchAliases: "スピーカー speaker",
    conditionText: "中古 B",
    priceYen: 1000000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/p1",
  };
  const db = captureDatabase(upsertResults(existing));

  const result = await upsertProducts(db, "fujiya-avic", [product], "2026-08-11T01:00:00.000Z");

  assert.equal(result.changedCount, 1);
  assert.equal(result.activityCount, 1);
  const update = db.batched.find((statement) => /UPDATE products SET/.test(statement.sql));
  assert.ok(update);
  assert.match(update.sql, /last_activity_at = CASE WHEN \? THEN \? ELSE last_activity_at END/);
});
