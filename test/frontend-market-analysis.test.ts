import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { isProductMarketAnalysis } from "../frontend/market-analysis.js";
import { calculateMarketAnalysis } from "../src/catalog/market-analysis.js";

test("market response guards reject oversized, duplicate, sparse-price and invalid-date claims", () => {
  const ready = calculateMarketAnalysis([], new Map(), [], new Date("2026-09-07T00:00:00Z"));
  assert.ok(isProductMarketAnalysis(ready));
  assert.ok(!isProductMarketAnalysis({ ...ready, as_of: "not a date" }));
  assert.ok(!isProductMarketAnalysis({ ...ready, months: [...ready.months, ready.months[0]] }));
  assert.ok(!isProductMarketAnalysis({ ...ready, months: Array.from({ length: 6 }, () => ready.months[0]) }));
  const sparse = { ...ready.months[0], median_yen: 100 };
  assert.ok(!isProductMarketAnalysis({ ...ready, months: [sparse, ...ready.months.slice(1)] }));
  assert.ok(!isProductMarketAnalysis({ ...ready, current_conditions: [{ ...ready.months[0], condition: "excellent", sale_unit: "pair" }] }));
  assert.ok(isProductMarketAnalysis({ ...ready, status: "limited", months: [] }));
  assert.ok(!isProductMarketAnalysis({ ...ready, status: "limited" }));
});
