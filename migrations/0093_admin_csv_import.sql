-- One receipt per changed row. CSV source files and unchanged rows are not persisted in D1.
-- The before/after values and cursor survive a browser/network interruption.
CREATE TABLE admin_csv_import_changes (
  operation_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('listing', 'catalog')),
  target_id INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied')),
  phase INTEGER NOT NULL DEFAULT 0,
  after_listing_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_admin_csv_import_pending
  ON admin_csv_import_changes(target_kind, target_id) WHERE status = 'pending';
CREATE INDEX idx_product_identity_candidate_catalog
  ON product_identity_resolutions(candidate_catalog_product_id, listing_product_id)
  WHERE candidate_catalog_product_id IS NOT NULL;
CREATE INDEX idx_knowledge_catalog_candidate_product
  ON knowledge_catalog_candidates(catalog_product_id)
  WHERE catalog_product_id IS NOT NULL;
