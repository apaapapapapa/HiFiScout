-- Step 3 hardening: an explicit seller sold-out observation is market evidence even while the
-- listing remains present in the crawler result set. Step 1 captured that signal only when the
-- listing was later deactivated, which loses evidence for shops (notably HiFiDo) that continue to
-- publish sold-out listings.
--
-- Sold-out chronology uses last_changed_at first. Inventory rechecks update that field to checkedAt
-- while deliberately leaving last_seen_at unchanged, so the retained evidence reflects the actual
-- availability observation rather than an older crawl heartbeat.

CREATE TRIGGER IF NOT EXISTS trg_products_price_index_sold_out_observed
AFTER UPDATE OF stock_status ON products
WHEN NEW.stock_status = 'sold_out'
 AND OLD.stock_status <> 'sold_out'
BEGIN
  INSERT INTO knowledge_catalog_price_index_samples(
    event_key,
    catalog_product_id,
    listing_product_id,
    source_price_history_id,
    shop_key,
    source_id,
    sample_kind,
    signal_kind,
    price_yen,
    observed_at
  )
  SELECT
    'sold-out-observed:' || NEW.id || ':' || COALESCE(
      NULLIF(NEW.last_changed_at, ''),
      NULLIF(NEW.last_inventory_checked_at, ''),
      NULLIF(NEW.last_seen_at, ''),
      'unknown'
    ),
    pir.catalog_product_id,
    NEW.id,
    NULL,
    NEW.shop_key,
    NEW.source_id,
    'listing_end',
    'sold_out',
    NEW.price_yen,
    COALESCE(
      NULLIF(NEW.last_changed_at, ''),
      NULLIF(NEW.last_inventory_checked_at, ''),
      NULLIF(NEW.last_seen_at, ''),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  FROM product_identity_resolutions pir
  WHERE pir.listing_product_id = NEW.id
    AND pir.status = 'matched'
    AND pir.catalog_product_id IS NOT NULL
  ON CONFLICT(event_key) DO UPDATE SET
    catalog_product_id = excluded.catalog_product_id,
    listing_product_id = excluded.listing_product_id,
    shop_key = excluded.shop_key,
    source_id = excluded.source_id,
    price_yen = excluded.price_yen,
    observed_at = excluded.observed_at;
END;

-- If the sold-out observation happened before identity resolution, capture the current strong
-- signal as soon as a catalog identity is inserted.
CREATE TRIGGER IF NOT EXISTS trg_identity_price_index_sold_out_insert
AFTER INSERT ON product_identity_resolutions
WHEN NEW.status = 'matched' AND NEW.catalog_product_id IS NOT NULL
BEGIN
  INSERT INTO knowledge_catalog_price_index_samples(
    event_key,
    catalog_product_id,
    listing_product_id,
    source_price_history_id,
    shop_key,
    source_id,
    sample_kind,
    signal_kind,
    price_yen,
    observed_at
  )
  SELECT
    'sold-out-observed:' || p.id || ':' || COALESCE(
      NULLIF(p.last_changed_at, ''),
      NULLIF(p.last_inventory_checked_at, ''),
      NULLIF(p.last_seen_at, ''),
      'unknown'
    ),
    NEW.catalog_product_id,
    p.id,
    NULL,
    p.shop_key,
    p.source_id,
    'listing_end',
    'sold_out',
    p.price_yen,
    COALESCE(
      NULLIF(p.last_changed_at, ''),
      NULLIF(p.last_inventory_checked_at, ''),
      NULLIF(p.last_seen_at, ''),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  FROM products p
  WHERE p.id = NEW.listing_product_id
    AND p.stock_status = 'sold_out'
  ON CONFLICT(event_key) DO UPDATE SET
    catalog_product_id = excluded.catalog_product_id,
    listing_product_id = excluded.listing_product_id,
    shop_key = excluded.shop_key,
    source_id = excluded.source_id,
    price_yen = excluded.price_yen,
    observed_at = excluded.observed_at;
END;

-- Identity commonly transitions unresolved -> matched by UPDATE rather than INSERT. Re-check the
-- current product state here as well. A matched -> matched reassignment is harmless/idempotent: the
-- Step 1 reassignment trigger moves retained samples first and this stable event key then upserts it.
CREATE TRIGGER IF NOT EXISTS trg_identity_price_index_sold_out_update
AFTER UPDATE OF status, catalog_product_id ON product_identity_resolutions
WHEN NEW.status = 'matched'
 AND NEW.catalog_product_id IS NOT NULL
 AND (OLD.status <> 'matched' OR OLD.catalog_product_id IS NOT NEW.catalog_product_id)
BEGIN
  INSERT INTO knowledge_catalog_price_index_samples(
    event_key,
    catalog_product_id,
    listing_product_id,
    source_price_history_id,
    shop_key,
    source_id,
    sample_kind,
    signal_kind,
    price_yen,
    observed_at
  )
  SELECT
    'sold-out-observed:' || p.id || ':' || COALESCE(
      NULLIF(p.last_changed_at, ''),
      NULLIF(p.last_inventory_checked_at, ''),
      NULLIF(p.last_seen_at, ''),
      'unknown'
    ),
    NEW.catalog_product_id,
    p.id,
    NULL,
    p.shop_key,
    p.source_id,
    'listing_end',
    'sold_out',
    p.price_yen,
    COALESCE(
      NULLIF(p.last_changed_at, ''),
      NULLIF(p.last_inventory_checked_at, ''),
      NULLIF(p.last_seen_at, ''),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  FROM products p
  WHERE p.id = NEW.listing_product_id
    AND p.stock_status = 'sold_out'
  ON CONFLICT(event_key) DO UPDATE SET
    catalog_product_id = excluded.catalog_product_id,
    listing_product_id = excluded.listing_product_id,
    shop_key = excluded.shop_key,
    source_id = excluded.source_id,
    price_yen = excluded.price_yen,
    observed_at = excluded.observed_at;
END;

-- Repair already-known active sold-out listings. Inactive rows were already eligible for the Step 1
-- deactivation trigger, so this intentionally targets the gap that review identified.
INSERT INTO knowledge_catalog_price_index_samples(
  event_key,
  catalog_product_id,
  listing_product_id,
  source_price_history_id,
  shop_key,
  source_id,
  sample_kind,
  signal_kind,
  price_yen,
  observed_at
)
SELECT
  'sold-out-observed:' || p.id || ':' || COALESCE(
    NULLIF(p.last_changed_at, ''),
    NULLIF(p.last_inventory_checked_at, ''),
    NULLIF(p.last_seen_at, ''),
    'unknown'
  ),
  pir.catalog_product_id,
  p.id,
  NULL,
  p.shop_key,
  p.source_id,
  'listing_end',
  'sold_out',
  p.price_yen,
  COALESCE(
    NULLIF(p.last_changed_at, ''),
    NULLIF(p.last_inventory_checked_at, ''),
    NULLIF(p.last_seen_at, ''),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
FROM products p
JOIN product_identity_resolutions pir ON pir.listing_product_id = p.id
WHERE p.is_active = 1
  AND p.stock_status = 'sold_out'
  AND pir.status = 'matched'
  AND pir.catalog_product_id IS NOT NULL
ON CONFLICT(event_key) DO UPDATE SET
  catalog_product_id = excluded.catalog_product_id,
  listing_product_id = excluded.listing_product_id,
  shop_key = excluded.shop_key,
  source_id = excluded.source_id,
  price_yen = excluded.price_yen,
  observed_at = excluded.observed_at;

-- Replace Step 1's deactivation trigger so a strong sold-out signal already captured while active
-- is not counted again when that same listing later disappears. If sold_out and deactivation happen
-- in one UPDATE, both triggers share the same event key, so trigger execution order is immaterial.
DROP TRIGGER IF EXISTS trg_price_index_listing_deactivate;
CREATE TRIGGER trg_price_index_listing_deactivate
AFTER UPDATE OF is_active ON products
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  INSERT INTO knowledge_catalog_price_index_samples(
    event_key,
    catalog_product_id,
    listing_product_id,
    source_price_history_id,
    shop_key,
    source_id,
    sample_kind,
    signal_kind,
    price_yen,
    observed_at
  )
  SELECT
    CASE
      WHEN NEW.stock_status = 'sold_out'
        THEN 'sold-out-observed:' || NEW.id || ':' || COALESCE(
          NULLIF(NEW.last_changed_at, ''),
          NULLIF(NEW.last_inventory_checked_at, ''),
          NULLIF(NEW.last_seen_at, ''),
          'unknown'
        )
      ELSE 'listing-end:' || NEW.id || ':' || COALESCE(OLD.last_seen_at, '')
    END,
    pir.catalog_product_id,
    NEW.id,
    NULL,
    NEW.shop_key,
    NEW.source_id,
    'listing_end',
    CASE WHEN NEW.stock_status = 'sold_out' THEN 'sold_out' ELSE 'deactivated' END,
    NEW.price_yen,
    CASE
      WHEN NEW.stock_status = 'sold_out'
        THEN COALESCE(
          NULLIF(NEW.last_changed_at, ''),
          NULLIF(NEW.last_inventory_checked_at, ''),
          NULLIF(NEW.last_seen_at, ''),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    END
  FROM product_identity_resolutions pir
  WHERE pir.listing_product_id = NEW.id
    AND pir.status = 'matched'
    AND pir.catalog_product_id IS NOT NULL
    AND (
      NEW.stock_status <> 'sold_out'
      OR NOT EXISTS (
        SELECT 1
        FROM knowledge_catalog_price_index_samples s
        WHERE s.listing_product_id = NEW.id
          AND s.signal_kind = 'sold_out'
      )
    )
  ON CONFLICT(event_key) DO UPDATE SET
    catalog_product_id = excluded.catalog_product_id,
    signal_kind = excluded.signal_kind,
    shop_key = excluded.shop_key,
    source_id = excluded.source_id,
    price_yen = excluded.price_yen,
    observed_at = excluded.observed_at;
END;
