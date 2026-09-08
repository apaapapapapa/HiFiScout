-- Manual edits need a before-image; CSV already has a durable before/after receipt.
-- Keep history queries scoped to one product. No navigation-time global aggregation.
CREATE TABLE admin_product_change_log (
  operation_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('listing', 'catalog')),
  target_id INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  restored_from TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_admin_product_change_target
  ON admin_product_change_log(target_kind, target_id, created_at DESC, operation_id DESC);
CREATE INDEX idx_admin_csv_change_history
  ON admin_csv_import_changes(target_kind, target_id, created_at DESC, operation_id DESC);
