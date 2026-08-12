import assert from "node:assert/strict";
import test from "node:test";
import { retentionCutoffs } from "../src/maintenance.js";

test("retention cutoffs use conservative operational defaults", () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  const result = retentionCutoffs({}, now);

  assert.equal(result.settings.crawlRunRetentionDays, 30);
  assert.equal(result.settings.dataQualityRetentionDays, 180);
  assert.equal(result.settings.priceHistoryRetentionDays, 1095);
  assert.equal(result.settings.inactiveProductRetentionDays, 365);
  assert.equal(result.settings.deleteBatchSize, 500);
  assert.equal(result.crawlRunsBefore, "2026-07-12T00:00:00.000Z");
  assert.equal(result.dataQualityBefore, "2026-02-12T00:00:00.000Z");
  assert.equal(result.inactiveProductsBefore, "2025-08-11T00:00:00.000Z");
});

test("retention delete batches are capped at 1000 rows", () => {
  const result = retentionCutoffs(
    { RETENTION_DELETE_BATCH_SIZE: "5000" },
    new Date("2026-08-11T00:00:00.000Z"),
  );
  assert.equal(result.settings.deleteBatchSize, 1000);
});
