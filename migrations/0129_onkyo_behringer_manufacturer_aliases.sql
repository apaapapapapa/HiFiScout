-- The verified manufacturer registry already contains ONKYO and BEHRINGER, but it lacks the exact
-- Latin-script aliases used by active seller listings. Add only those exact spellings so the
-- existing bounded manufacturer replay can converge without broad prefix inference.
WITH aliases(manufacturer_id, alias, normalized_alias, source, provenance_json) AS (VALUES
  (
    'onkyo',
    'ONKYO',
    'onkyo',
    'https://onkyo.com/tx-nr727',
    '{"reason":"official_product_brand_evidence","model":"TX-NR727"}'
  ),
  (
    'behringer',
    'BEHRINGER',
    'behringer',
    'https://www.behringer.com/en/products/0506-AAA',
    '{"reason":"official_product_brand_evidence","model":"ECM8000"}'
  )
)
INSERT INTO knowledge_catalog_manufacturer_aliases (
  manufacturer_id, alias, normalized_alias, verification_status, source, provenance_json,
  rule_version, created_at, updated_at
)
SELECT manufacturer_id, alias, normalized_alias, 'verified', source, provenance_json, 17,
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
