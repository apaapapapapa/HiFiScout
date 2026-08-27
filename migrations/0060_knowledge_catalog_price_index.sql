-- Persistent Knowledge Catalog price-index evidence.
--
-- These rows intentionally do NOT reference products or price_history with foreign keys.
-- Listing retention may delete either source table; market evidence already attributed to a
-- verified Knowledge Catalog product must survive that cleanup.
CREATE TABLE IF NOT EXISTS knowledge_catalog_price_index_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  catalog_product_id INTEGER NOT NULL,
  listing_product_id INTEGER NOT NULL,
  source_price_history_id INTEGER,
  shop_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  sample_kind TEXT NOT NULL CHECK (sample_kind IN ('asking', 'listing_end')),
  signal_kind TEXT NOT NULL CHECK (signal_kind IN ('asking', 'sold_out', 'deactivated')),
  price_yen INTEGER CHECK (price_yen IS NULL OR price_yen >= 0),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(catalog_product_id) REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE,
  CHECK (sample_kind <> 'asking' OR price_yen IS NOT NULL),
  CHECK (
    (sample_kind = 'asking' AND signal_kind = 'asking')
    OR
    (sample_kind = 'listing_end' AND signal_kind IN ('sold_out', 'deactivated'))
  )
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_price_index_samples_catalog
  ON knowledge_catalog_price_index_samples(catalog_product_id, sample_kind, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_price_index_samples_listing
  ON knowledge_catalog_price_index_samples(listing_product_id, sample_kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_catalog_price_index_samples_history
  ON knowledge_catalog_price_index_samples(source_price_history_id)
  WHERE source_price_history_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_catalog_price_indexes (
  catalog_product_id INTEGER PRIMARY KEY,
  asking_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (asking_sample_count >= 0),
  asking_median_yen INTEGER,
  asking_min_yen INTEGER,
  asking_max_yen INTEGER,
  recent_asking_median_yen INTEGER,
  listing_end_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (listing_end_sample_count >= 0),
  listing_end_median_yen INTEGER,
  sold_out_signal_count INTEGER NOT NULL DEFAULT 0 CHECK (sold_out_signal_count >= 0),
  deactivated_signal_count INTEGER NOT NULL DEFAULT 0 CHECK (deactivated_signal_count >= 0),
  last_computed_at TEXT NOT NULL,
  FOREIGN KEY(catalog_product_id) REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE
);

-- The rollup is the single definition of the price-index statistics. "Recent" means the
-- trailing 90 days at computation time. Asking/listing-end sample counts only include
-- price-bearing samples; signal counts include listing-end events even when price is unknown.
CREATE VIEW IF NOT EXISTS knowledge_catalog_price_index_rollup AS
WITH
catalog_ids AS (
  SELECT DISTINCT catalog_product_id
  FROM knowledge_catalog_price_index_samples
),
asking_ranked AS (
  SELECT
    catalog_product_id,
    price_yen,
    ROW_NUMBER() OVER (
      PARTITION BY catalog_product_id
      ORDER BY price_yen, id
    ) AS row_number,
    COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
  FROM knowledge_catalog_price_index_samples
  WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
),
asking_stats AS (
  SELECT
    catalog_product_id,
    MAX(sample_count) AS asking_sample_count,
    CAST(
      ROUND(
        AVG(
          CASE
            WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
              THEN price_yen
          END
        )
      ) AS INTEGER
    ) AS asking_median_yen,
    MIN(price_yen) AS asking_min_yen,
    MAX(price_yen) AS asking_max_yen
  FROM asking_ranked
  GROUP BY catalog_product_id
),
recent_asking_ranked AS (
  SELECT
    catalog_product_id,
    price_yen,
    ROW_NUMBER() OVER (
      PARTITION BY catalog_product_id
      ORDER BY price_yen, id
    ) AS row_number,
    COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
  FROM knowledge_catalog_price_index_samples
  WHERE sample_kind = 'asking'
    AND price_yen IS NOT NULL
    AND julianday(observed_at) >= julianday('now', '-90 days')
),
recent_asking_stats AS (
  SELECT
    catalog_product_id,
    CAST(
      ROUND(
        AVG(
          CASE
            WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
              THEN price_yen
          END
        )
      ) AS INTEGER
    ) AS recent_asking_median_yen
  FROM recent_asking_ranked
  GROUP BY catalog_product_id
),
listing_end_ranked AS (
  SELECT
    catalog_product_id,
    price_yen,
    ROW_NUMBER() OVER (
      PARTITION BY catalog_product_id
      ORDER BY price_yen, id
    ) AS row_number,
    COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
  FROM knowledge_catalog_price_index_samples
  WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
),
listing_end_stats AS (
  SELECT
    catalog_product_id,
    MAX(sample_count) AS listing_end_sample_count,
    CAST(
      ROUND(
        AVG(
          CASE
            WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
              THEN price_yen
          END
        )
      ) AS INTEGER
    ) AS listing_end_median_yen
  FROM listing_end_ranked
  GROUP BY catalog_product_id
),
signal_stats AS (
  SELECT
    catalog_product_id,
    SUM(
      CASE
        WHEN sample_kind = 'listing_end' AND signal_kind = 'sold_out' THEN 1
        ELSE 0
      END
    ) AS sold_out_signal_count,
    SUM(
      CASE
        WHEN sample_kind = 'listing_end' AND signal_kind = 'deactivated' THEN 1
        ELSE 0
      END
    ) AS deactivated_signal_count
  FROM knowledge_catalog_price_index_samples
  GROUP BY catalog_product_id
)
SELECT
  catalog_ids.catalog_product_id,
  COALESCE(asking_stats.asking_sample_count, 0) AS asking_sample_count,
  asking_stats.asking_median_yen,
  asking_stats.asking_min_yen,
  asking_stats.asking_max_yen,
  recent_asking_stats.recent_asking_median_yen,
  COALESCE(listing_end_stats.listing_end_sample_count, 0) AS listing_end_sample_count,
  listing_end_stats.listing_end_median_yen,
  COALESCE(signal_stats.sold_out_signal_count, 0) AS sold_out_signal_count,
  COALESCE(signal_stats.deactivated_signal_count, 0) AS deactivated_signal_count
FROM catalog_ids
LEFT JOIN asking_stats USING (catalog_product_id)
LEFT JOIN recent_asking_stats USING (catalog_product_id)
LEFT JOIN listing_end_stats USING (catalog_product_id)
LEFT JOIN signal_stats USING (catalog_product_id);

-- Existing price_history is copied once into the retention-safe ledger. Listing-end history
-- cannot be reconstructed reliably from old rows, so it starts accumulating from this migration.
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
  'asking:price-history:' || ph.id,
  pir.catalog_product_id,
  p.id,
  ph.id,
  p.shop_key,
  p.source_id,
  'asking',
  'asking',
  ph.price_yen,
  ph.observed_at
FROM price_history ph
JOIN products p ON p.id = ph.product_id
JOIN product_identity_resolutions pir ON pir.listing_product_id = p.id
WHERE pir.status = 'matched'
  AND pir.catalog_product_id IS NOT NULL
ON CONFLICT(event_key) DO UPDATE SET
  catalog_product_id = excluded.catalog_product_id,
  listing_product_id = excluded.listing_product_id,
  source_price_history_id = excluded.source_price_history_id,
  shop_key = excluded.shop_key,
  source_id = excluded.source_id,
  price_yen = excluded.price_yen,
  observed_at = excluded.observed_at;

INSERT OR REPLACE INTO knowledge_catalog_price_indexes(
  catalog_product_id,
  asking_sample_count,
  asking_median_yen,
  asking_min_yen,
  asking_max_yen,
  recent_asking_median_yen,
  listing_end_sample_count,
  listing_end_median_yen,
  sold_out_signal_count,
  deactivated_signal_count,
  last_computed_at
)
SELECT
  catalog_product_id,
  asking_sample_count,
  asking_median_yen,
  asking_min_yen,
  asking_max_yen,
  recent_asking_median_yen,
  listing_end_sample_count,
  listing_end_median_yen,
  sold_out_signal_count,
  deactivated_signal_count,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM knowledge_catalog_price_index_rollup;

-- Keep the persistent aggregate synchronized whenever retention-safe evidence changes.
CREATE TRIGGER IF NOT EXISTS trg_price_index_sample_insert
AFTER INSERT ON knowledge_catalog_price_index_samples
BEGIN
  INSERT OR REPLACE INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  SELECT
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM knowledge_catalog_price_index_rollup
  WHERE catalog_product_id = NEW.catalog_product_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_price_index_sample_delete
AFTER DELETE ON knowledge_catalog_price_index_samples
BEGIN
  DELETE FROM knowledge_catalog_price_indexes
  WHERE catalog_product_id = OLD.catalog_product_id
    AND NOT EXISTS (
      SELECT 1
      FROM knowledge_catalog_price_index_samples
      WHERE catalog_product_id = OLD.catalog_product_id
    );

  INSERT OR REPLACE INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  SELECT
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM knowledge_catalog_price_index_rollup
  WHERE catalog_product_id = OLD.catalog_product_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_price_index_sample_update
AFTER UPDATE OF catalog_product_id, sample_kind, signal_kind, price_yen, observed_at
ON knowledge_catalog_price_index_samples
BEGIN
  DELETE FROM knowledge_catalog_price_indexes
  WHERE catalog_product_id = OLD.catalog_product_id
    AND NOT EXISTS (
      SELECT 1
      FROM knowledge_catalog_price_index_samples
      WHERE catalog_product_id = OLD.catalog_product_id
    );

  INSERT OR REPLACE INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  SELECT
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM knowledge_catalog_price_index_rollup
  WHERE catalog_product_id = OLD.catalog_product_id;

  INSERT OR REPLACE INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  SELECT
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM knowledge_catalog_price_index_rollup
  WHERE catalog_product_id = NEW.catalog_product_id;
END;

-- Price changes enter price_history in the existing crawler write path. Capture that row
-- atomically when the listing already has a matched Knowledge Catalog identity.
CREATE TRIGGER IF NOT EXISTS trg_price_index_price_history_insert
AFTER INSERT ON price_history
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
    'asking:price-history:' || NEW.id,
    pir.catalog_product_id,
    p.id,
    NEW.id,
    p.shop_key,
    p.source_id,
    'asking',
    'asking',
    NEW.price_yen,
    NEW.observed_at
  FROM products p
  JOIN product_identity_resolutions pir ON pir.listing_product_id = p.id
  WHERE p.id = NEW.product_id
    AND pir.status = 'matched'
    AND pir.catalog_product_id IS NOT NULL
  ON CONFLICT(event_key) DO UPDATE SET
    catalog_product_id = excluded.catalog_product_id,
    listing_product_id = excluded.listing_product_id,
    source_price_history_id = excluded.source_price_history_id,
    shop_key = excluded.shop_key,
    source_id = excluded.source_id,
    price_yen = excluded.price_yen,
    observed_at = excluded.observed_at;
END;

-- New listings often receive their identity after their initial price_history row. Backfill all
-- retained price points as soon as that identity becomes matched.
CREATE TRIGGER IF NOT EXISTS trg_price_index_identity_insert
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
    'asking:price-history:' || ph.id,
    NEW.catalog_product_id,
    p.id,
    ph.id,
    p.shop_key,
    p.source_id,
    'asking',
    'asking',
    ph.price_yen,
    ph.observed_at
  FROM products p
  JOIN price_history ph ON ph.product_id = p.id
  WHERE p.id = NEW.listing_product_id
  ON CONFLICT(event_key) DO UPDATE SET
    catalog_product_id = excluded.catalog_product_id
  WHERE knowledge_catalog_price_index_samples.catalog_product_id <> excluded.catalog_product_id;
END;

-- If identity evidence is corrected from one matched catalog product to another, move all
-- retained evidence while the source listing still exists.
CREATE TRIGGER IF NOT EXISTS trg_price_index_identity_reassign
AFTER UPDATE OF catalog_product_id, status ON product_identity_resolutions
WHEN NEW.status = 'matched' AND NEW.catalog_product_id IS NOT NULL
BEGIN
  UPDATE knowledge_catalog_price_index_samples
  SET catalog_product_id = NEW.catalog_product_id
  WHERE listing_product_id = NEW.listing_product_id
    AND catalog_product_id <> NEW.catalog_product_id;

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
    'asking:price-history:' || ph.id,
    NEW.catalog_product_id,
    p.id,
    ph.id,
    p.shop_key,
    p.source_id,
    'asking',
    'asking',
    ph.price_yen,
    ph.observed_at
  FROM products p
  JOIN price_history ph ON ph.product_id = p.id
  WHERE p.id = NEW.listing_product_id
  ON CONFLICT(event_key) DO UPDATE SET
    catalog_product_id = excluded.catalog_product_id
  WHERE knowledge_catalog_price_index_samples.catalog_product_id <> excluded.catalog_product_id;
END;

-- An explicit transition from matched to unresolved removes the attribution while the source
-- listing is still retained. Product/price_history deletion itself intentionally does not.
CREATE TRIGGER IF NOT EXISTS trg_price_index_identity_unmatch
AFTER UPDATE OF catalog_product_id, status ON product_identity_resolutions
WHEN NEW.status <> 'matched' OR NEW.catalog_product_id IS NULL
BEGIN
  DELETE FROM knowledge_catalog_price_index_samples
  WHERE listing_product_id = NEW.listing_product_id;
END;

-- Deactivation is the weaker generic listing-end signal. HiFiDo and any other adapter that
-- explicitly reports stock_status='sold_out' contributes the stronger sold-out signal instead.
-- last_seen_at is part of the event key so retries are idempotent while a later reactivation can
-- legitimately produce a new listing-end event.
CREATE TRIGGER IF NOT EXISTS trg_price_index_listing_deactivate
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
    'listing-end:' || NEW.id || ':' || COALESCE(OLD.last_seen_at, ''),
    pir.catalog_product_id,
    NEW.id,
    NULL,
    NEW.shop_key,
    NEW.source_id,
    'listing_end',
    CASE WHEN NEW.stock_status = 'sold_out' THEN 'sold_out' ELSE 'deactivated' END,
    NEW.price_yen,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM product_identity_resolutions pir
  WHERE pir.listing_product_id = NEW.id
    AND pir.status = 'matched'
    AND pir.catalog_product_id IS NOT NULL
  ON CONFLICT(event_key) DO UPDATE SET
    catalog_product_id = excluded.catalog_product_id,
    signal_kind = excluded.signal_kind,
    price_yen = excluded.price_yen;
END;
