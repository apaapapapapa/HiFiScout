-- Temporary detail-page staging for Durable Object paced category enrichment.
--
-- Relay-backed detail HTML must not live in DO storage: the DO owns only scheduling metadata and
-- D1 remains the durable crawl state. One row records one attempted seller detail fetch for a crawl
-- session. Both successful HTML and best-effort failures are staged so Alarm redelivery is
-- idempotent and finalization never performs an unpaced fallback fetch for an already-attempted URL.

CREATE TABLE IF NOT EXISTS crawl_fetch_detail_pages (
  run_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  html_text TEXT,
  error_message TEXT,
  html_bytes INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (run_id, target_url),
  FOREIGN KEY (run_id) REFERENCES crawl_fetch_sessions(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crawl_fetch_detail_pages_run
  ON crawl_fetch_detail_pages(run_id, fetched_at);
