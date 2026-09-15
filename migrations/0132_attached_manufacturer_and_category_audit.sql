-- The 2026-09-15 bounded production audit found one verified manufacturer spelling that existed
-- only as a combined Japanese/Latin seller alias. AVAC writes the bare official brand, so add that
-- exact spelling without broadening any prefix or shop heuristic.
INSERT INTO knowledge_catalog_manufacturer_aliases (
  manufacturer_id, alias, normalized_alias, verification_status, source, provenance_json,
  rule_version, created_at, updated_at
)
SELECT 'diatone', 'DIATONE', 'diatone', 'verified',
  'https://www.mitsubishielectric.co.jp/carele/car_diatone/',
  '{"reason":"official_brand_and_exact_seller_spelling","listingId":11945,"model":"DS-A3"}',
  16, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (
  SELECT 1 FROM knowledge_catalog_manufacturers
  WHERE id='diatone' AND canonical_name='DIATONE' AND verification_status='verified'
)
AND NOT EXISTS (
  SELECT 1 FROM knowledge_catalog_manufacturer_aliases
  WHERE manufacturer_id='diatone' AND normalized_alias='diatone'
);

-- Migration 0131 introduced this deployment-safe handoff table. The old Worker ignores it; the
-- replacement Worker consumes each exact request only after the new resolver/classifier is live.
CREATE TABLE IF NOT EXISTS data_quality_targeted_replay_requests (
  listing_product_id INTEGER PRIMARY KEY,
  request_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (listing_product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dq_targeted_replay_listing
  ON data_quality_targeted_replay_requests(listing_product_id);

INSERT INTO data_quality_targeted_replay_requests(listing_product_id,request_key,reason,created_at)
SELECT p.id,'0132-audit-20260915','attached_manufacturer_model_and_reviewed_product_type',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM products p INDEXED BY idx_products_admin_shop_cursor
WHERE p.shop_key='shimamusen'
  AND p.source_id IN ('000000019826','000000019831')
  AND p.is_active=1
  AND NOT EXISTS (
    SELECT 1 FROM product_admin_overrides o
    WHERE o.listing_product_id=p.id
      AND (o.manufacturer_id IS NOT NULL OR o.model IS NOT NULL OR o.primary_category_id IS NOT NULL)
  )
ON CONFLICT(listing_product_id) DO UPDATE SET
  request_key=excluded.request_key,reason=excluded.reason,created_at=excluded.created_at
WHERE data_quality_targeted_replay_requests.request_key<>excluded.request_key;

INSERT INTO data_quality_targeted_replay_requests(listing_product_id,request_key,reason,created_at)
SELECT p.id,'0132-audit-20260915','reviewed_exact_category',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM products p INDEXED BY idx_products_admin_shop_cursor
WHERE ((p.shop_key='hifido' AND p.source_id IN ('26-32956-21049-00','26-51044-21358-00'))
    OR (p.shop_key='audiounion' AND p.source_id='226575')
    OR (p.shop_key='avac' AND p.source_id='51990'))
  AND p.is_active=1
  AND NOT EXISTS (
    SELECT 1 FROM product_admin_overrides o
    WHERE o.listing_product_id=p.id AND o.primary_category_id IS NOT NULL
  )
ON CONFLICT(listing_product_id) DO UPDATE SET
  request_key=excluded.request_key,reason=excluded.reason,created_at=excluded.created_at
WHERE data_quality_targeted_replay_requests.request_key<>excluded.request_key;

INSERT INTO data_quality_targeted_replay_requests(listing_product_id,request_key,reason,created_at)
SELECT p.id,'0132-audit-20260915','verified_bare_manufacturer_alias',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM products p INDEXED BY idx_products_admin_shop_cursor
WHERE p.shop_key='avac' AND p.source_id='51982' AND p.is_active=1
  AND p.raw_manufacturer='DIATONE'
  AND NOT EXISTS (
    SELECT 1 FROM product_admin_overrides o
    WHERE o.listing_product_id=p.id AND o.manufacturer_id IS NOT NULL
  )
ON CONFLICT(listing_product_id) DO UPDATE SET
  request_key=excluded.request_key,reason=excluded.reason,created_at=excluded.created_at
WHERE data_quality_targeted_replay_requests.request_key<>excluded.request_key;
