-- Parent crawl-run retention must locate evidence rows through the foreign-key column.
-- Without this index, every deleted crawl_runs row scans the whole evidence archive before
-- applying ON DELETE SET NULL, even when no retained evidence references that run.
CREATE INDEX IF NOT EXISTS idx_evidence_archive_crawl_run
  ON evidence_archive(crawl_run_id)
  WHERE crawl_run_id IS NOT NULL;
