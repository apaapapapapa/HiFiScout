import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { CatalogProductUpsertInput } from "../src/catalog/types.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import type { CapturedStatement } from "./helpers/d1.js";

function existingResult(existing: Record<string, unknown>) {
  return (statement: CapturedStatement) => {
    if (/FROM products p\s+LEFT JOIN product_admin_overrides/.test(statement.sql))
      return [existing];
    return [];
  };
}

test("manual presentation color authority prevents crawler-only color churn", async () => {
  const product: CatalogProductUpsertInput = {
    sourceId: "p1",
    manufacturer: "TAD",
    model: "ME1TX",
    presentationColor: "シルバー",
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
    presentation_color: "ブラック",
    override_presentation_color: "ブラック",
    title: "ME1TX",
    category: "スピーカー",
    condition_text: "中古",
    price_yen: 1000000,
    stock_status: "in_stock",
    source_url: "https://example.test/p1",
    last_seen_at: "2026-08-11T00:00:00.000Z",
    is_active: 1,
  };
  const db = captureDatabase(existingResult(existing));

  const result = await upsertProducts(db, "hifido", [product], "2026-08-11T00:30:00.000Z", {
    touchIntervalMinutes: 1440,
  });

  assert.equal(result.changedCount, 0);
  assert.equal(result.activityCount, 0);
  assert.equal(result.touchedCount, 0);
  assert.deepEqual(result.derivedSourceIds, []);
  assert.equal(db.batched.length, 0);
});
