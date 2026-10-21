-- A run wake-up claims the earliest due job of a domain nobody else is pacing. Seeking the run's
-- live jobs and sorting them made every claim, and every wake-state read after an empty claim,
-- visit each live job of the run: with targets clustered on a few manufacturer domains, and the
-- dominant one leased between requests, a run's claims were quadratic in its size.
-- This partial index holds only waiting jobs, grouped by domain and in availability order, so the
-- run's distinct domains are enumerated with one seek each and each domain's earliest due job is
-- the first entry of its range. Its WHERE clause must stay textually identical to the
-- repository's WAITING_JOB_STATUSES predicate so SQLite can prove the query implies it. Jobs
-- leave it when claimed and re-enter it only on retry.
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_verification_jobs_run_host_waiting
  ON knowledge_catalog_verification_jobs(run_id, hostname, available_at, id)
  WHERE status IN ('queued', 'retrying');
