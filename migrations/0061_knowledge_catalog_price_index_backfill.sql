-- Resumable state for bounded Knowledge Catalog price-index backfills.
--
-- The cursor is deliberately independent from price_history retention. A run only needs the
-- source rows while it is processing them; evidence already copied into the retention-safe sample
-- ledger survives source deletion. New rebuilds use a new backfill_key rather than deleting data.
CREATE TABLE IF NOT EXISTS knowledge_catalog_price_index_backfill_runs (
  backfill_key TEXT PRIMARY KEY,
  after_price_history_id INTEGER NOT NULL DEFAULT 0 CHECK (after_price_history_id >= 0),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed')),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_price_index_backfill_runs_status
  ON knowledge_catalog_price_index_backfill_runs(status, updated_at);
