-- Keep crawl recovery proportional to current work rather than retained crawl history.
--
-- Resumable recovery already has a partial index containing only pending stages. Stalled-run
-- recovery needs the same property: terminal crawl history must not be represented in the access
-- path used by the scheduled sweep. The predicate also keeps terminal rows out of the index as the
-- retained crawl history grows.
CREATE INDEX IF NOT EXISTS idx_crawl_runs_running_started_at
  ON crawl_runs(started_at)
  WHERE status = 'running';
