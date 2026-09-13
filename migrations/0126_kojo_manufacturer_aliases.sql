-- KOJO TECHNOLOGY is 光城精工's audio brand: https://kojo-seiko.co.jp/
-- Preserve the existing catalog identity and explicit registry decisions. The catalog already
-- uses `kojo`; only seller-derived legacy identities need the normal bounded replay path.
INSERT INTO knowledge_catalog_manufacturers (
  id, canonical_name, name_ja, name_en, verification_status, source, provenance_json,
  created_at, updated_at
)
SELECT 'kojo', 'KOJO', '光城精工', 'KOJO TECHNOLOGY', 'verified',
  'https://kojo-seiko.co.jp/', '{"reason":"kojo_manufacturer_aliases"}',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS (SELECT 1 FROM knowledge_catalog_manufacturers WHERE id='kojo');

UPDATE knowledge_catalog_manufacturers
SET name_ja=CASE WHEN name_ja='' THEN '光城精工' ELSE name_ja END,
    name_en=CASE WHEN name_en='' THEN 'KOJO TECHNOLOGY' ELSE name_en END,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id='kojo' AND (name_ja='' OR name_en='');

WITH spellings(alias, normalized_alias) AS (VALUES
  ('KOJO', 'kojo'),
  ('KOJO TECHNOLOGY', 'kojotechnology'),
  ('光城精工', '光城精工'),
  ('コージョー', 'コージョー'),
  ('コウジョウテクノロジー', 'コウジョウテクノロジー'),
  ('KOJO TECHNOLOGY コウジョウテクノロジー', 'kojotechnologyコウジョウテクノロジー'),
  ('KOJO（光城精工）', 'kojo光城精工')
)
INSERT INTO knowledge_catalog_manufacturer_aliases (
  manufacturer_id, alias, normalized_alias, verification_status, source, provenance_json,
  rule_version, created_at, updated_at
)
SELECT 'kojo', alias, normalized_alias, 'verified', 'https://kojo-seiko.co.jp/',
  '{"reason":"kojo_manufacturer_aliases"}', 16,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM spellings
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_catalog_manufacturer_aliases existing
  WHERE existing.manufacturer_id='kojo' AND existing.normalized_alias=spellings.normalized_alias
);

-- Seek the three observed legacy IDs through idx_products_manufacturer_id. Retain raw seller data,
-- manual manufacturer overrides and existing projection tokens. No global resolver-version bump.
UPDATE products INDEXED BY idx_products_manufacturer_id
SET remediation_projection_required=1, remediation_projection_token='0126-kojo-aliases'
WHERE is_active=1 AND manufacturer_id IN ('kojo', 'kojotechnology', 'brand-1l713dr')
  AND normalized_raw_manufacturer IN (
    'kojo', 'kojotechnology', '光城精工', 'kojotechnologyコウジョウテクノロジー', 'kojo光城精工'
  )
  AND (canonical_manufacturer_id<>'kojo' OR manufacturer_id<>'kojo' OR manufacturer<>'KOJO')
  AND remediation_projection_required=0
  AND NOT EXISTS (
    SELECT 1 FROM product_admin_overrides o
    WHERE o.listing_product_id=products.id AND o.manufacturer_id IS NOT NULL
  );
