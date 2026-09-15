-- Grado's official Classic Series page identifies GS3000 as the model of a headphone. Fujiya
-- stores the collection name as a seller suffix (`GS3000-Classic Series`), so register the exact
-- official catalog identity and make only that observed listing eligible for model/category replay.
INSERT INTO knowledge_catalog_products (
  manufacturer_id, canonical_model, normalized_model, canonical_name,
  lifecycle_status, verification_status, review_status,
  first_verified_at, last_verified_at, last_reviewed_at, created_at, updated_at
)
SELECT 'grado', 'GS3000', 'GS3000', 'GRADO GS3000',
  'active', 'verified', 'current',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (
  SELECT 1 FROM knowledge_catalog_manufacturers
  WHERE id='grado' AND verification_status='verified'
)
  AND NOT EXISTS (
    SELECT 1 FROM knowledge_catalog_products
    WHERE manufacturer_id='grado' AND normalized_model='GS3000'
  );

INSERT OR IGNORE INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
SELECT id, 'PER.HEADPHONE', 1 FROM knowledge_catalog_products
WHERE manufacturer_id='grado' AND normalized_model='GS3000'
  AND NOT EXISTS (
    SELECT 1 FROM knowledge_catalog_product_categories existing
    WHERE existing.product_id=knowledge_catalog_products.id AND existing.is_primary=1
  );

INSERT OR IGNORE INTO knowledge_catalog_sources(
  product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
)
SELECT id, 'manufacturer_official', 'https://gradolabs.com/collections/classic-headphones',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), '', 'active',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM knowledge_catalog_products
WHERE manufacturer_id='grado' AND normalized_model='GS3000';

-- A migration is applied before the replacement Worker becomes active. Resolver-version rollback
-- is therefore unsafe: the old Worker can acknowledge it without knowing these rules. Persist the
-- exact requests in a table old Workers do not consume; the replacement Worker drains them as
-- forced `reprocess_listing` jobs and removes each request only after projections succeed.
CREATE TABLE IF NOT EXISTS data_quality_targeted_replay_requests (
  listing_product_id INTEGER PRIMARY KEY,
  request_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (listing_product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dq_targeted_replay_listing
  ON data_quality_targeted_replay_requests(listing_product_id);

-- The row requests below capture the state at migration time. The old Worker can still write during
-- the migration-before-deployment interval, so leave rule-specific scan requests that only the new
-- Worker understands. Its first bounded sweep materializes any matching rows that exist after the
-- replacement runtime is active, then removes the scan request.
CREATE TABLE IF NOT EXISTS data_quality_targeted_replay_scans (
  scan_key TEXT PRIMARY KEY,
  grado_exact_after_id INTEGER NOT NULL DEFAULT 0,
  grado_exact_done INTEGER NOT NULL DEFAULT 0,
  grado_suffix_after_id INTEGER NOT NULL DEFAULT 0,
  grado_suffix_done INTEGER NOT NULL DEFAULT 0,
  hifido_line_rca_after_id INTEGER NOT NULL DEFAULT 0,
  hifido_line_rca_done INTEGER NOT NULL DEFAULT 0,
  ear_wear_after_id INTEGER NOT NULL DEFAULT 0,
  ear_wear_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO data_quality_targeted_replay_scans(
  scan_key,created_at,updated_at
)
VALUES ('0131-grado-gs3000-mit-avt3',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Existing exact GS3000 identities from every shop need the new catalog row projected even if
-- their displayed model and category were already correct.
INSERT INTO data_quality_targeted_replay_requests(listing_product_id,request_key,reason,created_at)
SELECT id,'0131-grado-gs3000','catalog_identity_and_reviewed_product_type',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM products INDEXED BY idx_products_manufacturer_id
WHERE manufacturer_id='grado'
  AND is_active=1
  AND normalized_model='GS3000'
  AND NOT EXISTS (
    SELECT 1 FROM product_admin_overrides o
    WHERE o.listing_product_id=products.id
      AND (o.model IS NOT NULL OR o.primary_category_id IS NOT NULL)
  )
ON CONFLICT(listing_product_id) DO UPDATE SET
  request_key=excluded.request_key,
  reason=excluded.reason,
  created_at=excluded.created_at
WHERE data_quality_targeted_replay_requests.request_key<>excluded.request_key;

INSERT INTO data_quality_targeted_replay_requests(listing_product_id,request_key,reason,created_at)
SELECT id,'0131-grado-gs3000','seller_suffix_and_reviewed_product_type',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM products INDEXED BY idx_products_admin_shop_cursor
WHERE shop_key='fujiya-avic'
  AND is_active=1
  AND manufacturer_id='grado'
  AND normalized_raw_manufacturer='grado'
  AND raw_model='GS3000-Classic Series'
  AND NOT EXISTS (
    SELECT 1 FROM product_admin_overrides o
    WHERE o.listing_product_id=products.id
      AND (o.model IS NOT NULL OR o.primary_category_id IS NOT NULL)
  )
ON CONFLICT(listing_product_id) DO UPDATE SET
  request_key=excluded.request_key,
  reason=excluded.reason,
  created_at=excluded.created_at
WHERE data_quality_targeted_replay_requests.request_key<>excluded.request_key;

-- HiFiDo's exact retained path identifies a line-level RCA cable independently of manufacturer.
-- Reclassify only that exact path; broad `ケーブル` rows remain intentionally unresolved.
INSERT INTO data_quality_targeted_replay_requests(listing_product_id,request_key,reason,created_at)
SELECT id,'0131-hifido-line-rca','reviewed_exact_seller_category',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM products INDEXED BY idx_products_admin_shop_cursor
WHERE shop_key='hifido'
  AND is_active=1
  AND raw_category='ケーブル ラインRCAケーブル'
  AND NOT EXISTS (
    SELECT 1 FROM product_admin_overrides o
    WHERE o.listing_product_id=products.id AND o.primary_category_id IS NOT NULL
  )
ON CONFLICT(listing_product_id) DO UPDATE SET
  request_key=excluded.request_key,
  reason=excluded.reason,
  created_at=excluded.created_at
WHERE data_quality_targeted_replay_requests.request_key<>excluded.request_key;
