-- Sale unit, power voltage and installed-option offer facts are retired with their display,
-- filters and extraction rules. Narrow the market invalidation hooks before deleting the retired
-- rows, so the deletion itself queues no market refresh.
DROP TRIGGER catalog_market_fact_insert;
DROP TRIGGER catalog_market_fact_update;
DROP TRIGGER catalog_market_fact_delete;

CREATE TRIGGER catalog_market_fact_insert AFTER INSERT ON product_offer_facts
WHEN NEW.fact_id IN ('unused','display','outlet','used','junk','operation_unchecked','operation_fault') BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT e.catalog_product_id AS id FROM product_search_entity_offers m JOIN product_search_entities e ON e.id=m.entity_id WHERE m.listing_product_id=NEW.product_id AND e.catalog_product_id IS NOT NULL) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;

CREATE TRIGGER catalog_market_fact_update AFTER UPDATE ON product_offer_facts
WHEN NEW.fact_id IN ('unused','display','outlet','used','junk','operation_unchecked','operation_fault') BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT e.catalog_product_id AS id FROM product_search_entity_offers m JOIN product_search_entities e ON e.id=m.entity_id WHERE m.listing_product_id=NEW.product_id AND e.catalog_product_id IS NOT NULL) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;

CREATE TRIGGER catalog_market_fact_delete AFTER DELETE ON product_offer_facts
WHEN OLD.fact_id IN ('unused','display','outlet','used','junk','operation_unchecked','operation_fault') BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT e.catalog_product_id AS id FROM product_search_entity_offers m JOIN product_search_entities e ON e.id=m.entity_id WHERE m.listing_product_id=OLD.product_id AND e.catalog_product_id IS NOT NULL) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;

-- Seller, seller-detail and manual rows alike; the filter index seeks each retired fact id.
DELETE FROM product_offer_facts WHERE fact_id IN (
  'sale_pair','sale_single','sale_set',
  'voltage_100v','voltage_115v','voltage_120v','voltage_220v','voltage_230v','voltage_240v','voltage_switchable',
  'option_dac','option_phono','option_network'
);

-- A projection that split one condition by sale unit cannot be merged without its listings.
-- Queue only those for the bounded hourly rebuild; every other projection is already correct.
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT a.catalog_product_id FROM catalog_market_analysis a
  WHERE (SELECT COUNT(*) > COUNT(DISTINCT json_extract(c.value,'$.condition'))
      FROM json_each(a.analysis_json,'$.current_conditions') c)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = a.catalog_product_id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;

UPDATE catalog_market_analysis SET analysis_json = json_set(analysis_json, '$.current_conditions',
  json((SELECT json_group_array(json(json_remove(c.value,'$.sale_unit')))
    FROM json_each(catalog_market_analysis.analysis_json,'$.current_conditions') c)))
WHERE EXISTS (SELECT 1 FROM json_each(analysis_json,'$.current_conditions') c
  WHERE json_type(c.value,'$.sale_unit') IS NOT NULL);

-- Replay coverage keeps only the remaining fact groups.
UPDATE product_offer_fact_replays SET coverage_json = json_set(coverage_json,
  '$.byShop', json((SELECT json_group_array(json(json_remove(r.value,'$.sale_unit','$.voltage','$.option')))
    FROM json_each(product_offer_fact_replays.coverage_json,'$.byShop') r)),
  '$.byCategory', json((SELECT json_group_array(json(json_remove(r.value,'$.sale_unit','$.voltage','$.option')))
    FROM json_each(product_offer_fact_replays.coverage_json,'$.byCategory') r)))
WHERE json_type(coverage_json,'$.byShop') = 'array' AND json_type(coverage_json,'$.byCategory') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(coverage_json,'$.byShop') r
      WHERE json_type(r.value,'$.sale_unit') IS NOT NULL OR json_type(r.value,'$.voltage') IS NOT NULL
        OR json_type(r.value,'$.option') IS NOT NULL
    UNION ALL SELECT 1 FROM json_each(coverage_json,'$.byCategory') r
      WHERE json_type(r.value,'$.sale_unit') IS NOT NULL OR json_type(r.value,'$.voltage') IS NOT NULL
        OR json_type(r.value,'$.option') IS NOT NULL);
