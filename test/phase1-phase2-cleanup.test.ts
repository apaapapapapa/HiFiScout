import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const migration = readFileSync(
  new URL("../migrations/0020_phase1_phase2_cleanup.sql", import.meta.url),
  "utf8",
);
const operationalHealthScript = readFileSync(
  new URL("../scripts/production-operational-health.sh", import.meta.url),
  "utf8",
);

test("cleanup migration removes the retired products FTS stack", () => {
  assert.match(migration, /DROP TRIGGER IF EXISTS products_fts_ai/);
  assert.match(migration, /DROP TRIGGER IF EXISTS products_fts_ad/);
  assert.match(migration, /DROP TRIGGER IF EXISTS products_fts_au/);
  assert.match(migration, /DROP TABLE IF EXISTS products_fts/);
  assert.doesNotMatch(migration, /DROP TABLE IF EXISTS product_search_fts/);
});

test("cleanup migration backfills every listing missing an identity resolution", () => {
  assert.match(migration, /INSERT OR IGNORE INTO product_identity_resolutions/);
  assert.match(
    migration,
    /LEFT JOIN product_identity_resolutions r ON r\.listing_product_id = p\.id/,
  );
  assert.match(migration, /WHERE r\.listing_product_id IS NULL/);
  assert.match(migration, /THEN 'backfill_pending'/);
  assert.match(migration, /'\["missing_identity_fields"\]'/);
  assert.doesNotMatch(migration, /p\.is_active\s*=\s*1/);
});

test("production operational health fails when an active listing lacks identity resolution", () => {
  assert.match(
    operationalHealthScript,
    /SUM\(CASE WHEN r\.listing_product_id IS NULL THEN 1 ELSE 0 END\) AS identity_resolution_missing_count/,
  );
  assert.match(
    operationalHealthScript,
    /\.identity_unresolved_count \+ \.identity_resolution_missing_count\) \/ \.total_items/,
  );
  assert.match(
    operationalHealthScript,
    /\.identity_matched_count \+ \.identity_unresolved_count\) \/ \.total_items/,
  );
  assert.match(
    operationalHealthScript,
    /identity_missing_count=.*identity_resolution_missing_count/,
  );
  assert.match(operationalHealthScript, /if \[ "\$identity_missing_count" -ne 0 \]; then/);
  assert.match(operationalHealthScript, /Product Identity coverage gap detected/);
});
