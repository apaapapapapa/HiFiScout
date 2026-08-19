-- Explicit seller presentation accepted by the 2026-08-19 approved category audit.
-- SOtM sNH-10G and Telegartner M12 SWITCH IE GOLD are already verified as network_switch in 0031;
-- this migration only adds the remaining EDISCREATION seller spelling needed by the same audit.
-- This alias is category/identity evidence for one verified catalog product; it does not weaken
-- generic model normalization or introduce fuzzy matching.
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
  AND kp.normalized_model = 'FIBER BOX 2 JPSM';
