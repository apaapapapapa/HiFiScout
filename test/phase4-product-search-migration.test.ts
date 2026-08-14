import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  deleteEmptyEntitiesSql,
  refreshEntityAggregatesSql,
  upsertCatalogEntitiesSql,
  upsertCatalogOffersSql,
  upsertFallbackEntitiesSql,
  upsertFallbackOffersSql,
} from "../src/db/product-search-entity-sql.js";

const migration = readFileSync(
  new URL("../migrations/0021_product_search_entities.sql", import.meta.url),
  "utf8",
);
const deployWorkflow = readFileSync(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf8",
);

/** Comparing SQL by shape, since the migration file is formatted for reading rather than diffing. */
function normalized(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

test("the migration is additive so the deployed Worker keeps serving during rollout", () => {
  assert.doesNotMatch(migration, /DROP TABLE/);
  assert.doesNotMatch(migration, /DROP TRIGGER/);
  assert.doesNotMatch(migration, /ALTER TABLE products/);
  // The listing search stack from 0017 is what the currently deployed Worker reads.
  assert.doesNotMatch(migration, /product_search_projection\s*;/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS product_search_entities/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS product_search_entity_offers/);
});

test("a listing can belong to exactly one entity, enforced by the schema rather than by code", () => {
  assert.match(migration, /listing_product_id INTEGER PRIMARY KEY/);
  assert.match(migration, /entity_key TEXT NOT NULL UNIQUE/);
});

test("an entity is either a catalog product or a fallback listing, never both or neither", () => {
  assert.match(
    migration,
    /entity_kind = 'catalog' AND catalog_product_id IS NOT NULL AND fallback_listing_id IS NULL/,
  );
  assert.match(
    migration,
    /entity_kind = 'unresolved_listing' AND catalog_product_id IS NULL AND fallback_listing_id IS NOT NULL/,
  );
});

test("the FTS update trigger only fires for the columns it indexes", () => {
  assert.match(
    migration,
    /CREATE TRIGGER IF NOT EXISTS product_search_entities_au\s+AFTER UPDATE OF manufacturer_terms, normalized_model, model_terms, title_terms, category_terms/,
  );
  // Re-aggregating a price change must not rewrite the search index.
  assert.doesNotMatch(migration, /AFTER UPDATE ON product_search_entities/);
});

test("every ordering aggregate the search reads has an index behind it", () => {
  for (const column of [
    "newest_listed_at DESC, id DESC",
    "latest_activity_at DESC, id DESC",
    "lowest_price_yen, id",
    "lowest_in_stock_price_yen, id",
    "manufacturer_id, id",
    "primary_category_id, id",
  ]) {
    assert.match(migration, new RegExp(`ON product_search_entities\\(${column}\\)`), column);
  }
  assert.match(migration, /ON product_search_entity_offers\(entity_id, shop_key\)/);
});

test("the backfill is the same derivation the running sync uses, not a second definition", () => {
  const backfill = normalized(migration);
  for (const sql of [
    upsertCatalogEntitiesSql(),
    upsertFallbackEntitiesSql(),
    upsertCatalogOffersSql(),
    upsertFallbackOffersSql(),
    refreshEntityAggregatesSql(),
    deleteEmptyEntitiesSql(),
  ]) {
    assert.ok(backfill.includes(normalized(sql)), normalized(sql).slice(0, 80));
  }
});

test("the backfill groups only confirmed identities and keeps unresolved listings searchable", () => {
  assert.match(migration, /r\.status = 'matched'/);
  assert.match(migration, /kp\.verification_status = 'verified'/);
  assert.match(migration, /'l-' \|\| p\.id/);
  assert.doesNotMatch(migration, /candidate_catalog_product_id/);
});

test("production read-model drift fails the deploy instead of quietly hiding products", () => {
  assert.match(deployWorkflow, /AS unmembered_active_listings/);
  assert.match(deployWorkflow, /AS inactive_offer_memberships/);
  assert.match(deployWorkflow, /AS entities_without_offers/);
  assert.match(deployWorkflow, /AS stale_fallback_entities/);
  assert.match(deployWorkflow, /if \[ "\$search_drift" -ne 0 \]; then/);
  assert.match(deployWorkflow, /api\/admin\/product-search\/rebuild/);
});

test("membership only ever covers active listings, so an entity always has something to buy", () => {
  const membershipInserts =
    migration.match(/INSERT INTO product_search_entity_offers[\s\S]*?;/g) || [];
  assert.equal(membershipInserts.length, 2);
  for (const statement of membershipInserts) {
    assert.match(statement, /p\.is_active = 1/);
  }
  assert.match(migration, /DELETE FROM product_search_entities\s+WHERE NOT EXISTS/);
});
