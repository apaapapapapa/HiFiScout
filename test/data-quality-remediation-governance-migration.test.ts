import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = readFileSync(
  new URL("../migrations/0026_data_quality_remediation_governance.sql", import.meta.url),
  "utf8",
);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      shop_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      canonical_manufacturer_id TEXT NOT NULL DEFAULT '',
      manufacturer_resolution_status TEXT NOT NULL DEFAULT 'unresolved',
      manufacturer_resolution_method TEXT NOT NULL DEFAULT '',
      manufacturer_resolution_confidence TEXT NOT NULL DEFAULT '',
      manufacturer_resolver_version INTEGER NOT NULL DEFAULT 1,
      model TEXT NOT NULL DEFAULT '',
      normalized_model TEXT NOT NULL DEFAULT '',
      model_resolution_status TEXT NOT NULL DEFAULT 'unresolved',
      model_resolution_method TEXT NOT NULL DEFAULT '',
      model_resolution_confidence TEXT NOT NULL DEFAULT '',
      model_resolver_version INTEGER NOT NULL DEFAULT 1,
      category TEXT NOT NULL DEFAULT 'other',
      primary_category_id TEXT NOT NULL DEFAULT 'other',
      classification_status TEXT NOT NULL DEFAULT 'unclassified',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      remediation_projection_required INTEGER NOT NULL DEFAULT 0,
      remediation_projection_token TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE product_identity_resolutions (
      listing_product_id INTEGER PRIMARY KEY,
      catalog_product_id INTEGER,
      status TEXT NOT NULL,
      match_method TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT '',
      identity_resolver_version INTEGER NOT NULL DEFAULT 1,
      evaluated_at TEXT NOT NULL
    );
    CREATE TABLE product_search_entities (
      id INTEGER PRIMARY KEY,
      entity_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE product_search_entity_offers (
      listing_product_id INTEGER PRIMARY KEY,
      entity_id INTEGER NOT NULL,
      shop_key TEXT NOT NULL
    );
    CREATE TABLE data_quality_remediation_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_product_id INTEGER,
      status TEXT NOT NULL
    );
    CREATE TABLE data_quality_remediation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_product_id INTEGER NOT NULL,
      shop_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      field TEXT NOT NULL,
      previous_value TEXT NOT NULL DEFAULT '',
      new_value TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      resolver_method TEXT NOT NULL DEFAULT '',
      resolver_confidence TEXT NOT NULL DEFAULT '',
      resolver_version INTEGER NOT NULL DEFAULT 0,
      processed_at TEXT NOT NULL
    );
  `);
  db.exec(migration);
  return db;
}

test("migration adds bounded downstream provenance and replay triggers", () => {
  for (const column of [
    "previous_identity_resolution",
    "new_identity_resolution",
    "previous_search_entity_key",
    "new_search_entity_key",
    "provenance_complete",
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN ${column}\\b`));
  }
  assert.match(migration, /idx_data_quality_remediation_events_incomplete/);
  assert.match(migration, /data_quality_remediation_offer_update_au/);
  assert.match(migration, /data_quality_remediation_queue_product_change_au/);
  assert.match(migration, /data_quality_remediation_queue_identity_update_au/);
  assert.match(migration, /WHEN json_valid\(NEW\.metadata_json\)/);
});

test("canonical remediation captures identity and search membership before and after refresh", () => {
  const db = database();
  db.exec(`
    INSERT INTO products(id, shop_key, source_id) VALUES (1, 'shop-a', 'source-1');
    INSERT INTO product_identity_resolutions(
      listing_product_id, catalog_product_id, status, match_method, confidence,
      identity_resolver_version, evaluated_at
    ) VALUES (1, NULL, 'unresolved', 'no_candidate', 'none', 6, '2026-08-15T00:00:00.000Z');
    INSERT INTO product_search_entities(id, entity_key) VALUES (1, 'l-1'), (2, 'c-42');
    INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
    VALUES (1, 1, 'shop-a');
    INSERT INTO data_quality_remediation_events(
      listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
      resolver_method, resolver_confidence, resolver_version, processed_at
    ) VALUES (
      1, 'shop-a', 'source-1', 'manufacturer', 'Unknown', 'TAD', 'verified_alias:tad',
      'verified_alias', 'high', 4, '2026-08-15T01:00:00.000Z'
    );
  `);

  const before = db.prepare(`
    SELECT previous_identity_resolution, new_identity_resolution,
           previous_search_entity_key, new_search_entity_key, provenance_complete
    FROM data_quality_remediation_events WHERE id = 1
  `).get() as Record<string, unknown>;
  assert.deepEqual({ ...before }, {
    previous_identity_resolution: "unresolved:no_candidate:-",
    new_identity_resolution: "",
    previous_search_entity_key: "l-1",
    new_search_entity_key: "",
    provenance_complete: 0,
  });

  db.exec(`
    UPDATE product_identity_resolutions
    SET catalog_product_id = 42, status = 'matched', match_method = 'catalog_exact',
        confidence = '0.98', identity_resolver_version = 7,
        evaluated_at = '2026-08-15T01:00:00.000Z'
    WHERE listing_product_id = 1;
    UPDATE product_search_entity_offers SET entity_id = 2 WHERE listing_product_id = 1;
  `);

  const after = db.prepare(`
    SELECT previous_identity_resolution, new_identity_resolution,
           previous_search_entity_key, new_search_entity_key, provenance_complete
    FROM data_quality_remediation_events WHERE id = 1
  `).get() as Record<string, unknown>;
  assert.deepEqual({ ...after }, {
    previous_identity_resolution: "unresolved:no_candidate:-",
    new_identity_resolution: "matched:catalog_exact:42",
    previous_search_entity_key: "l-1",
    new_search_entity_key: "c-42",
    provenance_complete: 1,
  });
  db.close();
});

test("post-refresh identity events use persisted resolver confidence and version", () => {
  const db = database();
  db.exec(`
    INSERT INTO products(id, shop_key, source_id) VALUES (1, 'shop-a', 'source-1');
    INSERT INTO product_identity_resolutions(
      listing_product_id, catalog_product_id, status, match_method, confidence,
      identity_resolver_version, evaluated_at
    ) VALUES (1, 42, 'matched', 'catalog_exact', '0.98', 7, '2026-08-15T01:00:00.000Z');
    INSERT INTO product_search_entities(id, entity_key) VALUES (2, 'c-42');
    INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
    VALUES (1, 2, 'shop-a');
    INSERT INTO data_quality_remediation_events(
      listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
      resolver_method, resolver_confidence, resolver_version, processed_at
    ) VALUES (
      1, 'shop-a', 'source-1', 'identity', 'unresolved:no_candidate:-',
      'matched:catalog_exact:42', 'verified_catalog_product:42', 'catalog_exact',
      'high', 0, '2026-08-15T01:00:00.000Z'
    );
  `);

  const event = db.prepare(`
    SELECT resolver_confidence, resolver_version, previous_search_entity_key,
           new_search_entity_key, provenance_complete
    FROM data_quality_remediation_events WHERE id = 1
  `).get() as Record<string, unknown>;
  assert.deepEqual({ ...event }, {
    resolver_confidence: "0.98",
    resolver_version: 7,
    previous_search_entity_key: "l-1",
    new_search_entity_key: "c-42",
    provenance_complete: 1,
  });
  db.close();
});
