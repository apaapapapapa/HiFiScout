import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES } from "../src/api/price-index.js";
import { loadKnowledgeCatalogPriceIndexes } from "../src/db/knowledge-catalog-price-index-read.js";
import { captureDatabase } from "./helpers/d1.js";

test("price-index projection exposes only bounded requested-id listing-end observations", async () => {
  const db = captureDatabase(() => [
    {
      catalog_product_id: 12,
      asking_sample_count: 4,
      asking_median_yen: 310_000,
      asking_min_yen: 280_000,
      asking_max_yen: 360_000,
      recent_asking_median_yen: 320_000,
      listing_end_sample_count: 2,
      listing_end_median_yen: 300_000,
      sold_out_signal_count: 1,
      deactivated_signal_count: 1,
      listing_end_observations_json: JSON.stringify([
        {
          price_yen: 295_000,
          observed_at: "2026-08-27T08:00:00.000Z",
          signal_kind: "sold_out",
        },
        {
          price_yen: 305_000,
          observed_at: "2026-08-20T08:00:00.000Z",
          signal_kind: "deactivated",
        },
      ]),
      last_computed_at: "2026-08-28T00:00:00.000Z",
    },
  ]);

  const summaries = await loadKnowledgeCatalogPriceIndexes(db, [12]);
  const summary = summaries.get(12);

  assert.ok(summary);
  assert.deepEqual(summary.listing_end_observations, [
    {
      price_yen: 295_000,
      observed_at: "2026-08-27T08:00:00.000Z",
      signal_kind: "sold_out",
    },
    {
      price_yen: 305_000,
      observed_at: "2026-08-20T08:00:00.000Z",
      signal_kind: "deactivated",
    },
  ]);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /JOIN requested q ON q\.catalog_product_id = s\.catalog_product_id/);
  assert.match(db.calls[0].sql, /WHERE recent_order <= 5/);
  assert.match(db.calls[0].sql, /json_group_array/);
  assert.deepEqual(db.calls[0].binds, [12, PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES]);
});

test("malformed listing-end observation JSON is ignored instead of breaking the API", async () => {
  const db = captureDatabase(() => [
    {
      catalog_product_id: 12,
      asking_sample_count: 3,
      asking_median_yen: 300_000,
      asking_min_yen: 280_000,
      asking_max_yen: 320_000,
      recent_asking_median_yen: null,
      listing_end_sample_count: 1,
      listing_end_median_yen: 290_000,
      sold_out_signal_count: 0,
      deactivated_signal_count: 1,
      listing_end_observations_json: "not-json",
      last_computed_at: "2026-08-28T00:00:00.000Z",
    },
  ]);

  const summary = (await loadKnowledgeCatalogPriceIndexes(db, [12])).get(12);
  assert.ok(summary);
  assert.deepEqual(summary.listing_end_observations, []);
});
