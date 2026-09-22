-- One source-backed manufacturer photo per catalog model. Null retains a deletion revision.
CREATE TABLE catalog_product_photos (
  catalog_product_id INTEGER PRIMARY KEY REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE,
  photo_json TEXT CHECK (photo_json IS NULL OR json_valid(photo_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
);
