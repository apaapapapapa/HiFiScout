-- Operator-driven replay only. Deployment does not scan or rewrite existing listings.
CREATE TABLE product_offer_fact_replays (
  rule_version INTEGER PRIMARY KEY,
  after_id INTEGER NOT NULL DEFAULT 0,
  max_product_id INTEGER NOT NULL,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  active_count INTEGER NOT NULL DEFAULT 0,
  coverage_json TEXT NOT NULL DEFAULT '{"byShop":[],"byCategory":[]}',
  step_token TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
