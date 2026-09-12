-- Expand structured seller provenance while preserving all existing facts and manual decisions.
-- SQLite CHECK constraints require a table rebuild; no historical seller facts are discarded.
CREATE TABLE product_offer_facts_next (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  fact_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('seller', 'seller_detail', 'manual')),
  state TEXT NOT NULL CHECK (state IN ('present', 'absent', 'unknown')),
  source_field TEXT NOT NULL CHECK (source_field IN ('title', 'condition_text', 'detail_accessories', 'detail_condition', 'detail_warranty', 'manual')),
  rule_id TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  observed_at TEXT NOT NULL,
  warranty_months INTEGER CHECK (warranty_months IS NULL OR (fact_id = 'shop_warranty' AND state = 'present' AND typeof(warranty_months) = 'integer' AND warranty_months BETWEEN 1 AND 120)),
  PRIMARY KEY (product_id, fact_id, source),
  CHECK (source = 'manual' OR state <> 'unknown')
);


INSERT INTO product_offer_facts_next(product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at)
SELECT product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at FROM product_offer_facts;
DROP TABLE product_offer_facts;
ALTER TABLE product_offer_facts_next RENAME TO product_offer_facts;
-- Filter predicates can compare source authority directly from this covering index.
CREATE INDEX idx_product_offer_facts_filter ON product_offer_facts(fact_id,state,product_id,source);

-- Recreate the market-analysis invalidation hooks removed by the table rebuild.
CREATE TRIGGER catalog_market_fact_insert AFTER INSERT ON product_offer_facts
WHEN NEW.fact_id IN ('unused','display','outlet','used','junk','operation_unchecked','operation_fault','sale_single','sale_pair','sale_set') BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT e.catalog_product_id AS id FROM product_search_entity_offers m JOIN product_search_entities e ON e.id=m.entity_id WHERE m.listing_product_id=NEW.product_id AND e.catalog_product_id IS NOT NULL) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;

CREATE TRIGGER catalog_market_fact_update AFTER UPDATE ON product_offer_facts
WHEN NEW.fact_id IN ('unused','display','outlet','used','junk','operation_unchecked','operation_fault','sale_single','sale_pair','sale_set') BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT e.catalog_product_id AS id FROM product_search_entity_offers m JOIN product_search_entities e ON e.id=m.entity_id WHERE m.listing_product_id=NEW.product_id AND e.catalog_product_id IS NOT NULL) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;

CREATE TRIGGER catalog_market_fact_delete AFTER DELETE ON product_offer_facts
WHEN OLD.fact_id IN ('unused','display','outlet','used','junk','operation_unchecked','operation_fault','sale_single','sale_pair','sale_set') BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT e.catalog_product_id AS id FROM product_search_entity_offers m JOIN product_search_entities e ON e.id=m.entity_id WHERE m.listing_product_id=OLD.product_id AND e.catalog_product_id IS NOT NULL) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;
