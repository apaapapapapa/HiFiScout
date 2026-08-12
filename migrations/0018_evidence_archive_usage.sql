ALTER TABLE evidence_archive ADD COLUMN content_bytes INTEGER NOT NULL DEFAULT 0 CHECK (content_bytes >= 0);

CREATE INDEX IF NOT EXISTS idx_evidence_archive_captured_shop
  ON evidence_archive(captured_at, shop_key);

CREATE INDEX IF NOT EXISTS idx_evidence_archive_shop_reason_captured
  ON evidence_archive(shop_key, reason, captured_at);
