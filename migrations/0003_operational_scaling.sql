ALTER TABLE shop_sync_state ADD COLUMN queued_at TEXT;

CREATE INDEX IF NOT EXISTS idx_shop_sync_state_queued_at
  ON shop_sync_state(queued_at)
  WHERE queued_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crawl_runs_started_at
  ON crawl_runs(started_at);

CREATE INDEX IF NOT EXISTS idx_price_history_observed_at
  ON price_history(observed_at);

CREATE INDEX IF NOT EXISTS idx_products_inactive_last_seen
  ON products(last_seen_at)
  WHERE is_active = 0;
