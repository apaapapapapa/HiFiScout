-- Persist the small set of frontier facts needed by every resumable crawl step.
--
-- Before this migration each parse/empty-page step re-read every crawl_fetch_pages row in the run
-- to derive staged item count, frontier cardinality and the next ordinal. That turns a P-page crawl
-- into O(P^2) rows_read even though the staged payload itself is already narrow. These aggregates
-- make those facts O(1) per step; pending-page selection remains an indexed LIMIT 1 lookup.
ALTER TABLE crawl_fetch_sessions
  ADD COLUMN staged_item_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_fetch_sessions
  ADD COLUMN frontier_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_fetch_sessions
  ADD COLUMN next_ordinal INTEGER NOT NULL DEFAULT 0;

-- One-time compatibility backfill for sessions that were created before the aggregate columns
-- existed. Active sessions are normally a tiny set, and this migration cost is paid once rather than
-- once per page step.
UPDATE crawl_fetch_sessions AS s
SET staged_item_count = COALESCE((
      SELECT SUM(p.item_count)
      FROM crawl_fetch_pages p
      WHERE p.run_id = s.run_id AND p.state = 'parsed'
    ), 0),
    frontier_count = (
      SELECT COUNT(*)
      FROM crawl_fetch_pages p
      WHERE p.run_id = s.run_id
    ),
    next_ordinal = COALESCE((
      SELECT MAX(p.ordinal) + 1
      FROM crawl_fetch_pages p
      WHERE p.run_id = s.run_id
    ), 0);
