-- Search projection. Keep the legacy products_fts table during rollout because migrations are
-- applied before the new Worker code is deployed.
CREATE TABLE IF NOT EXISTS product_search_projection (
  product_id INTEGER PRIMARY KEY,
  manufacturer_id TEXT NOT NULL DEFAULT '',
  source_model TEXT NOT NULL DEFAULT '',
  normalized_model TEXT NOT NULL DEFAULT '',
  manufacturer_terms TEXT NOT NULL DEFAULT '',
  model_terms TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  category_terms TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO product_search_projection(
  product_id, manufacturer_id, source_model, normalized_model,
  manufacturer_terms, model_terms, title, category_terms
)
SELECT id,
       COALESCE(manufacturer_id, ''),
       COALESCE(model, ''),
       UPPER(REPLACE(REPLACE(REPLACE(COALESCE(model, ''), ' ', ''), '-', ''), '_', '')),
       TRIM(COALESCE(manufacturer, '') || ' ' || COALESCE(raw_manufacturer, '') || ' ' || COALESCE(manufacturer_id, '')),
       COALESCE(model, ''),
       COALESCE(title, ''),
       TRIM(COALESCE(category, '') || ' ' || COALESCE(raw_category, '') || ' ' || COALESCE(search_aliases, ''))
FROM products;

CREATE VIRTUAL TABLE IF NOT EXISTS product_search_fts USING fts5(
  manufacturer_terms,
  normalized_model,
  model_terms,
  title,
  category_terms,
  content='product_search_projection',
  content_rowid='product_id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS product_search_projection_ai
AFTER INSERT ON product_search_projection BEGIN
  INSERT INTO product_search_fts(
    rowid, manufacturer_terms, normalized_model, model_terms, title, category_terms
  ) VALUES (
    new.product_id, new.manufacturer_terms, new.normalized_model, new.model_terms, new.title, new.category_terms
  );
END;

CREATE TRIGGER IF NOT EXISTS product_search_projection_ad
AFTER DELETE ON product_search_projection BEGIN
  INSERT INTO product_search_fts(
    product_search_fts, rowid, manufacturer_terms, normalized_model, model_terms, title, category_terms
  ) VALUES (
    'delete', old.product_id, old.manufacturer_terms, old.normalized_model, old.model_terms, old.title, old.category_terms
  );
END;

CREATE TRIGGER IF NOT EXISTS product_search_projection_au
AFTER UPDATE ON product_search_projection BEGIN
  INSERT INTO product_search_fts(
    product_search_fts, rowid, manufacturer_terms, normalized_model, model_terms, title, category_terms
  ) VALUES (
    'delete', old.product_id, old.manufacturer_terms, old.normalized_model, old.model_terms, old.title, old.category_terms
  );
  INSERT INTO product_search_fts(
    rowid, manufacturer_terms, normalized_model, model_terms, title, category_terms
  ) VALUES (
    new.product_id, new.manufacturer_terms, new.normalized_model, new.model_terms, new.title, new.category_terms
  );
END;

INSERT INTO product_search_fts(product_search_fts) VALUES('rebuild');

-- Keep projection freshness for writes outside the crawler projection sync path, such as
-- Knowledge Catalog reclassification. Model/manufacturer changes reset the derived model terms;
-- the next incremental crawler sync enriches them deterministically again.
CREATE TRIGGER IF NOT EXISTS products_search_projection_ai
AFTER INSERT ON products BEGIN
  INSERT OR IGNORE INTO product_search_projection(
    product_id, manufacturer_id, source_model, normalized_model,
    manufacturer_terms, model_terms, title, category_terms
  ) VALUES (
    new.id,
    COALESCE(new.manufacturer_id, ''),
    COALESCE(new.model, ''),
    UPPER(REPLACE(REPLACE(REPLACE(COALESCE(new.model, ''), ' ', ''), '-', ''), '_', '')),
    TRIM(COALESCE(new.manufacturer, '') || ' ' || COALESCE(new.raw_manufacturer, '') || ' ' || COALESCE(new.manufacturer_id, '')),
    COALESCE(new.model, ''),
    COALESCE(new.title, ''),
    TRIM(COALESCE(new.category, '') || ' ' || COALESCE(new.raw_category, '') || ' ' || COALESCE(new.search_aliases, ''))
  );
END;

CREATE TRIGGER IF NOT EXISTS products_search_projection_au
AFTER UPDATE OF manufacturer, raw_manufacturer, manufacturer_id, model, title, category, raw_category, search_aliases ON products BEGIN
  INSERT INTO product_search_projection(
    product_id, manufacturer_id, source_model, normalized_model,
    manufacturer_terms, model_terms, title, category_terms
  ) VALUES (
    new.id,
    COALESCE(new.manufacturer_id, ''),
    COALESCE(new.model, ''),
    UPPER(REPLACE(REPLACE(REPLACE(COALESCE(new.model, ''), ' ', ''), '-', ''), '_', '')),
    TRIM(COALESCE(new.manufacturer, '') || ' ' || COALESCE(new.raw_manufacturer, '') || ' ' || COALESCE(new.manufacturer_id, '')),
    COALESCE(new.model, ''),
    COALESCE(new.title, ''),
    TRIM(COALESCE(new.category, '') || ' ' || COALESCE(new.raw_category, '') || ' ' || COALESCE(new.search_aliases, ''))
  )
  ON CONFLICT(product_id) DO UPDATE SET
    manufacturer_id = excluded.manufacturer_id,
    source_model = excluded.source_model,
    normalized_model = CASE
      WHEN product_search_projection.source_model IS NOT excluded.source_model
        OR product_search_projection.manufacturer_id IS NOT excluded.manufacturer_id
      THEN excluded.normalized_model ELSE product_search_projection.normalized_model END,
    manufacturer_terms = excluded.manufacturer_terms,
    model_terms = CASE
      WHEN product_search_projection.source_model IS NOT excluded.source_model
        OR product_search_projection.manufacturer_id IS NOT excluded.manufacturer_id
      THEN excluded.model_terms ELSE product_search_projection.model_terms END,
    title = excluded.title,
    category_terms = excluded.category_terms;
END;

CREATE TRIGGER IF NOT EXISTS products_search_projection_ad
AFTER DELETE ON products BEGIN
  DELETE FROM product_search_projection WHERE product_id = old.id;
END;

-- Knowledge Catalog is the canonical-product basis. This table stores only the explainable
-- Listing -> Knowledge Catalog resolution, not another product master.
CREATE TABLE IF NOT EXISTS product_identity_resolutions (
  listing_product_id INTEGER PRIMARY KEY,
  catalog_product_id INTEGER,
  candidate_catalog_product_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('matched', 'unresolved')),
  match_method TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low', 'none')),
  normalized_model TEXT NOT NULL DEFAULT '',
  model_stem TEXT NOT NULL DEFAULT '',
  variants_json TEXT NOT NULL DEFAULT '[]',
  matched_fields_json TEXT NOT NULL DEFAULT '[]',
  rejected_by_json TEXT NOT NULL DEFAULT '[]',
  evaluated_at TEXT NOT NULL,
  FOREIGN KEY (listing_product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (catalog_product_id) REFERENCES knowledge_catalog_products(id) ON DELETE SET NULL,
  FOREIGN KEY (candidate_catalog_product_id) REFERENCES knowledge_catalog_products(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_product_identity_catalog
  ON product_identity_resolutions(catalog_product_id)
  WHERE catalog_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_identity_status
  ON product_identity_resolutions(status, evaluated_at DESC);

-- Existing listings are deliberately seeded as unresolved candidates. Normal crawl processing
-- reevaluates each shop incrementally and only promotes high-confidence deterministic matches.
INSERT OR IGNORE INTO product_identity_resolutions(
  listing_product_id, catalog_product_id, candidate_catalog_product_id, status,
  match_method, confidence, normalized_model, model_stem, variants_json,
  matched_fields_json, rejected_by_json, evaluated_at
)
SELECT id, NULL, NULL, 'unresolved', 'backfill_pending', 'none',
       UPPER(REPLACE(REPLACE(REPLACE(COALESCE(model, ''), ' ', ''), '-', ''), '_', '')),
       '', '[]', '["manufacturer_id"]', '[]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products
WHERE COALESCE(manufacturer_id, '') <> '' AND COALESCE(model, '') <> '';

-- Large unstructured evidence lives in R2. D1 stores only lookup/retention metadata.
CREATE TABLE IF NOT EXISTS evidence_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_key TEXT NOT NULL,
  product_id INTEGER,
  crawl_run_id INTEGER,
  reason TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  r2_object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL DEFAULT 'text/html; charset=utf-8',
  captured_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  FOREIGN KEY (crawl_run_id) REFERENCES crawl_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_archive_lookup
  ON evidence_archive(shop_key, reason, content_hash, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_archive_expiry
  ON evidence_archive(expires_at)
  WHERE expires_at IS NOT NULL;
