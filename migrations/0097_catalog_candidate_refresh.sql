-- Current refresh work only: no catalog-sized work runs during migration/deployment.
CREATE TABLE knowledge_catalog_candidate_refresh (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation TEXT NOT NULL,
  request_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('collect', 'publish', 'retire', 'clean', 'complete')),
  listing_horizon INTEGER NOT NULL,
  listing_cursor INTEGER NOT NULL DEFAULT 0,
  publish_cursor TEXT NOT NULL DEFAULT '',
  retire_cursor INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE knowledge_catalog_candidate_refresh_groups (
  candidate_key TEXT PRIMARY KEY,
  accumulator_json TEXT NOT NULL
) WITHOUT ROWID;
