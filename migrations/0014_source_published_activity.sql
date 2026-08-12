-- Preserve retailer-provided publication/arrival time separately from crawler observation time.
ALTER TABLE products ADD COLUMN source_published_at TEXT;

-- Keep the 48-hour "new" filter indexable when a retailer source timestamp is available.
CREATE INDEX IF NOT EXISTS idx_products_active_effective_new
  ON products(COALESCE(source_published_at, first_seen_at) DESC, id DESC)
  WHERE is_active = 1;
