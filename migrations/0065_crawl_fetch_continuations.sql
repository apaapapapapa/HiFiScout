-- Durable collection frontier for crawl queue work.
--
-- Collection intentionally lives outside products/price_history. A page is fetched and parsed into
-- staging first; only a complete frontier is published through the normal crawl write path. This
-- prevents an interrupted partial inventory from deactivating listings that were never observed.

CREATE TABLE IF NOT EXISTS crawl_fetch_sessions (
  run_id TEXT PRIMARY KEY,
  shop_key TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'finalizing', 'completed', 'failed')),
  max_pages INTEGER NOT NULL,
  page_limit INTEGER NOT NULL,
  coverage_incomplete INTEGER NOT NULL DEFAULT 0 CHECK (coverage_incomplete IN (0, 1)),
  reached_end INTEGER NOT NULL DEFAULT 0 CHECK (reached_end IN (0, 1)),
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  pages_parsed INTEGER NOT NULL DEFAULT 0,
  last_completed_page TEXT,
  continuation_sequence INTEGER NOT NULL DEFAULT 0,
  next_phase TEXT CHECK (next_phase IN ('fetch', 'parse', 'finalize')),
  next_page_key TEXT,
  finalization_claimed_at TEXT,
  final_crawl_run_id INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finalized_at TEXT,
  UNIQUE (shop_key, requested_at)
);

CREATE INDEX IF NOT EXISTS idx_crawl_fetch_sessions_active
  ON crawl_fetch_sessions(status, updated_at);

CREATE TABLE IF NOT EXISTS crawl_fetch_pages (
  run_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  page_json TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'fetched', 'parsed', 'ignored')),
  html_text TEXT,
  products_json TEXT,
  html_bytes INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT,
  parsed_at TEXT,
  PRIMARY KEY (run_id, page_key),
  UNIQUE (run_id, ordinal),
  FOREIGN KEY (run_id) REFERENCES crawl_fetch_sessions(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crawl_fetch_pages_frontier
  ON crawl_fetch_pages(run_id, state, ordinal);
