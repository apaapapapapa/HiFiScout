import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

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
const soldOutAggregateMigration = readFileSync(
  new URL("../migrations/0022_product_search_sold_out_aggregate.sql", import.meta.url),
  "utf8",
);
const deployWorkflow = readFileSync(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf8",
);
const operationalHealthWorkflow = readFileSync(
  new URL("../.github/workflows/production-operational-health.yml", import.meta.url),
  "utf8",
);
const operationalHealthScript = readFileSync(
  new URL("../scripts/production-operational-health.sh", import.meta.url),
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

test("sold-out availability is added and backfilled in a forward-only migration", () => {
  assert.match(
    soldOutAggregateMigration,
    /ALTER TABLE product_search_entities\s+ADD COLUMN sold_out_offer_count/,
  );
  assert.doesNotMatch(soldOutAggregateMigration, /DROP TABLE|DROP COLUMN/);
  assert.ok(
    normalized(soldOutAggregateMigration).includes(normalized(refreshEntityAggregatesSql())),
  );
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

/**
 * 0021 froze these statements as they read when the Phase 4 backfill ran, and one literal has
 * moved since: an uncategorized verified catalog product now projects the `unclassified` sentinel
 * instead of borrowing the real `other` leaf. Migration 0041 repairs the rows 0021 wrote, so the
 * derivation is still single-sourced — the frozen text simply predates the rename.
 */
function asBackfilled(sql: string): string {
  return sql.split("'unclassified'").join("'other'");
}

test("the backfill is the same derivation the running sync uses, not a second definition", () => {
  const backfill = normalized(migration);
  for (const sql of [
    upsertCatalogEntitiesSql(),
    upsertFallbackEntitiesSql(),
    upsertCatalogOffersSql(),
    upsertFallbackOffersSql(),
    deleteEmptyEntitiesSql(),
  ]) {
    const expected = normalized(asBackfilled(sql));
    assert.ok(backfill.includes(expected), expected.slice(0, 80));
  }
});

test("the backfill groups only confirmed identities and keeps unresolved listings searchable", () => {
  assert.match(migration, /r\.status = 'matched'/);
  assert.match(migration, /kp\.verification_status = 'verified'/);
  assert.match(migration, /'l-' \|\| p\.id/);
  assert.doesNotMatch(migration, /candidate_catalog_product_id/);
});

test("production read-model drift fails operational health without rewriting deployment success", () => {
  assert.match(operationalHealthWorkflow, /workflows: \["Deploy Cloudflare"\]/);
  assert.match(operationalHealthWorkflow, /scripts\/production-operational-health\.sh/);
  assert.match(operationalHealthScript, /AS unmembered_active_listings/);
  assert.match(operationalHealthScript, /AS inactive_offer_memberships/);
  assert.match(operationalHealthScript, /AS entities_without_offers/);
  assert.match(operationalHealthScript, /AS stale_fallback_entities/);
  assert.match(operationalHealthScript, /if \[ "\$search_drift" -ne 0 \]; then/);
  assert.match(operationalHealthScript, /api\/admin\/product-search\/rebuild/);
  assert.doesNotMatch(deployWorkflow, /AS unmembered_active_listings/);
  assert.doesNotMatch(deployWorkflow, /identity_resolution_missing_count/);
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
