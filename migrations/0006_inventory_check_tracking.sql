-- Keep listing discovery timestamps separate from explicit inventory verification.
ALTER TABLE products ADD COLUMN last_inventory_checked_at TEXT;

-- Used by conservative rechecks such as requiring repeated 404/410 observations
-- before marking a product inactive.
ALTER TABLE products ADD COLUMN inventory_check_failures INTEGER NOT NULL DEFAULT 0
  CHECK (inventory_check_failures >= 0);

-- Supports selecting the oldest unchecked/stale active products per shop.
CREATE INDEX IF NOT EXISTS idx_products_inventory_recheck
  ON products(shop_key, last_inventory_checked_at, first_seen_at)
  WHERE is_active = 1;
