-- Keep user-facing listing activity separate from internal normalization changes.
ALTER TABLE products ADD COLUMN last_activity_at TEXT;

-- Historical price observations are the only reliable evidence of prior user-visible
-- activity. Falling back to first_seen_at avoids treating catalog backfills as fresh.
UPDATE products
SET last_activity_at = COALESCE(
  (
    SELECT MAX(ph.observed_at)
    FROM price_history ph
    WHERE ph.product_id = products.id
  ),
  first_seen_at
);

DROP INDEX IF EXISTS idx_products_active_newest;

CREATE INDEX IF NOT EXISTS idx_products_active_activity
  ON products(last_activity_at DESC, id DESC)
  WHERE is_active = 1;
