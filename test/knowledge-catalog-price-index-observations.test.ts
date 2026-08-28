import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { loadKnowledgeCatalogListingEndObservations } from "../src/db/knowledge-catalog-price-index-read.js";
import { captureDatabase } from "./helpers/d1.js";

test("listing-end detail evidence is bounded, newest-first, and catalog-scoped", async () => {
  const db = captureDatabase(() => [
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

  const observations = await loadKnowledgeCatalogListingEndObservations(db, 12);

  assert.deepEqual(observations, [
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
  assert.match(db.calls[0].sql, /WHERE catalog_product_id = \?/);
  assert.match(db.calls[0].sql, /sample_kind = 'listing_end'/);
  assert.match(db.calls[0].sql, /ORDER BY observed_at DESC, id DESC/);
  assert.match(db.calls[0].sql, /LIMIT \?/);
  assert.deepEqual(db.calls[0].binds, [12, 5]);
});

test("invalid listing-end rows are ignored instead of breaking product detail", async () => {
  const db = captureDatabase(() => [
    { price_yen: null, observed_at: "2026-08-27T08:00:00.000Z", signal_kind: "sold_out" },
    { price_yen: 300_000, observed_at: "2026-08-27T08:00:00.000Z", signal_kind: "unknown" },
  ]);

  assert.deepEqual(await loadKnowledgeCatalogListingEndObservations(db, 12), []);
});

test("invalid catalog ids never issue a listing-end evidence query", async () => {
  const db = captureDatabase(() => []);

  assert.deepEqual(await loadKnowledgeCatalogListingEndObservations(db, 0), []);
  assert.equal(db.calls.length, 0);
});
