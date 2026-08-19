-- Product-specific seller presentations approved by the 2026-08-19 category audit.
-- Keep these as explicit verified catalog aliases instead of weakening Model Resolution globally.

-- Fujiya presents the same Fiber Box 2 as "Fiber Box2 JAPAN STANDARD MODE" and strips its
-- bracketed stock/model suffix before persistence. Treat that exact spelling as an alias of the
-- already verified Fiber Box 2 JPSM product.
INSERT OR IGNORE INTO knowledge_catalog_aliases(
  product_id, alias, normalized_alias, alias_type, created_at
)
SELECT
  kp.id,
  'Fiber Box2 JAPAN STANDARD MODE',
  'FIBER BOX2 JAPAN STANDARD MODE',
  'model',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM knowledge_catalog_products kp
WHERE kp.manufacturer_id = 'ediscreation'
  AND kp.normalized_model = 'FIBER BOX 2 JPSM'
  AND EXISTS (
    SELECT 1
    FROM knowledge_catalog_sources s
    WHERE s.product_id = kp.id
      AND s.source_type = 'manual_verified'
      AND s.source_url = 'manual://approved-category-audit/2026-08-19'
      AND s.status = 'active'
  );
