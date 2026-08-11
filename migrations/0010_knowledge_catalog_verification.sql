ALTER TABLE knowledge_catalog_candidates
  ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'
  CHECK (verification_status IN ('unverified', 'verified', 'not_found', 'ambiguous', 'unsupported', 'error'));
ALTER TABLE knowledge_catalog_candidates ADD COLUMN last_verification_at TEXT;
ALTER TABLE knowledge_catalog_candidates ADD COLUMN verification_message TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_catalog_candidates ADD COLUMN source_url TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_candidates_verification
  ON knowledge_catalog_candidates(review_status, verification_status, priority_score DESC);

CREATE TABLE IF NOT EXISTS knowledge_catalog_verification_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER,
  product_id INTEGER,
  manufacturer_id TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  attempted_at TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('verified', 'not_found', 'ambiguous', 'unsupported', 'error')),
  http_status INTEGER,
  content_hash TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(candidate_id) REFERENCES knowledge_catalog_candidates(id) ON DELETE SET NULL,
  FOREIGN KEY(product_id) REFERENCES knowledge_catalog_products(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_verification_attempts_candidate
  ON knowledge_catalog_verification_attempts(candidate_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_verification_attempts_product
  ON knowledge_catalog_verification_attempts(product_id, attempted_at DESC);

ALTER TABLE knowledge_catalog_review_runs ADD COLUMN verification_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_catalog_review_runs ADD COLUMN verified_promotions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_catalog_review_runs ADD COLUMN verified_rechecks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_catalog_review_runs ADD COLUMN verification_failures INTEGER NOT NULL DEFAULT 0;
