import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { repairActiveListingProjectionGaps } from "../src/db/product-search-gap-repair.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const NOW = "2026-08-22T09:30:00.000Z";

function insertActiveListing(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  sourceId: string,
): number {
  sqlite
    .prepare(`
      INSERT INTO products(
        shop_key, source_id, manufacturer, model, title, category, condition_text,
        price_yen, stock_status, source_url, first_seen_at, last_seen_at, last_changed_at,
        last_activity_at, is_active, raw_manufacturer, manufacturer_id,
        canonical_manufacturer_id, manufacturer_resolution_status,
        manufacturer_resolution_method, manufacturer_resolution_confidence,
        raw_model, normalized_model, model_resolution_status, model_resolution_method,
        model_resolution_confidence, raw_category, primary_category_id, category_ids,
        classification_status, search_aliases
      ) VALUES (
        'audiounion', ?, 'Example Audio', 'MODEL-1', 'Example Audio MODEL-1', 'DAC', '中古',
        100000, 'in_stock', 'https://example.test/item', ?, ?, ?, ?, 1,
        'Example Audio', 'example-audio', 'example-audio', 'resolved', 'verified_alias', 'high',
        'MODEL-1', 'MODEL1', 'resolved', 'seller_model', 'high', 'DAC', 'dac', '["dac"]',
        'classified', 'DAC'
      )
    `)
    .run(sourceId, NOW, NOW, NOW, NOW);
  return Number(
    sqlite.prepare("SELECT id FROM products WHERE source_id = ?").get(sourceId)?.id || 0,
  );
}

test("repairs missing Identity and Product Search membership for an active listing", async () => {
  const { sqlite, db } = migratedSqlite();
  const listingId = insertActiveListing(sqlite, "gap-both");

  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_identity_resolutions WHERE listing_product_id = ?",
      )
      .get(listingId)?.count,
    0,
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_search_entity_offers WHERE listing_product_id = ?",
      )
      .get(listingId)?.count,
    0,
  );

  const result = await repairActiveListingProjectionGaps(db, {
    evaluatedAt: NOW,
    batchSize: 1,
    maxListings: 10,
  });

  assert.deepEqual(result, { selectedCount: 1, repairedCount: 1, remainingGapCount: 0 });
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_identity_resolutions WHERE listing_product_id = ?",
      )
      .get(listingId)?.count,
    1,
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_search_entity_offers WHERE listing_product_id = ?",
      )
      .get(listingId)?.count,
    1,
  );

  const second = await repairActiveListingProjectionGaps(db, {
    evaluatedAt: NOW,
    batchSize: 1,
    maxListings: 10,
  });
  assert.deepEqual(second, { selectedCount: 0, repairedCount: 0, remainingGapCount: 0 });
});

test("repairs a missing search membership even when Identity already exists", async () => {
  const { sqlite, db } = migratedSqlite();
  const listingId = insertActiveListing(sqlite, "gap-membership");

  sqlite
    .prepare(`
      INSERT INTO product_identity_resolutions(
        listing_product_id, catalog_product_id, candidate_catalog_product_id, status, match_method,
        confidence, normalized_model, model_stem, variants_json, matched_fields_json,
        rejected_by_json, evaluated_at
      ) VALUES (?, NULL, NULL, 'unresolved', 'unresolved', 'none', 'MODEL1', 'MODEL1', '[]', '[]', '[]', ?)
    `)
    .run(listingId, NOW);

  const result = await repairActiveListingProjectionGaps(db, {
    evaluatedAt: NOW,
    batchSize: 5,
    maxListings: 10,
  });

  assert.deepEqual(result, { selectedCount: 1, repairedCount: 1, remainingGapCount: 0 });
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_search_entity_offers WHERE listing_product_id = ?",
      )
      .get(listingId)?.count,
    1,
  );
});

test("repairs a stale fallback membership after Identity becomes catalog-matched", async () => {
  const { sqlite, db } = migratedSqlite();
  const listingId = insertActiveListing(sqlite, "gap-stale-fallback");

  // First establish the normal unresolved fallback projection.
  await repairActiveListingProjectionGaps(db, {
    evaluatedAt: NOW,
    batchSize: 5,
    maxListings: 10,
  });
  assert.equal(
    sqlite
      .prepare(`
        SELECT e.entity_kind
        FROM product_search_entity_offers o
        JOIN product_search_entities e ON e.id = o.entity_id
        WHERE o.listing_product_id = ?
      `)
      .get(listingId)?.entity_kind,
    "unresolved_listing",
  );

  // Simulate an interrupted write: Product Identity is already authoritative, but Product Search
  // has not yet consumed the transition and still points at the fallback entity.
  const catalog = sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_products(
        manufacturer_id, canonical_model, normalized_model, canonical_name,
        verification_status, created_at, updated_at
      ) VALUES ('example-audio', 'MODEL-1', 'MODEL1', 'Example Audio MODEL-1', 'verified', ?, ?)
      RETURNING id
    `)
    .get(NOW, NOW);
  const catalogId = Number(catalog?.id || 0);
  sqlite
    .prepare(
      "INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary) VALUES (?, 'dac', 1)",
    )
    .run(catalogId);
  sqlite
    .prepare(`
      UPDATE product_identity_resolutions
      SET catalog_product_id = ?, candidate_catalog_product_id = NULL, status = 'matched',
          match_method = 'test_catalog_match', confidence = 'high', evaluated_at = ?
      WHERE listing_product_id = ?
    `)
    .run(catalogId, NOW, listingId);

  const result = await repairActiveListingProjectionGaps(db, {
    evaluatedAt: NOW,
    batchSize: 5,
    maxListings: 10,
  });

  assert.deepEqual(result, { selectedCount: 1, repairedCount: 1, remainingGapCount: 0 });
  const repairedEntity = sqlite
    .prepare(`
      SELECT e.entity_kind, e.catalog_product_id
      FROM product_search_entity_offers o
      JOIN product_search_entities e ON e.id = o.entity_id
      WHERE o.listing_product_id = ?
    `)
    .get(listingId);
  assert.equal(repairedEntity?.entity_kind, "catalog");
  assert.equal(Number(repairedEntity?.catalog_product_id || 0), catalogId);
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_search_entities WHERE fallback_listing_id = ?",
      )
      .get(listingId)?.count,
    0,
  );
});
