-- Post-Phase-4 data-quality replay infrastructure.
--
-- Identity is the only existing resolution table that did not record the algorithm version that
-- produced its row. Manufacturer/model versions already live on `products`; category version is
-- persisted in `metadata_json.categoryClassification.version`.
ALTER TABLE product_identity_resolutions
  ADD COLUMN identity_resolver_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_product_identity_resolver_version
  ON product_identity_resolutions(identity_resolver_version, listing_product_id);

CREATE TABLE IF NOT EXISTS data_quality_remediation_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_key TEXT NOT NULL UNIQUE,
  work_type TEXT NOT NULL CHECK (work_type IN (
    'resolve_manufacturer',
    'resolve_model',
    'classify_category',
    'resolve_identity',
    'reprocess_listing',
    'rebuild_search_entity'
  )),
  listing_product_id INTEGER,
  entity_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'resolved', 'failed')),
  priority INTEGER NOT NULL DEFAULT 100,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL,
  claimed_at TEXT,
  lease_expires_at TEXT,
  resolved_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (listing_product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dq_remediation_queue_claim
  ON data_quality_remediation_queue(status, available_at, priority DESC, id)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_dq_remediation_queue_listing
  ON data_quality_remediation_queue(listing_product_id, work_type, status);
CREATE INDEX IF NOT EXISTS idx_dq_remediation_queue_failed
  ON data_quality_remediation_queue(status, updated_at DESC)
  WHERE status = 'failed';
