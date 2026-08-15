-- Model Resolution becomes a dedicated stage with its own rule version, and the Knowledge Catalog
-- candidate table gains the evidence a human needs to decide one unresolved group at a time.

-- Existing rows were produced by migration 0023's legacy normalization, so they stay behind the
-- current resolver version and remain selectable for bounded replay.
ALTER TABLE products ADD COLUMN model_resolver_version INTEGER NOT NULL DEFAULT 1
  CHECK (model_resolver_version > 0);

-- Resolver versions mean "evaluated by this algorithm". Downstream Product Search consistency is
-- tracked separately so a projection/identity/entity failure cannot strand an already-versioned
-- listing outside the retry selector.
ALTER TABLE products ADD COLUMN remediation_projection_required INTEGER NOT NULL DEFAULT 0
  CHECK (remediation_projection_required IN (0, 1));
ALTER TABLE products ADD COLUMN remediation_projection_token TEXT NOT NULL DEFAULT '';

-- Replay selectors: stale-version work, and the unresolved manufacturer/model grouping key.
CREATE INDEX IF NOT EXISTS idx_products_model_resolver_version
  ON products(model_resolver_version, is_active, id);
CREATE INDEX IF NOT EXISTS idx_products_remediation_projection_required
  ON products(remediation_projection_required, is_active, id)
  WHERE remediation_projection_required = 1;
CREATE INDEX IF NOT EXISTS idx_products_identity_group
  ON products(canonical_manufacturer_id, normalized_model, is_active, id)
  WHERE canonical_manufacturer_id <> '' AND normalized_model <> '';

-- Candidate evidence. `other_count` was already used for prioritization but never persisted, so
-- the stored priority could not be explained from the stored row.
ALTER TABLE knowledge_catalog_candidates ADD COLUMN other_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_catalog_candidates ADD COLUMN unresolved_identity_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_catalog_candidates ADD COLUMN raw_model_variants TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(raw_model_variants));
ALTER TABLE knowledge_catalog_candidates ADD COLUMN evidence_source_urls TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(evidence_source_urls));
ALTER TABLE knowledge_catalog_candidates ADD COLUMN identity_rejection_reason TEXT NOT NULL DEFAULT '';

-- Preserve what the existing rows already knew: the observed presentation is a real raw variant.
UPDATE knowledge_catalog_candidates
SET raw_model_variants = json_array(observed_model)
WHERE observed_model <> '';

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_candidates_remediation
  ON knowledge_catalog_candidates(review_status, unresolved_identity_count DESC, priority_score DESC, id);

-- Remediation progress is a durable watermark, not a time window. A run that can only replay part
-- of what it verified leaves the rest selectable, and re-verification (which moves
-- `last_verified_at` forward) makes a product remediation work again.
ALTER TABLE knowledge_catalog_products ADD COLUMN last_remediated_at TEXT;
ALTER TABLE knowledge_catalog_products ADD COLUMN remediation_after_listing_id INTEGER NOT NULL DEFAULT 0
  CHECK (remediation_after_listing_id >= 0);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_products_remediation
  ON knowledge_catalog_products(verification_status, last_remediated_at, last_verified_at, id);

-- Before/after provenance for canonical changes that remediation caused. Only actual changes are
-- recorded; an idempotent replay that resolves to the same values writes nothing.
CREATE TABLE IF NOT EXISTS data_quality_remediation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_product_id INTEGER NOT NULL,
  shop_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  field TEXT NOT NULL
    CHECK (field IN ('manufacturer', 'model', 'category', 'identity')),
  previous_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  resolver_method TEXT NOT NULL DEFAULT '',
  resolver_confidence TEXT NOT NULL DEFAULT '',
  resolver_version INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_quality_remediation_events_listing
  ON data_quality_remediation_events(listing_product_id, processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_quality_remediation_events_recent
  ON data_quality_remediation_events(processed_at DESC, id DESC);
