-- Resumable derived work.
--
-- A Cloudflare Queue invocation killed at its wall-clock limit runs no catch and no finally, so a
-- crawl that has already written its listings can still lose every projection that follows. The
-- listings themselves are durable by then; what is missing is a record of which listings the run
-- observed and how far the derived stages got. These two tables are that record, so the projections
-- can be finished later without visiting the seller again.

-- The source ids one run observed. `source_id` orders the keyset a stage resumes from.
CREATE TABLE IF NOT EXISTS crawl_run_work_items (
  crawl_run_id INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (crawl_run_id, source_id),
  FOREIGN KEY (crawl_run_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
);

-- One row per derived stage of a run. `ordinal` fixes the dependency order the stages must run in:
-- which product a listing belongs to is decided by the identity resolution written before it, so
-- resuming out of order would group this run's listings against the previous run's identities.
CREATE TABLE IF NOT EXISTS crawl_run_stages (
  crawl_run_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'superseded')),
  after_source_id TEXT NOT NULL DEFAULT '',
  processed_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (crawl_run_id, stage),
  FOREIGN KEY (crawl_run_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crawl_run_stages_pending
  ON crawl_run_stages(status, crawl_run_id, ordinal)
  WHERE status = 'pending';

-- The observation timestamp the listing write used. Identity resolution is evaluated as of that
-- moment, and a continuation must reuse it rather than the time it happens to resume.
ALTER TABLE crawl_runs ADD COLUMN generation TEXT NOT NULL DEFAULT '';
