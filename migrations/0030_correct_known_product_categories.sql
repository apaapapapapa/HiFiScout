-- Product-specific facts belong in the verified Knowledge Catalog, not in global title regexes.
-- ESOTERIC Grandioso T1 is an analog turntable; historical verification data may have recorded
-- a page-navigation category instead. Reuse an existing T1 row when present, otherwise seed the
-- seller spelling observed by U-AUDIO so the normal catalog lookup can classify it deterministically.
INSERT INTO knowledge_catalog_products(
  manufacturer_id,
  canonical_model,
  normalized_model,
  canonical_name,
  lifecycle_status,
  verification_status,
  review_status,
  first_verified_at,
  last_verified_at,
  last_reviewed_at,
  created_at,
  updated_at
)
SELECT
  'esoteric',
  'Grandioso T1',
  'GRANDIOSO T1',
  'Grandioso T1',
  'unknown',
  'verified',
  'current',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1
  FROM knowledge_catalog_products
  WHERE manufacturer_id = 'esoteric'
    AND normalized_model IN ('T1', 'GRANDIOSO T1')
);

-- If the catalog uses the manufacturer's shorter canonical spelling T1, accept the retailer's
-- "Grandioso T1" spelling as an exact model alias without creating a duplicate product row.
INSERT OR IGNORE INTO knowledge_catalog_aliases(
  product_id,
  alias,
  normalized_alias,
  alias_type,
  created_at
)
SELECT
  kp.id,
  'Grandioso T1',
  'GRANDIOSO T1',
  'model',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM knowledge_catalog_products kp
WHERE kp.manufacturer_id = 'esoteric'
  AND kp.normalized_model = 'T1'
  AND NOT EXISTS (
    SELECT 1
    FROM knowledge_catalog_products exact_product
    WHERE exact_product.manufacturer_id = 'esoteric'
      AND exact_product.normalized_model = 'GRANDIOSO T1'
  );

DELETE FROM knowledge_catalog_product_categories
WHERE product_id IN (
  SELECT id
  FROM knowledge_catalog_products
  WHERE manufacturer_id = 'esoteric'
    AND normalized_model IN ('T1', 'GRANDIOSO T1')
);

INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
SELECT id, 'turntable', 1
FROM knowledge_catalog_products
WHERE manufacturer_id = 'esoteric'
  AND normalized_model IN ('T1', 'GRANDIOSO T1');

-- Preserve the authoritative provenance of the correction. Empty hashes are valid for a manually
-- seeded source and will be replaced when the regular verifier next retrieves the page.
INSERT OR IGNORE INTO knowledge_catalog_sources(
  product_id,
  source_type,
  source_url,
  retrieved_at,
  content_hash,
  status,
  created_at,
  updated_at
)
SELECT
  id,
  'manufacturer_official',
  'https://www.esoteric.jp/jp/product/t1/top',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  '',
  'active',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM knowledge_catalog_products
WHERE manufacturer_id = 'esoteric'
  AND normalized_model IN ('T1', 'GRANDIOSO T1');
