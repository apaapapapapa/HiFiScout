CREATE TABLE IF NOT EXISTS knowledge_catalog_verification_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  job_key TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL
    CHECK (job_type IN ('candidate', 'product_recheck', 'finalize')),
  target_id INTEGER,
  manufacturer_id TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'retrying', 'completed', 'dead_letter')),
  outcome TEXT NOT NULL DEFAULT ''
    CHECK (outcome IN ('', 'verified', 'not_found', 'ambiguous', 'unsupported', 'error', 'skipped')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  source_attempts INTEGER NOT NULL DEFAULT 0,
  promoted INTEGER NOT NULL DEFAULT 0 CHECK (promoted IN (0, 1)),
  rechecked INTEGER NOT NULL DEFAULT 0 CHECK (rechecked IN (0, 1)),
  enqueued_at TEXT NOT NULL,
  available_at TEXT,
  claimed_at TEXT,
  lease_expires_at TEXT,
  finished_at TEXT,
  last_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES knowledge_catalog_review_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_verification_jobs_run
  ON knowledge_catalog_verification_jobs(run_id, job_type, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_verification_jobs_pending
  ON knowledge_catalog_verification_jobs(status, available_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_verification_jobs_hostname
  ON knowledge_catalog_verification_jobs(hostname, status, lease_expires_at);

CREATE TABLE IF NOT EXISTS knowledge_catalog_verification_domain_leases (
  hostname TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL,
  leased_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_verification_domain_leases_expiry
  ON knowledge_catalog_verification_domain_leases(leased_until);
