-- TakeT official product evidence: https://taket.jp/japanese/ws/ws.html
-- AudioUnion writes this verified manufacturer as `Take T` and appends the seller category
-- `(リスト・サウンド)` to the model. Register the identity and catalog product, then make only
-- affected legacy manufacturer rows eligible for the normal remediation path.
INSERT INTO knowledge_catalog_manufacturers (
  id, canonical_name, name_ja, name_en, verification_status, source, provenance_json,
  created_at, updated_at
)
SELECT 'taket', 'TakeT', 'テイクティ', 'TakeT', 'verified',
  'https://taket.jp/japanese/ws/ws.html', '{"reason":"taket_ws_official_catalog"}',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS (SELECT 1 FROM knowledge_catalog_manufacturers WHERE id='taket');

WITH spellings(alias, normalized_alias) AS (VALUES
  ('Take T', 'taket'),
  ('テイクティ', 'テイクティ')
)
INSERT INTO knowledge_catalog_manufacturer_aliases (
  manufacturer_id, alias, normalized_alias, verification_status, source, provenance_json,
  rule_version, created_at, updated_at
)
SELECT 'taket', alias, normalized_alias, 'verified', 'https://taket.jp/japanese/ws/ws.html',
  '{"reason":"taket_ws_official_catalog"}', 16,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM spellings
WHERE EXISTS (SELECT 1 FROM knowledge_catalog_manufacturers WHERE id='taket')
  AND NOT EXISTS (
    SELECT 1 FROM knowledge_catalog_manufacturer_aliases existing
    WHERE existing.manufacturer_id='taket'
      AND existing.normalized_alias=spellings.normalized_alias
  );

INSERT INTO knowledge_catalog_products (
  manufacturer_id, canonical_model, normalized_model, canonical_name,
  lifecycle_status, verification_status, review_status,
  first_verified_at, last_verified_at, last_reviewed_at, created_at, updated_at
)
SELECT 'taket', 'TAKET-WS', 'TAKETWS', 'TakeT TAKET-WS',
  'active', 'verified', 'current',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_catalog_products
  WHERE manufacturer_id='taket' AND normalized_model='TAKETWS'
);

INSERT OR IGNORE INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
SELECT id, 'SPK.LOUDSPEAKER', 1 FROM knowledge_catalog_products
WHERE manufacturer_id='taket' AND normalized_model='TAKETWS'
  AND NOT EXISTS (
    SELECT 1 FROM knowledge_catalog_product_categories existing
    WHERE existing.product_id=knowledge_catalog_products.id AND existing.is_primary=1
  );

INSERT OR IGNORE INTO knowledge_catalog_sources(
  product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
)
SELECT id, 'manufacturer_official', 'https://taket.jp/japanese/ws/ws.html',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), '', 'active',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM knowledge_catalog_products
WHERE manufacturer_id='taket' AND normalized_model='TAKETWS';

UPDATE products INDEXED BY idx_products_manufacturer_id
SET manufacturer_resolver_version=15
WHERE is_active=1 AND manufacturer_id='taket' AND normalized_raw_manufacturer='taket'
  AND canonical_manufacturer_id<>'taket' AND manufacturer_resolver_version=16
  AND NOT EXISTS (
    SELECT 1 FROM product_admin_overrides o
    WHERE o.listing_product_id=products.id AND o.manufacturer_id IS NOT NULL
  );
