-- An equality seek on (run_id, state) still scans every parsed page when all are empty.
-- Index only pages that can satisfy the staged-items EXISTS probe. Including both equality
-- columns makes this preferable to the older frontier index without forcing a planner hint.
-- Existing Workers maintain this automatically during the migration/deploy window.
CREATE INDEX IF NOT EXISTS idx_crawl_fetch_pages_nonempty
  ON crawl_fetch_pages(run_id, state, item_count)
  WHERE state = 'parsed' AND item_count > 0;
