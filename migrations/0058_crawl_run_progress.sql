-- Where a crawl run had got to when it stopped.
--
-- A run killed at the platform's wall-clock limit executes no catch and no finally, so `crawl_runs`
-- keeps only what was true when the row was opened: the shop and the start time. The recovery sweep
-- can tell that such a run was abandoned, but not where, and the stage telemetry that would answer
-- it is emitted to logs that age out long before anyone asks. `crawl_run_stages` cannot answer it
-- either: those rows are written after the listing write, which is past the point where the
-- abandonments actually happen — in production, essentially every abandoned run has no stage row at
-- all.
--
-- These three columns are the durable heartbeat. They are written as the crawl advances, under the
-- same `status = 'running'` predicate the terminal writes use, so an abandoned run reports its own
-- stopping point instead of being diagnosed by inference, and a heartbeat that lands late can never
-- reopen a run that has already finished.
ALTER TABLE crawl_runs ADD COLUMN current_stage TEXT NOT NULL DEFAULT '';
ALTER TABLE crawl_runs ADD COLUMN pages_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_runs ADD COLUMN last_progress_at TEXT;
