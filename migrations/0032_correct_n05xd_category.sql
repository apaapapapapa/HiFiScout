-- User-confirmed primary-category policy for ESOTERIC N-05XD: although it includes DAC/preamplifier
-- functions, HiFiScout treats it as a network player. Keep this product-specific fact in the
-- verified Knowledge Catalog rather than broadening a global "network DAC" title rule.
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
  'N-05XD',
  'N-05XD',
  'N-05XD',
  'unknown',
  'verified',
  'current',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_catalog_products
  WHERE manufacturer_id = 'esoteric' AND normalized_model = 'N-05XD'
);

UPDATE knowledge_catalog_products
SET verification_status = 'verified',
    review_status = 'current',
    last_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE manufacturer_id = 'esoteric' AND normalized_model = 'N-05XD';

DELETE FROM knowledge_catalog_product_categories
WHERE product_id IN (
  SELECT id FROM knowledge_catalog_products
  WHERE manufacturer_id = 'esoteric' AND normalized_model = 'N-05XD'
);

INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
SELECT id, 'network_player', 1
FROM knowledge_catalog_products
WHERE manufacturer_id = 'esoteric' AND normalized_model = 'N-05XD';

INSERT OR IGNORE INTO knowledge_catalog_sources(
  product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
)
SELECT
  id,
  'manual_verified',
  'manual://approved-category-audit/2026-08-19',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  '',
  'active',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM knowledge_catalog_products
WHERE manufacturer_id = 'esoteric' AND normalized_model = 'N-05XD';
