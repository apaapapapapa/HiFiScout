-- The verification Queue now carries one run-level wake-up instead of one target payload per job.
-- Keep the immutable target and run context beside the durable job so D1, not Queue retention, is
-- sufficient to resume processing after a retry, redelivery, or stranded-run recovery.
ALTER TABLE knowledge_catalog_verification_jobs
  ADD COLUMN payload_json TEXT NOT NULL DEFAULT '';

-- A wake consumer claims the next due job for one run. The original cross-run pending index remains
-- useful to operational status reads; this one keeps the run-scoped selector bounded.
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_verification_jobs_run_claim
  ON knowledge_catalog_verification_jobs(run_id, status, available_at, lease_expires_at, id);
