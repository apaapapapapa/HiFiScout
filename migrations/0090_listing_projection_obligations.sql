-- Empty current-work tables: no history backfill or product rewrite during deployment.
CREATE TABLE listing_projection_pending (
  listing_product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_listing_projection_pending_attempt
  ON listing_projection_pending(last_attempt_at, listing_product_id);

CREATE TABLE product_projection_audit_cursors (
  phase TEXT PRIMARY KEY,
  after_id INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

ALTER TABLE crawl_run_work_items ADD COLUMN projection_token TEXT NOT NULL DEFAULT '';

CREATE TRIGGER products_projection_obligation_insert
AFTER INSERT ON products
BEGIN
  INSERT INTO listing_projection_pending(listing_product_id, token)
  VALUES (NEW.id, lower(hex(randomblob(16))));
END;

-- Heartbeats and metadata-only cache decisions must not create projection work. Guards also
-- protect callers that assign unchanged values to SET, including the previous deployed worker.
CREATE TRIGGER products_projection_obligation_update
AFTER UPDATE OF manufacturer, manufacturer_id, manufacturer_resolution_status, canonical_manufacturer_id, model, raw_model, normalized_model,
  model_resolution_status, title, primary_category_id, category_ids, direct_category_ids,
  classification_status, search_aliases, price_yen, stock_status, condition_text,
  presentation_color, is_active, source_url, source_published_at, category, raw_category, last_activity_at ON products
WHEN OLD.manufacturer IS NOT NEW.manufacturer
  OR OLD.manufacturer_id IS NOT NEW.manufacturer_id
  OR OLD.manufacturer_resolution_status IS NOT NEW.manufacturer_resolution_status
  OR OLD.canonical_manufacturer_id IS NOT NEW.canonical_manufacturer_id
  OR OLD.model IS NOT NEW.model OR OLD.raw_model IS NOT NEW.raw_model
  OR OLD.normalized_model IS NOT NEW.normalized_model
  OR OLD.model_resolution_status IS NOT NEW.model_resolution_status
  OR OLD.title IS NOT NEW.title OR OLD.primary_category_id IS NOT NEW.primary_category_id
  OR OLD.category_ids IS NOT NEW.category_ids OR OLD.direct_category_ids IS NOT NEW.direct_category_ids
  OR OLD.classification_status IS NOT NEW.classification_status
  OR OLD.search_aliases IS NOT NEW.search_aliases OR OLD.price_yen IS NOT NEW.price_yen
  OR OLD.stock_status IS NOT NEW.stock_status OR OLD.condition_text IS NOT NEW.condition_text
  OR OLD.presentation_color IS NOT NEW.presentation_color OR OLD.is_active IS NOT NEW.is_active
  OR OLD.source_url IS NOT NEW.source_url OR OLD.last_activity_at IS NOT NEW.last_activity_at
  OR OLD.source_published_at IS NOT NEW.source_published_at
  OR OLD.category IS NOT NEW.category OR OLD.raw_category IS NOT NEW.raw_category
BEGIN
  INSERT INTO listing_projection_pending(listing_product_id, token)
  VALUES (NEW.id, lower(hex(randomblob(16))))
  ON CONFLICT(listing_product_id) DO UPDATE SET token = excluded.token, last_attempt_at = '';
END;
