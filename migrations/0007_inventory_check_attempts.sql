-- Keep transient/rejected inventory attempts separate from successful inventory verification.
ALTER TABLE products ADD COLUMN last_inventory_check_attempt_at TEXT;

-- Candidate selection is driven by the oldest attempt and listing observation.
CREATE INDEX IF NOT EXISTS idx_products_inventory_recheck_attempt
  ON products(shop_key, last_inventory_check_attempt_at, last_seen_at)
  WHERE is_active = 1;
