import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { isProductMarketAnalysis } from "../frontend/market-analysis.js";
import { calculateMarketAnalysis } from "../src/catalog/market-analysis.js";

test("market response guards reject oversized, duplicate, sparse-price and invalid-date claims", () => {
  const ready = calculateMarketAnalysis([], new Map(), [], new Date("2026-09-07T00:00:00Z"));
  assert.ok(isProductMarketAnalysis(ready));
  assert.ok(!isProductMarketAnalysis({ ...ready, as_of: "not a date" }));
  assert.ok(!isProductMarketAnalysis({ ...ready, months: [...ready.months, ready.months[0]] }));
  assert.ok(
    !isProductMarketAnalysis({
      ...ready,
      months: Array.from({ length: 6 }, () => ready.months[0]),
    }),
  );
  const sparse = { ...ready.months[0], median_yen: 100 };
  assert.ok(!isProductMarketAnalysis({ ...ready, months: [sparse, ...ready.months.slice(1)] }));
  assert.ok(
    !isProductMarketAnalysis({
      ...ready,
      current_conditions: [{ ...ready.months[0], condition: "excellent", sale_unit: "pair" }],
    }),
  );
  assert.ok(isProductMarketAnalysis({ ...ready, status: "limited", months: [] }));
  assert.ok(!isProductMarketAnalysis({ ...ready, status: "limited" }));
});

test("market intervals must belong to their month and counts respect the full scope", () => {
  const at = "2026-09-07T00:00:00Z";
  const ready = calculateMarketAnalysis([], new Map(), [], new Date(at));
  const misplaced = {
    ...ready.months[0],
    listing_count: 1,
    shop_count: 1,
    first_observed_at: at,
    last_observed_at: at,
  };
  const months = [misplaced, ...ready.months.slice(1)];
  assert.ok(!isProductMarketAnalysis({ ...ready, months }));
  const group = {
    ...misplaced,
    condition: "used",
    sale_unit: "pair",
    listing_count: 201,
    shop_count: 2,
    min_yen: 100,
    median_yen: 100,
    max_yen: 100,
  };
  assert.ok(!isProductMarketAnalysis({ ...ready, current_conditions: [group] }));
  const excessive = ready.months.map((month) => ({ ...month, sold_out_listings: 100 }));
  assert.ok(!isProductMarketAnalysis({ ...ready, months: excessive }));
});
