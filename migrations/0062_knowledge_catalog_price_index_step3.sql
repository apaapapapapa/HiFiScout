-- Step 3 hardening: an explicit seller sold-out observation is market evidence even while the
-- listing remains present in the crawler result set. Step 1 captured that signal only when the
-- listing was later deactivated, which loses evidence for shops (notably HiFiDo) that continue to
-- publish sold-out listings.

CREATE TRIGGER IF NOT EXISTS trg_products_price_index_sold_out_observed
AFTER UPDATE OF stock_status ON products
WHEN NEW.stock_status = 'sold_out'
 AND OLD.stock_status <> 'sold_out'
BEGIN
  INSERT INTO knowledge_catalog_price_index_samples(
    catalog_product_id,
    sample_kind,
    signal_kind,
    price_yen,
    observed_at,
    listing_product_id,
    source_price_history_id,
    event_key
  )
  SELECT r.catalog_product_id,
         'listing_end',
         'sold_out',
         NEW.price_yen,
         COALESCE(NULLIF(NEW.last_seen_at, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         NEW.id,
         NULL,
         'sold-out:' || NEW.id || ':' || COALESCE(NULLIF(NEW.last_seen_at, ''), 'unknown')
  FROM product_identity_resolutions r
  WHERE r.listing_product_id = NEW.id
    AND r.status = 'matched'
    AND r.catalog_product_id IS NOT NULL
  ON CONFLICT(event_key) DO UPDATE SET
    catalog_product_id = excluded.catalog_product_id,
    price_yen = excluded.price_yen,
    observed_at = excluded.observed_at,
    listing_product_id = excluded.listing_product_id;
END;

-- If the sold-out observation happened before identity resolution, capture the current strong
-- signal as soon as a catalog identity is inserted.
CREATE TRIGGER IF NOT EXISTS trg_identity_price_index_sold_out_insert
AFTER INSERT ON product_identity_resolutions
WHEN NEW.status = 'matched' AND NEW.catalog_product_id IS NOT NULL
BEGIN
  INSERT INTO knowledge_catalog_price_index_samples(
    catalog_product_id,
    sample_kind,
    signal_kind,
    price_yen,
    observed_at,
    listing_product_id,
    source_price_history_id,
    event_key
  )
  SELECT NEW.catalog_product_id,
         'listing_end',
         'sold_out',
         p.price_yen,
         COALESCE(NULLIF(p.last_seen_at, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         p.id,
         NULL,
         'sold-out:' || p.id || ':' || COALESCE(NULLIF(p.last_seen_at, ''), 'unknown')
  FROM products p
  WHERE p.id = NEW.listing_product_id
    AND p.stock_status = 'sold_out'
  ON CONFLICT(event_key) DO UPDATE SET
    catalog_product_id = excluded.catalog_product_id,
    price_yen = excluded.price_yen,
    observed_at = excluded.observed_at,
    listing_product_id = excluded.listing_product_id;
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
    catalog_product_id,
    sample_kind,
    signal_kind,
    price_yen,
    observed_at,
    listing_product_id,
    source_price_history_id,
    event_key
  )
  SELECT NEW.catalog_product_id,
         'listing_end',
         'sold_out',
         p.price_yen,
         COALESCE(NULLIF(p.last_seen_at, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         p.id,
         NULL,
         'sold-out:' || p.id || ':' || COALESCE(NULLIF(p.last_seen_at, ''), 'unknown')
  FROM products p
  WHERE p.id = NEW.listing_product_id
    AND p.stock_status = 'sold_out'
  ON CONFLICT(event_key) DO UPDATE SET
    catalog_product_id = excluded.catalog_product_id,
    price_yen = excluded.price_yen,
    observed_at = excluded.observed_at,
    listing_product_id = excluded.listing_product_id;
END;

-- Repair already-known active sold-out listings. Inactive rows were already eligible for the Step 1
-- deactivation trigger, so this intentionally targets the gap that review identified.
INSERT INTO knowledge_catalog_price_index_samples(
  catalog_product_id,
  sample_kind,
  signal_kind,
  price_yen,
  observed_at,
  listing_product_id,
  source_price_history_id,
  event_key
)
SELECT r.catalog_product_id,
       'listing_end',
       'sold_out',
       p.price_yen,
       COALESCE(NULLIF(p.last_seen_at, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       p.id,
       NULL,
       'sold-out:' || p.id || ':' || COALESCE(NULLIF(p.last_seen_at, ''), 'unknown')
FROM products p
JOIN product_identity_resolutions r ON r.listing_product_id = p.id
WHERE p.is_active = 1
  AND p.stock_status = 'sold_out'
  AND r.status = 'matched'
  AND r.catalog_product_id IS NOT NULL
ON CONFLICT(event_key) DO UPDATE SET
  catalog_product_id = excluded.catalog_product_id,
  price_yen = excluded.price_yen,
  observed_at = excluded.observed_at,
  listing_product_id = excluded.listing_product_id;
