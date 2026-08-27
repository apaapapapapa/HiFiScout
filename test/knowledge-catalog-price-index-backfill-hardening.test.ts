import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { backfillKnowledgeCatalogPriceIndex } from "../src/db/knowledge-catalog-price-index-backfill.js";
import { captureDatabase } from "./helpers/d1.js";

test("backfill accepts zero-price history and rechecks catalog identity inside the cursor transaction", async () => {
  const db = captureDatabase((statement) => {
    if (/SELECT backfill_key, after_price_history_id/.test(statement.sql)) {
      return [
        {
          backfill_key: "review-hardening",
          after_price_history_id: 0,
          status: "running",
          started_at: "2026-08-28T00:00:00.000Z",
          updated_at: "2026-08-28T00:00:00.000Z",
          completed_at: null,
        },
      ];
    }
    if (/FROM price_history ph/.test(statement.sql)) {
      return [
        {
          id: 7,
          listing_product_id: 42,
          shop_key: "hifido",
          source_id: "zero-price",
          price_yen: 0,
          observed_at: "2026-08-28T00:00:00.000Z",
        },
      ];
    }
    return [];
  });

  const result = await backfillKnowledgeCatalogPriceIndex(db, {
    backfillKey: "review-hardening",
    batchSize: 1,
    now: new Date("2026-08-28T01:00:00.000Z"),
  });

  assert.equal(result.selectedCount, 1);
  assert.equal(result.writtenCount, 1);
  const candidateScan = db.calls.find((statement) => /FROM price_history ph/.test(statement.sql));
  assert.ok(candidateScan);
  assert.match(candidateScan.sql, /ph\.price_yen >= 0/);
  assert.doesNotMatch(candidateScan.sql, /pir\.catalog_product_id\s*,/);

  const sampleWrite = db.batched[0];
  assert.ok(sampleWrite);
  assert.match(sampleWrite.sql, /SELECT \?, pir\.catalog_product_id/);
  assert.match(sampleWrite.sql, /FROM product_identity_resolutions pir/);
  assert.match(sampleWrite.sql, /pir\.status = 'matched'/);
  assert.equal(sampleWrite.binds.at(-1), 42, "identity is looked up by listing at commit time");
  assert.ok(sampleWrite.binds.includes(0), "zero is retained as a valid nonnegative asking price");
});
