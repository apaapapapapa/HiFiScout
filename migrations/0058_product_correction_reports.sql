CREATE TABLE product_correction_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_key TEXT NOT NULL,
  listing_product_id INTEGER,
  reason TEXT NOT NULL CHECK (
    reason IN (
      'wrong_manufacturer',
      'wrong_model',
      'wrong_category',
      'incorrect_grouping',
      'stale_or_missing_offer',
      'other_factual_error'
    )
  ),
  explanation TEXT NOT NULL DEFAULT '',
  snapshot_manufacturer TEXT NOT NULL DEFAULT '',
  snapshot_model TEXT NOT NULL DEFAULT '',
  snapshot_category TEXT NOT NULL DEFAULT '',
  snapshot_shop_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'in_review', 'accepted', 'rejected', 'duplicate')
  ),
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_product_correction_reports_queue
  ON product_correction_reports(status, created_at DESC, id DESC);
CREATE INDEX idx_product_correction_reports_target
  ON product_correction_reports(product_key, listing_product_id, reason, created_at DESC);
CREATE INDEX idx_product_correction_reports_shop
  ON product_correction_reports(snapshot_shop_key, created_at DESC);

CREATE TABLE product_correction_report_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('review_started', 'accepted', 'rejected', 'duplicate')),
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (report_id) REFERENCES product_correction_reports(id) ON DELETE CASCADE
);

CREATE INDEX idx_product_correction_report_events_report
  ON product_correction_report_events(report_id, created_at ASC, id ASC);
