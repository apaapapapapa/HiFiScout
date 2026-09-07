import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createApiClient } from "../frontend/api-client.js";
import { product, offer } from "../e2e/tests/product-fixtures.js";
import {
  MAX_WATCH_REFRESH,
  captureWatchObservation,
  compareWatchObservations,
  mergeWatchObservations,
  parseWatchObservations,
  refreshWatchedProducts,
} from "../frontend/watch-changes.js";
import type { WatchObservation } from "../frontend/watch-changes.js";
import type { ProductDetailResponse } from "../frontend/types.js";

const AT = "2026-09-07T00:00:00Z";
const before: WatchObservation = {
  key: "c-1",
  checkedAt: AT,
  complete: true,
  offers: [
    { id: 1, shopKey: "one", priceYen: 100, stock: "in_stock" },
    { id: 2, shopKey: "two", priceYen: 200, stock: "in_stock" },
  ],
};

test("revisit changes separate asking prices, sold-out signals and unconfirmed disappearance", () => {
  const after: WatchObservation = {
    ...before,
    offers: [
      { id: 1, shopKey: "one", priceYen: 90, stock: "sold_out" },
      { id: 3, shopKey: "three", priceYen: 150, stock: "in_stock" },
    ],
  };
  assert.deepEqual(
    compareWatchObservations(before, after).map((change) => change.kind),
    ["price", "sold_out", "new", "missing"],
  );
  assert.deepEqual(compareWatchObservations(undefined, after), []);
  assert.equal(
    compareWatchObservations(before, { ...after, complete: false }).some(
      (change) => change.kind === "missing",
    ),
    false,
  );
  assert.equal(
    compareWatchObservations({ ...before, complete: false }, after).some(
      (change) => change.kind === "new",
    ),
    false,
  );
  assert.equal(
    compareWatchObservations(before, {
      ...after,
      offers: [{ ...after.offers[0], priceYen: null }],
    }).some((change) => change.kind === "price"),
    false,
  );
  assert.deepEqual(compareWatchObservations(before, { ...after, key: "l-1" }), []);
});

test("capped details stay partial and failed or old updates preserve prior observations", () => {
  const detail = {
    product: product({ offer_count: 200 }),
    offers: Array.from({ length: 200 }, (_, index) => offer({ listing_product_id: index + 1 })),
  } as unknown as ProductDetailResponse;
  const captured = captureWatchObservation(detail, AT);
  assert.equal(captured.complete, false);
  assert.deepEqual(parseWatchObservations(JSON.stringify([before])), [before]);
  assert.deepEqual(
    parseWatchObservations(
      JSON.stringify([{ ...before, offers: [before.offers[0], before.offers[0]] }]),
    ),
    [],
  );
  assert.deepEqual(mergeWatchObservations([before], []), [before]);
  assert.deepEqual(
    mergeWatchObservations([before], [{ ...before, checkedAt: "2025-01-01", offers: [] }]),
    [before],
  );
});

test("watch refresh caps its scope and concurrency, preserves failed slots and validates identity", async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const api = createApiClient(async (input) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    const key = String(input).split("/").at(-1)!;
    if (key === "c-3") return Response.json({}, { status: 503 });
    return Response.json({
      product: product({ key, catalog_product_id: key === "c-4" ? 99 : Number(key.slice(2)) }),
      offers: [offer()],
    });
  });
  const keys = Array.from({ length: MAX_WATCH_REFRESH }, (_, i) => `c-${i + 1}`);
  const results = await refreshWatchedProducts(api, keys, new AbortController().signal);
  assert.equal(calls, 10);
  assert.equal(peak, 2);
  assert.equal(results.filter((result) => result.detail === null).length, 2);
  assert.equal(results[2].key, "c-3");
  await assert.rejects(
    refreshWatchedProducts(api, [...keys, "c-11"], new AbortController().signal),
    /invalid_watch_scope/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(refreshWatchedProducts(api, keys, controller.signal), {
    name: "AbortError",
  });
  assert.equal(calls, 10);
});
