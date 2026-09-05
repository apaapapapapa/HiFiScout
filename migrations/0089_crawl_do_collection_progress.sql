-- Existing executions finish with D1 progress. Only newly accepted DO executions opt in.
-- The receipt lands in the existing page UPDATE, so a D1 commit followed by a DO restart is
-- recoverable without a second per-page session UPDATE or a seller refetch.
ALTER TABLE crawl_fetch_sessions ADD COLUMN progress_storage TEXT NOT NULL DEFAULT 'd1'
  CHECK (progress_storage IN ('d1', 'durable_object'));
ALTER TABLE crawl_fetch_pages ADD COLUMN progress_json TEXT;
