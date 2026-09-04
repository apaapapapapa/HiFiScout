-- Stop rewriting the recent-expiry marker when nothing about it changes.
--
-- The marker records the earliest time at which a product's recent-asking window can change by the
-- passage of time alone. Asking evidence is append-only and arrives in observation order, so the
-- common insert observes something *newer* than the marker already accounts for: its 90-day expiry
-- is later than the stored one, and the stored value is correctly kept.
--
-- The upsert kept it with a CASE and then wrote `updated_at` anyway, so every such insert rewrote
-- the row -- and D1 bills rows written. Measured on the migrated schema, an asking insert whose
-- expiry does not move cost the same three row changes as one that does.
--
-- The conflict clause now carries the condition instead of the assignment. When neither branch
-- applies the upsert writes nothing, which is also why `updated_at` can be assigned plainly: it is
-- only ever reached when `next_expiry_at` actually moves earlier.
DROP TRIGGER IF EXISTS trg_price_index_recent_refresh_insert;

CREATE TRIGGER trg_price_index_recent_refresh_insert
AFTER INSERT ON knowledge_catalog_price_index_samples
WHEN NEW.sample_kind = 'asking' AND NEW.price_yen IS NOT NULL
BEGIN
  INSERT INTO knowledge_catalog_price_index_recent_refreshes(
    catalog_product_id,
    next_expiry_at,
    updated_at
  )
  SELECT
    NEW.catalog_product_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.observed_at, '+90 days'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE julianday(NEW.observed_at) >= julianday('now', '-90 days')
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    next_expiry_at = excluded.next_expiry_at,
    updated_at = excluded.updated_at
  WHERE knowledge_catalog_price_index_recent_refreshes.next_expiry_at IS NULL
     OR excluded.next_expiry_at < knowledge_catalog_price_index_recent_refreshes.next_expiry_at;
END;
