import { DatabaseSync } from "node:sqlite";

/** Minimal pre-0060 schema for isolated price-index migration/trigger tests. */
export function createPreMigrationDatabase(): DatabaseSync {
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
