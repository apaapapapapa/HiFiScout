import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { IDENTITY_RESOLVER_VERSION } from "../src/catalog/resolution-versions.js";
import { syncProductIdentityResolutions } from "../src/db/product-identity-repository.js";
import { sqliteD1 } from "./helpers/sqlite-d1.js";

test("identity resolver version bump rewrites once even when the resolution is unchanged", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      shop_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      canonical_manufacturer_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      model_resolution_status TEXT NOT NULL DEFAULT 'resolved',
      primary_category_id TEXT NOT NULL DEFAULT 'other',
      classification_status TEXT NOT NULL DEFAULT 'classified'
    );
    CREATE TABLE knowledge_catalog_products (
      id INTEGER PRIMARY KEY,
      manufacturer_id TEXT NOT NULL,
      canonical_model TEXT NOT NULL,
      normalized_model TEXT NOT NULL DEFAULT '',
      verification_status TEXT NOT NULL DEFAULT 'verified'
    );
    CREATE TABLE knowledge_catalog_product_categories (
      product_id INTEGER NOT NULL,
      category_id TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_catalog_aliases (
      product_id INTEGER NOT NULL,
      alias TEXT NOT NULL,
      alias_type TEXT NOT NULL
    );
    CREATE TABLE product_identity_resolutions (
      listing_product_id INTEGER PRIMARY KEY,
      catalog_product_id INTEGER,
      candidate_catalog_product_id INTEGER,
      status TEXT NOT NULL,
      match_method TEXT NOT NULL,
      confidence TEXT NOT NULL,
      normalized_model TEXT NOT NULL DEFAULT '',
      model_stem TEXT NOT NULL DEFAULT '',
      variants_json TEXT NOT NULL DEFAULT '[]',
      matched_fields_json TEXT NOT NULL DEFAULT '[]',
      rejected_by_json TEXT NOT NULL DEFAULT '[]',
      identity_resolver_version INTEGER NOT NULL DEFAULT 1,
      evaluated_at TEXT NOT NULL
    );
  `);
  sqlite
    .prepare(`
      INSERT INTO products(
        id, shop_key, source_id, canonical_manufacturer_id, model,
        model_resolution_status, primary_category_id, classification_status
      ) VALUES (1, 'shop', 'source-1', 'example', 'MODEL-1', 'resolved', 'power_amp', 'classified')
    `)
    .run();
  const db = sqliteD1(sqlite);

  const initial = await syncProductIdentityResolutions(
    db,
    "shop",
    ["source-1"],
    "2026-08-15T00:00:00.000Z",
  );
  assert.equal(initial.identity_resolution_write_count, 1);
  assert.equal(
    sqlite
      .prepare(
        "SELECT identity_resolver_version FROM product_identity_resolutions WHERE listing_product_id = 1",
      )
      .get()?.identity_resolver_version,
    IDENTITY_RESOLVER_VERSION,
  );

  sqlite
    .prepare(
      "UPDATE product_identity_resolutions SET identity_resolver_version = 0 WHERE listing_product_id = 1",
    )
    .run();
  const replay = await syncProductIdentityResolutions(
    db,
    "shop",
    ["source-1"],
    "2026-08-15T00:01:00.000Z",
  );
  assert.equal(
    replay.identity_resolution_write_count,
    1,
    "version-only staleness must be persisted",
  );

  const noOp = await syncProductIdentityResolutions(
    db,
    "shop",
    ["source-1"],
    "2026-08-15T00:02:00.000Z",
  );
  assert.equal(noOp.identity_resolution_write_count, 0, "current-version replay must be a no-op");
});
