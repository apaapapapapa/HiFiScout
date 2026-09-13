-- Advisory state only; authoritative catalog/listing tables are unchanged.
CREATE TABLE ai_catalog_budgets (
  day TEXT PRIMARY KEY,
  policy_key TEXT NOT NULL,
  allowance_milli INTEGER NOT NULL CHECK (allowance_milli BETWEEN 0 AND 1000000),
  reserved_milli INTEGER NOT NULL DEFAULT 0,
  started_jobs INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0,1)),
  account_evidence TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE ai_catalog_jobs (
  id TEXT PRIMARY KEY,
  candidate_id INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('queued','processing','suggested','no_suggestion','invalid','deferred','stale','failed','reviewed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  attempt_token TEXT,
  lease_until TEXT,
  result_json TEXT,
  error_code TEXT NOT NULL DEFAULT '',
  review_outcome TEXT CHECK (review_outcome IN ('useful','incorrect','insufficient_evidence')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_ai_catalog_jobs_work ON ai_catalog_jobs(status,updated_at,id);
CREATE INDEX idx_ai_catalog_jobs_retention ON ai_catalog_jobs(created_at,id);
CREATE INDEX idx_ai_catalog_jobs_candidate ON ai_catalog_jobs(candidate_id,created_at DESC);

CREATE TABLE ai_catalog_attempts (
  token TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES ai_catalog_jobs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  day TEXT NOT NULL,
  reserved_milli INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  actual_milli INTEGER,
  latency_ms INTEGER,
  outcome TEXT NOT NULL DEFAULT 'reserved',
  created_at TEXT NOT NULL,
  UNIQUE(job_id,ordinal)
);
CREATE INDEX idx_ai_catalog_attempts_day ON ai_catalog_attempts(day);
