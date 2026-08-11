CREATE TABLE IF NOT EXISTS knowledge_catalog_verifier_state (
  version INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  message TEXT NOT NULL DEFAULT ''
);
