-- These exact seller spellings were observed on the bounded 2026-09-14 product audit. Each
-- manufacturer is already verified in the registry; the saved HiFiDo/Fujiya listing is the
-- structured evidence for the spelling. Keep this exact-only so short brands such as MIT and RCA
-- never become prefix matches.
WITH aliases(manufacturer_id, alias, normalized_alias, source, provenance_json) AS (VALUES
  ('hamilex', 'HAMILEX ハミレックス', 'hamilexハミレックス',
    'https://www.hifido.co.jp/23-39541-12359-00.html?LNG=J',
    '{"reason":"exact_seller_spelling_review","listingId":11838,"model":"BRK-345"}'),
  ('sansui', 'SANSUI サンスイ', 'sansuiサンスイ',
    'https://www.hifido.co.jp/26-50252-14321-00.html?LNG=J',
    '{"reason":"exact_seller_spelling_review","listingId":11844,"model":"B-2105 MOS vintage"}'),
  ('diatone', 'DIATONE ダイヤトーン', 'diatoneダイヤトーン',
    'https://www.hifido.co.jp/26-51021-21166-00.html?LNG=J',
    '{"reason":"exact_seller_spelling_review","listingId":11856,"model":"DK-3"}'),
  ('transparent', 'TRANSPARENT トランスペアレント', 'transparentトランスペアレント',
    'https://www.hifido.co.jp/26-51058-21476-00.html?LNG=J',
    '{"reason":"exact_seller_spelling_review","listingId":11858,"model":"ML1/1.0m"}'),
  ('mit', 'MIT エムアイティー', 'mitエムアイティー',
    'https://www.hifido.co.jp/26-51058-21475-00.html?LNG=J',
    '{"reason":"exact_seller_spelling_review","listingId":11859,"model":"AVt 3 ic/1.5m"}'),
  ('belden', 'BELDEN ベルデン', 'beldenベルデン',
    'https://www.hifido.co.jp/26-50663-18168-00.html?LNG=J',
    '{"reason":"exact_seller_spelling_review","listingId":11861,"model":"EC-1192A/1.0m"}'),
  ('toshiba', 'TOSHIBA トウシバ', 'toshibaトウシバ',
    'https://www.hifido.co.jp/26-49978-21689-00.html?LNG=J',
    '{"reason":"exact_seller_spelling_review","listingId":11863,"model":"12AU7"}'),
  ('rca', 'RCA アールシーエー', 'rcaアールシーエー',
    'https://www.hifido.co.jp/26-26133-21683-00.html?LNG=J',
    '{"reason":"exact_seller_spelling_review","listingId":11868,"model":"5751"}'),
  ('grado', 'GRADO', 'grado',
    'https://www.fujiya-avic.co.jp/shop/g/g240004022712/',
    '{"reason":"exact_seller_spelling_review","listingId":11898,"model":"GS3000-Classic Series"}')
)
INSERT INTO knowledge_catalog_manufacturer_aliases (
  manufacturer_id, alias, normalized_alias, verification_status, source, provenance_json,
  rule_version, created_at, updated_at
)
SELECT manufacturer_id, alias, normalized_alias, 'verified', source, provenance_json, 16,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM aliases
WHERE EXISTS (
  SELECT 1 FROM knowledge_catalog_manufacturers manufacturer
  WHERE manufacturer.id=aliases.manufacturer_id AND manufacturer.verification_status='verified'
)
  AND NOT EXISTS (
    SELECT 1 FROM knowledge_catalog_manufacturer_aliases existing
    WHERE existing.manufacturer_id=aliases.manufacturer_id
      AND existing.normalized_alias=aliases.normalized_alias
  );

-- Only the exact active rows made resolvable by the aliases above are made stale. The normal
-- remediation sweep rebuilds identity grouping and the search read model; explicit admin
-- corrections are never invalidated.
UPDATE products INDEXED BY idx_products_manufacturer_id
SET manufacturer_resolver_version=1
WHERE is_active=1
  AND manufacturer_id IN (
    'hamilex', 'sansui', 'diatone', 'transparent', 'mit', 'belden', 'toshiba', 'rca', 'grado'
  )
  AND normalized_raw_manufacturer IN (
    'hamilexハミレックス',
    'sansuiサンスイ',
    'diatoneダイヤトーン',
    'transparentトランスペアレント',
    'mitエムアイティー',
    'beldenベルデン',
    'toshibaトウシバ',
    'rcaアールシーエー',
    'grado'
  )
  AND canonical_manufacturer_id<>manufacturer_id
  AND manufacturer_resolver_version<>1
  AND NOT EXISTS (
    SELECT 1 FROM product_admin_overrides override
    WHERE override.listing_product_id=products.id AND override.manufacturer_id IS NOT NULL
  );
