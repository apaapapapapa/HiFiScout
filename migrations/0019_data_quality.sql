CREATE TABLE IF NOT EXISTS data_quality_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_key TEXT NOT NULL,
  crawl_run_id INTEGER,
  evaluated_at TEXT NOT NULL,
  total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  manufacturer_missing_count INTEGER NOT NULL DEFAULT 0 CHECK (manufacturer_missing_count >= 0),
  manufacturer_unresolved_count INTEGER NOT NULL DEFAULT 0 CHECK (manufacturer_unresolved_count >= 0),
  category_unclassified_count INTEGER NOT NULL DEFAULT 0 CHECK (category_unclassified_count >= 0),
  other_category_count INTEGER NOT NULL DEFAULT 0 CHECK (other_category_count >= 0),
  identity_matched_count INTEGER NOT NULL DEFAULT 0 CHECK (identity_matched_count >= 0),
  identity_unresolved_count INTEGER NOT NULL DEFAULT 0 CHECK (identity_unresolved_count >= 0),
  identity_veto_count INTEGER NOT NULL DEFAULT 0 CHECK (identity_veto_count >= 0),
  identity_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (identity_candidate_count >= 0),
  inventory_known_count INTEGER NOT NULL DEFAULT 0 CHECK (inventory_known_count >= 0),
  inventory_unknown_count INTEGER NOT NULL DEFAULT 0 CHECK (inventory_unknown_count >= 0),
  model_expected_count INTEGER NOT NULL DEFAULT 0 CHECK (model_expected_count >= 0),
  model_extracted_count INTEGER NOT NULL DEFAULT 0 CHECK (model_extracted_count >= 0),
  model_missing_count INTEGER NOT NULL DEFAULT 0 CHECK (model_missing_count >= 0),
  parse_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (parse_attempt_count >= 0),
  parse_success_count INTEGER NOT NULL DEFAULT 0 CHECK (parse_success_count >= 0),
  parse_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (parse_failure_count >= 0),
  evidence_expected_event_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_expected_event_count >= 0),
  evidence_archived_event_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_archived_event_count >= 0),
  evidence_archive_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_archive_failure_count >= 0),
  previous_item_count INTEGER,
  current_item_count INTEGER NOT NULL DEFAULT 0 CHECK (current_item_count >= 0),
  item_count_absolute_difference INTEGER,
  item_count_change_rate REAL,
  manufacturer_status TEXT NOT NULL CHECK (manufacturer_status IN ('healthy','warning','critical','unknown')),
  category_status TEXT NOT NULL CHECK (category_status IN ('healthy','warning','critical','unknown')),
  identity_status TEXT NOT NULL CHECK (identity_status IN ('healthy','warning','critical','unknown')),
  inventory_status TEXT NOT NULL CHECK (inventory_status IN ('healthy','warning','critical','unknown')),
  model_status TEXT NOT NULL CHECK (model_status IN ('healthy','warning','critical','unknown')),
  parser_status TEXT NOT NULL CHECK (parser_status IN ('healthy','warning','critical','unknown')),
  item_count_status TEXT NOT NULL CHECK (item_count_status IN ('healthy','warning','critical','unknown')),
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('healthy','warning','critical','unknown')),
  snapshot_status TEXT NOT NULL CHECK (snapshot_status IN ('healthy','warning','critical','unknown')),
  run_status TEXT NOT NULL CHECK (run_status IN ('healthy','warning','critical','unknown')),
  quality_status TEXT NOT NULL CHECK (quality_status IN ('healthy','warning','critical','unknown')),
  FOREIGN KEY (crawl_run_id) REFERENCES crawl_runs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_data_quality_crawl_run
  ON data_quality_runs(crawl_run_id)
  WHERE crawl_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_data_quality_shop_latest
  ON data_quality_runs(shop_key, evaluated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_data_quality_evaluated_at
  ON data_quality_runs(evaluated_at, id);

-- Supports the active-listing aggregate used by Data Quality without pulling listings into Workers.
CREATE INDEX IF NOT EXISTS idx_products_shop_active_quality
  ON products(shop_key, is_active, classification_status, primary_category_id);
