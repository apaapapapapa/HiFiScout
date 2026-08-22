import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EXACT_IDENTITY_SPLIT_COUNT_SQL,
  exactIdentityPeerIdsSql,
  upsertExactIdentityGroupOffersSql,
} from "../src/db/product-search-exact-identity.js";

const migration = readFileSync(
  new URL("../migrations/0036_group_exact_unresolved_product_offers.sql", import.meta.url),
  "utf8",
);

function normalized(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

test("exact unresolved grouping is gated on resolved manufacturer/model evidence", () => {
  const sql = upsertExactIdentityGroupOffersSql();

  assert.match(sql, /model_resolution_status = 'resolved'/);
  assert.match(sql, /canonical_manufacturer_id = p\.canonical_manufacturer_id/);
  assert.match(sql, /normalized_model = p\.normalized_model/);
  assert.match(sql, /kp\.verification_status = 'verified'/);
  assert.match(sql, /r\.status = 'matched'/);
  assert.match(sql, /COUNT\(DISTINCT CASE/);
  // Both ids mean "no specific category", so neither may look like contradictory evidence.
  assert.match(sql, /primary_category_id NOT IN \('other', 'unclassified'\)/);
  assert.doesNotMatch(sql, /candidate_catalog_product_id|model_stem|LIKE|levenshtein/i);
});

test("the lowest eligible unresolved listing is the deterministic fallback representative", () => {
  const sql = upsertExactIdentityGroupOffersSql();

  assert.match(sql, /e\.entity_key = 'l-' \|\| \(\s*SELECT MIN\(anchor\.id\)/);
  assert.match(sql, /ON CONFLICT\(listing_product_id\) DO UPDATE SET/);
});

test("incremental sync can expand a changed listing to every safe exact peer", () => {
  const sql = exactIdentityPeerIdsSql(3);

  assert.match(sql, /seed\.id IN \(\?,\?,\?\)/);
  assert.match(sql, /peer\.canonical_manufacturer_id = seed\.canonical_manufacturer_id/);
  assert.match(sql, /peer\.normalized_model = seed\.normalized_model/);
  assert.match(sql, /peer\.model_resolution_status = 'resolved'/);
  assert.doesNotMatch(sql, /peer\.shop_key = seed\.shop_key/);
});

test("production audit detects a safe exact identity split across multiple entities", () => {
  assert.match(EXACT_IDENTITY_SPLIT_COUNT_SQL, /COUNT\(DISTINCT m\.entity_id\) > 1/);
  assert.match(EXACT_IDENTITY_SPLIT_COUNT_SQL, /HAVING COUNT\(\*\) > 1/);
  assert.match(EXACT_IDENTITY_SPLIT_COUNT_SQL, /model_resolution_status = 'resolved'/);
});

test("forward migration applies the same conservative identity gates", () => {
  const runtime = normalized(upsertExactIdentityGroupOffersSql());
  const backfill = normalized(migration);

  for (const invariant of [
    "model_resolution_status = 'resolved'",
    "canonical_manufacturer_id",
    "normalized_model",
    "verification_status = 'verified'",
    "COUNT(DISTINCT CASE",
  ]) {
    assert.ok(runtime.includes(invariant), invariant);
    assert.ok(backfill.includes(invariant), invariant);
  }
  // The "no specific category" test is the one gate whose spelling has moved. 0036 ran when a
  // single id meant both "その他" and "未分類"; the runtime now names the sentinel as well, which
  // keeps the same rows groupable after migration 0041 rewrites them.
  assert.ok(backfill.includes("primary_category_id <> 'other'"));
  assert.ok(runtime.includes("primary_category_id NOT IN ('other', 'unclassified')"));
});
