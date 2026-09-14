-- Legacy snapshots deliberately have no coverage proof. Refresh on the next touched-shop sweep.
ALTER TABLE data_quality_runs ADD COLUMN source_revision INTEGER;

-- One row per shop, with no history scan or AUTOINCREMENT write. dirty coalesces mutations until
-- a snapshot capture arms the next revision. It does not itself certify successful persistence.
CREATE TABLE data_quality_snapshot_state (
  shop_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  dirty INTEGER NOT NULL CHECK (dirty IN (0, 1))
) WITHOUT ROWID;

-- An old Worker may retry an UPSERT on a row already captured by a new Worker. It does not set
-- source_revision, so it must not inherit the new writer's proof for different aggregate values.
-- A same-revision new-writer retry is conservatively invalidated too; the next sweep repairs it.
CREATE TRIGGER trg_dq_snapshot_legacy_update
AFTER UPDATE OF evaluated_at, total_items,
  manufacturer_missing_count, manufacturer_unresolved_count,
  category_unclassified_count, other_category_count,
  identity_matched_count, identity_unresolved_count, identity_veto_count, identity_candidate_count,
  inventory_known_count, inventory_unknown_count,
  model_expected_count, model_extracted_count, model_missing_count
ON data_quality_runs
WHEN NEW.source_revision IS NOT NULL AND NEW.source_revision IS OLD.source_revision
BEGIN
  UPDATE data_quality_runs SET source_revision = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER trg_dq_snapshot_product_insert
AFTER INSERT ON products
WHEN NEW.is_active = 1
BEGIN
  INSERT INTO data_quality_snapshot_state(shop_key, revision, dirty)
  SELECT NEW.shop_key, 1, 1 WHERE 1
  ON CONFLICT(shop_key) DO UPDATE SET revision = revision + 1, dirty = 1
  WHERE dirty = 0;
END;

CREATE TRIGGER trg_dq_snapshot_product_delete
AFTER DELETE ON products
WHEN OLD.is_active = 1
BEGIN
  INSERT INTO data_quality_snapshot_state(shop_key, revision, dirty)
  SELECT OLD.shop_key, 1, 1 WHERE 1
  ON CONFLICT(shop_key) DO UPDATE SET revision = revision + 1, dirty = 1
  WHERE dirty = 0;
END;

CREATE TRIGGER trg_dq_snapshot_product_update
AFTER UPDATE OF shop_key, is_active, raw_manufacturer, manufacturer_resolution_status, classification_status, primary_category_id, stock_status, model_resolution_status ON products
WHEN (OLD.is_active = 1 OR NEW.is_active = 1)
  AND (OLD.shop_key IS NOT NEW.shop_key
    OR OLD.is_active IS NOT NEW.is_active
    OR OLD.raw_manufacturer IS NOT NEW.raw_manufacturer
    OR OLD.manufacturer_resolution_status IS NOT NEW.manufacturer_resolution_status
    OR OLD.classification_status IS NOT NEW.classification_status
    OR OLD.primary_category_id IS NOT NEW.primary_category_id
    OR OLD.stock_status IS NOT NEW.stock_status
    OR OLD.model_resolution_status IS NOT NEW.model_resolution_status)
BEGIN
  INSERT INTO data_quality_snapshot_state(shop_key, revision, dirty)
  SELECT OLD.shop_key, 1, 1 WHERE OLD.is_active = 1
  ON CONFLICT(shop_key) DO UPDATE SET revision = revision + 1, dirty = 1
  WHERE dirty = 0;
  INSERT INTO data_quality_snapshot_state(shop_key, revision, dirty)
  SELECT NEW.shop_key, 1, 1 WHERE NEW.is_active = 1 AND (OLD.is_active <> 1 OR OLD.shop_key IS NOT NEW.shop_key)
  ON CONFLICT(shop_key) DO UPDATE SET revision = revision + 1, dirty = 1
  WHERE dirty = 0;
END;

CREATE TRIGGER trg_dq_snapshot_identity_insert
AFTER INSERT ON product_identity_resolutions
WHEN 1
BEGIN
  INSERT INTO data_quality_snapshot_state(shop_key, revision, dirty)
  SELECT shop_key, 1, 1 FROM products WHERE id = NEW.listing_product_id AND is_active = 1
  ON CONFLICT(shop_key) DO UPDATE SET revision = revision + 1, dirty = 1
  WHERE dirty = 0;
END;

CREATE TRIGGER trg_dq_snapshot_identity_delete
AFTER DELETE ON product_identity_resolutions
WHEN 1
BEGIN
  INSERT INTO data_quality_snapshot_state(shop_key, revision, dirty)
  SELECT shop_key, 1, 1 FROM products WHERE id = OLD.listing_product_id AND is_active = 1
  ON CONFLICT(shop_key) DO UPDATE SET revision = revision + 1, dirty = 1
  WHERE dirty = 0;
END;

CREATE TRIGGER trg_dq_snapshot_identity_update
AFTER UPDATE OF listing_product_id, status, match_method, candidate_catalog_product_id ON product_identity_resolutions
WHEN OLD.listing_product_id IS NOT NEW.listing_product_id
  OR OLD.status IS NOT NEW.status
  OR OLD.match_method IS NOT NEW.match_method
  OR OLD.candidate_catalog_product_id IS NOT NEW.candidate_catalog_product_id
BEGIN
  INSERT INTO data_quality_snapshot_state(shop_key, revision, dirty)
  SELECT DISTINCT shop_key, 1, 1 FROM products
  WHERE id IN (OLD.listing_product_id, NEW.listing_product_id) AND is_active = 1
  ON CONFLICT(shop_key) DO UPDATE SET revision = revision + 1, dirty = 1
  WHERE dirty = 0;
END;
