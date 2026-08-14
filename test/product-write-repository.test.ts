import test from "node:test";
import assert from "node:assert/strict";
import {
  deactivateProductsBySourceIds,
  selectExistingProducts,
  selectProductsForHistory,
  upsertProducts,
} from "../src/db/product-write-repository.js";
import type { CatalogProductUpsertInput } from "../src/catalog/types.js";
import { captureDatabase } from "./helpers/d1.js";
import type { CapturedStatement } from "./helpers/d1.js";

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

  const result = await upsertProducts(db, "hifido", [product], "2026-08-11T01:00:00.000Z");

  assert.equal(result.changedCount, 1);
  assert.equal(result.activityCount, 1);
  const update = db.batched.find((statement) => /UPDATE products SET/.test(statement.sql));
  assert.ok(update);
  assert.match(update.sql, /last_activity_at = CASE WHEN \? THEN \? ELSE last_activity_at END/);
});
