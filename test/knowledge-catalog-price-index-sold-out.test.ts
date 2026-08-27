import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

const step1Migration = readFileSync(
  new URL("../migrations/0060_knowledge_catalog_price_index.sql", import.meta.url),
  "utf8",
);
const step3Migration = readFileSync(
  new URL("../migrations/0062_knowledge_catalog_price_index_step3.sql", import.meta.url),
  "utf8",
);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      price_yen INTEGER,
      stock_status TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at TEXT NOT NULL,
      last_inventory_checked_at TEXT,
      last_changed_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(shop_key, source_id)
    );
    CREATE TABLE price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      price_yen INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE TABLE knowledge_catalog_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manufacturer_id TEXT NOT NULL,
      canonical_model TEXT NOT NULL,
      normalized_model TEXT NOT NULL,
      canonical_name TEXT NOT NULL DEFAULT '',
      lifecycle_status TEXT NOT NULL DEFAULT 'unknown',
      verification_status TEXT NOT NULL DEFAULT 'verified',
      review_status TEXT NOT NULL DEFAULT 'current',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE product_identity_resolutions (
      listing_product_id INTEGER PRIMARY KEY,
      catalog_product_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('matched', 'unresolved')),
      FOREIGN KEY(listing_product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY(catalog_product_id) REFERENCES knowledge_catalog_products(id) ON DELETE SET NULL
    );
  `);
  return db;
}

function catalogProduct(db: DatabaseSync): number {
  return Number(
    db
      .prepare(`
        INSERT INTO knowledge_catalog_products(
          manufacturer_id, canonical_model, normalized_model, created_at, updated_at
        ) VALUES ('tad', 'ME1TX', 'ME1TX', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `)
      .run().lastInsertRowid,
  );
}

function listing(db: DatabaseSync, stockStatus = "in_stock"): number {
  return Number(
    db
      .prepare(`
        INSERT INTO products(
          shop_key, source_id, price_yen, stock_status, last_seen_at, last_changed_at, is_active
        ) VALUES (
          'hifido', 'sold-out-step3', 450000, ?,
          '2026-08-01T00:00:00Z', '2026-08-28T00:00:00Z', 1
        )
      `)
      .run(stockStatus).lastInsertRowid,
  );
}

function soldOutSignals(db: DatabaseSync, catalogProductId: number): number {
  const row = db
    .prepare(`
      SELECT sold_out_signal_count
      FROM knowledge_catalog_price_indexes
      WHERE catalog_product_id = ?
    `)
    .get(catalogProductId) as { sold_out_signal_count: number } | undefined;
  return Number(row?.sold_out_signal_count || 0);
}

test("migration repairs an already-observed active sold-out listing", () => {
  const db = database();
  const catalogProductId = catalogProduct(db);
  const listingProductId = listing(db, "sold_out");
  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, ?, 'matched')
  `).run(listingProductId, catalogProductId);

  db.exec(step1Migration);
  assert.equal(soldOutSignals(db, catalogProductId), 0);
  db.exec(step3Migration);

  assert.equal(soldOutSignals(db, catalogProductId), 1);
  const sample = db
    .prepare(`
      SELECT event_key, sample_kind, signal_kind, shop_key, source_id, observed_at
      FROM knowledge_catalog_price_index_samples
      WHERE listing_product_id = ? AND signal_kind = 'sold_out'
    `)
    .get(listingProductId) as Record<string, unknown> | undefined;
  assert.ok(sample);
  assert.equal(sample.sample_kind, "listing_end");
  assert.equal(sample.signal_kind, "sold_out");
  assert.equal(sample.shop_key, "hifido");
  assert.equal(sample.source_id, "sold-out-step3");
  assert.equal(sample.observed_at, "2026-08-28T00:00:00Z");
  assert.equal(sample.event_key, `sold-out-observed:${listingProductId}:2026-08-28T00:00:00Z`);
  db.close();
});

test("inventory sold-out uses the change/check time and is not duplicated on deactivation", () => {
  const db = database();
  const catalogProductId = catalogProduct(db);
  const listingProductId = listing(db);
  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, ?, 'matched')
  `).run(listingProductId, catalogProductId);
  db.exec(step1Migration);
  db.exec(step3Migration);

  db.prepare(`
    UPDATE products
    SET stock_status = 'sold_out',
        last_inventory_checked_at = '2026-08-28T01:00:00Z',
        last_changed_at = '2026-08-28T01:00:00Z'
    WHERE id = ?
  `).run(listingProductId);

  assert.equal(soldOutSignals(db, catalogProductId), 1);
  const sample = db
    .prepare(`
      SELECT event_key, observed_at
      FROM knowledge_catalog_price_index_samples
      WHERE listing_product_id = ? AND signal_kind = 'sold_out'
    `)
    .get(listingProductId) as { event_key: string; observed_at: string };
  assert.equal(sample.observed_at, "2026-08-28T01:00:00Z");
  assert.equal(sample.event_key, `sold-out-observed:${listingProductId}:2026-08-28T01:00:00Z`);
  const product = db
    .prepare("SELECT is_active FROM products WHERE id = ?")
    .get(listingProductId) as {
    is_active: number;
  };
  assert.equal(product.is_active, 1);

  db.prepare("UPDATE products SET is_active = 0 WHERE id = ?").run(listingProductId);
  assert.equal(soldOutSignals(db, catalogProductId), 1);
  const count = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_catalog_price_index_samples
      WHERE listing_product_id = ? AND signal_kind = 'sold_out'
    `)
    .get(listingProductId) as { count: number };
  assert.equal(count.count, 1);
  db.close();
});

test("a sold-out listing observed before identity resolution is captured when it becomes matched", () => {
  const db = database();
  const catalogProductId = catalogProduct(db);
  const listingProductId = listing(db, "sold_out");
  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, NULL, 'unresolved')
  `).run(listingProductId);
  db.exec(step1Migration);
  db.exec(step3Migration);

  assert.equal(soldOutSignals(db, catalogProductId), 0);
  db.prepare(`
    UPDATE product_identity_resolutions
    SET catalog_product_id = ?, status = 'matched'
    WHERE listing_product_id = ?
  `).run(catalogProductId, listingProductId);

  assert.equal(soldOutSignals(db, catalogProductId), 1);
  const sample = db
    .prepare(`
      SELECT observed_at
      FROM knowledge_catalog_price_index_samples
      WHERE listing_product_id = ? AND signal_kind = 'sold_out'
    `)
    .get(listingProductId) as { observed_at: string };
  assert.equal(sample.observed_at, "2026-08-28T00:00:00Z");
  db.close();
});
