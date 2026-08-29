-- Link a resumable collection session to exactly one publish crawl run.
--
-- 0065 introduced the durable fetch frontier, but did not add the crawl_runs identity needed to
-- reopen a finalizer after a hard platform kill. Keep this as a forward-only migration rather than
-- editing the already-merged/deployed 0065 history.

ALTER TABLE crawl_runs ADD COLUMN collection_run_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_crawl_runs_collection_run
  ON crawl_runs(collection_run_id)
  WHERE collection_run_id IS NOT NULL;
