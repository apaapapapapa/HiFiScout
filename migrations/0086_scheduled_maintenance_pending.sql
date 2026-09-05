-- A due task cannot disappear just because an earlier task spent this invocation's D1 budget.
-- At most one pending row per authored maintenance task, independent of catalog/history size.
CREATE TABLE scheduled_maintenance_pending (
  task_name TEXT PRIMARY KEY,
  due_at TEXT NOT NULL,
  claimed_at TEXT,
  claim_token TEXT
);
