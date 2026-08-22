CREATE TABLE IF NOT EXISTS knowledge_catalog_export_jobs (
  id TEXT PRIMARY KEY,
  singleton_key INTEGER NOT NULL DEFAULT 1 CHECK (singleton_key = 1),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  max_catalog_product_id INTEGER NOT NULL CHECK (max_catalog_product_id >= 0),
  after_id INTEGER NOT NULL DEFAULT 0 CHECK (after_id >= 0),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  -- Generation deadline while active; artifact/diagnostic expiry after reaching a terminal state.
  expires_at TEXT NOT NULL
);

-- There is no user-selected scope: concurrent Generate requests reuse this singleton export.
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_catalog_export_jobs_active
  ON knowledge_catalog_export_jobs(singleton_key)
  WHERE status IN ('queued', 'processing');

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_export_jobs_created
  ON knowledge_catalog_export_jobs(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_export_jobs_expiry
  ON knowledge_catalog_export_jobs(expires_at)
  WHERE expires_at IS NOT NULL;

-- Makes the exact latest-attempt lookup deterministic without a per-product temporary sort.
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_verification_attempts_product_latest
  ON knowledge_catalog_verification_attempts(product_id, attempted_at DESC, id DESC)
  WHERE product_id IS NOT NULL;

-- Lets the bounded category JSON lookup stop at its LIMIT without sorting every category row.
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_export_categories_order
  ON knowledge_catalog_product_categories(product_id, is_primary DESC, category_id);
