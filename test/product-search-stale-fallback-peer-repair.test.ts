import assert from "node:assert/strict";
import { test } from "vitest";

import { repairActiveListingProjectionGaps } from "../src/db/product-search-gap-repair.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const NOW = "2026-08-23T00:00:00.000Z";

function insertListing(
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

function insertResolution(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  listingId: number,
  catalogId: number | null,
  status: "matched" | "unresolved",
): void {
  sqlite
    .prepare(`
      INSERT INTO product_identity_resolutions(
        listing_product_id, catalog_product_id, candidate_catalog_product_id, status, match_method,
        confidence, normalized_model, model_stem, variants_json, matched_fields_json,
        rejected_by_json, evaluated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, 'MODEL1', 'MODEL1', '[]', '[]', '[]', ?)
    `)
    .run(
      listingId,
      catalogId,
      status,
      status === "matched" ? "test_catalog_match" : "unresolved",
      status === "matched" ? "high" : "none",
      NOW,
    );
}

test("repairs an unresolved peer left on a fallback represented by a now-matched listing", async () => {
  const { sqlite, db } = migratedSqlite();
  const representativeId = insertListing(sqlite, "stale-representative");
  const peerId = insertListing(sqlite, "stale-peer");

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

  insertResolution(sqlite, representativeId, catalogId, "matched");
  insertResolution(sqlite, peerId, null, "unresolved");

  const staleEntity = sqlite
    .prepare(`
      INSERT INTO product_search_entities(
        entity_key, entity_kind, fallback_listing_id, manufacturer_id, manufacturer, model,
        normalized_model, primary_category_id, manufacturer_terms, model_terms
      ) VALUES (?, 'unresolved_listing', ?, 'example-audio', 'Example Audio', 'MODEL-1',
                'MODEL1', 'dac', 'example-audio', 'MODEL-1')
      RETURNING id
    `)
    .get(`l-${representativeId}`, representativeId);
  const staleEntityId = Number(staleEntity?.id || 0);

  const catalogEntity = sqlite
    .prepare(`
      INSERT INTO product_search_entities(
        entity_key, entity_kind, catalog_product_id, manufacturer_id, manufacturer, model,
        normalized_model, primary_category_id, manufacturer_terms, model_terms
      ) VALUES (?, 'catalog', ?, 'example-audio', 'Example Audio', 'MODEL-1',
                'MODEL1', 'dac', 'example-audio', 'MODEL-1')
      RETURNING id
    `)
    .get(`c-${catalogId}`, catalogId);
  const catalogEntityId = Number(catalogEntity?.id || 0);

  sqlite
    .prepare(
      "INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key) VALUES (?, ?, 'audiounion')",
    )
    .run(representativeId, catalogEntityId);
  sqlite
    .prepare(
      "INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key) VALUES (?, ?, 'audiounion')",
    )
    .run(peerId, staleEntityId);

  // This is the production shape missed by the old repair predicate: the representative's own
  // membership is already correct, while another active offer still keeps its obsolete fallback alive.
  const before = sqlite
    .prepare(`
      SELECT COUNT(*) AS count
      FROM product_search_entities e
      WHERE e.entity_kind = 'unresolved_listing'
        AND EXISTS (
          SELECT 1
          FROM product_identity_resolutions r
          JOIN knowledge_catalog_products kp
            ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
          WHERE r.listing_product_id = e.fallback_listing_id AND r.status = 'matched'
        )
    `)
    .get();
  assert.equal(Number(before?.count || 0), 1);

  const result = await repairActiveListingProjectionGaps(db, {
    evaluatedAt: NOW,
    batchSize: 5,
    maxListings: 10,
  });

  assert.deepEqual(result, { selectedCount: 1, repairedCount: 1, remainingGapCount: 0 });
  assert.equal(
    Number(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM product_search_entities WHERE id = ?")
        .get(staleEntityId)?.count || 0,
    ),
    0,
  );
  const peerMembership = sqlite
    .prepare(`
      SELECT e.entity_kind, e.fallback_listing_id, e.catalog_product_id
      FROM product_search_entity_offers o
      JOIN product_search_entities e ON e.id = o.entity_id
      WHERE o.listing_product_id = ?
    `)
    .get(peerId);
  assert.ok(peerMembership);
  assert.notEqual(Number(peerMembership?.fallback_listing_id || 0), representativeId);
});
