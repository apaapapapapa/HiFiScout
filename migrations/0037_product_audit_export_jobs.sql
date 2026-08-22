CREATE TABLE IF NOT EXISTS product_audit_export_jobs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('active', 'all')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  max_listing_id INTEGER NOT NULL CHECK (max_listing_id >= 0),
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
  expires_at TEXT
);

-- At most one in-flight export per scope. Concurrent Generate requests reuse the winner.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_audit_export_jobs_active_scope
  ON product_audit_export_jobs(scope)
  WHERE status IN ('queued', 'processing');

CREATE INDEX IF NOT EXISTS idx_product_audit_export_jobs_scope_created
  ON product_audit_export_jobs(scope, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_product_audit_export_jobs_expiry
  ON product_audit_export_jobs(expires_at)
  WHERE expires_at IS NOT NULL;

-- The active export uses this partial covering order instead of walking inactive PK gaps.
CREATE INDEX IF NOT EXISTS idx_products_product_audit_active
  ON products(id)
  WHERE is_active = 1;
