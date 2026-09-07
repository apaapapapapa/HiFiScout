-- Point-read model specifications; no listing-derived guesses or automatic backfill.
CREATE TABLE catalog_product_specifications (
  catalog_product_id INTEGER PRIMARY KEY REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE,
  specification_json TEXT NOT NULL CHECK (json_valid(specification_json)),
  updated_at TEXT NOT NULL
);
