-- Rebuildable, bounded market projections. Seller grades are not converted into a quality score.
CREATE TABLE catalog_market_analysis (
  catalog_product_id INTEGER PRIMARY KEY REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE,
  analysis_json TEXT NOT NULL CHECK(json_valid(analysis_json)),
  next_refresh_at TEXT NOT NULL
);
CREATE INDEX idx_catalog_market_refresh ON catalog_market_analysis(next_refresh_at,catalog_product_id);
CREATE TABLE catalog_market_dirty (
  catalog_product_id INTEGER PRIMARY KEY REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE,
  queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claim_token TEXT,
  claimed_at TEXT
);
CREATE INDEX idx_catalog_market_dirty_order ON catalog_market_dirty(queued_at,catalog_product_id) WHERE claim_token IS NULL;
CREATE INDEX idx_catalog_market_claims ON catalog_market_dirty(claimed_at,catalog_product_id) WHERE claim_token IS NOT NULL;

CREATE TRIGGER catalog_market_index_insert AFTER INSERT ON knowledge_catalog_price_indexes BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT NEW.catalog_product_id AS id) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;

CREATE TRIGGER catalog_market_index_update AFTER UPDATE ON knowledge_catalog_price_indexes BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT NEW.catalog_product_id AS id) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;

CREATE TRIGGER catalog_market_index_delete AFTER DELETE ON knowledge_catalog_price_indexes BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT OLD.catalog_product_id AS id) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;

CREATE TRIGGER catalog_market_entity_insert AFTER INSERT ON product_search_entities BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT NEW.catalog_product_id AS id WHERE NEW.catalog_product_id IS NOT NULL) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;

CREATE TRIGGER catalog_market_entity_update AFTER UPDATE OF catalog_product_id,offer_count,in_stock_offer_count,sold_out_offer_count,lowest_price_yen,highest_price_yen,latest_activity_at ON product_search_entities BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT OLD.catalog_product_id AS id WHERE OLD.catalog_product_id IS NOT NULL UNION SELECT NEW.catalog_product_id AS id WHERE NEW.catalog_product_id IS NOT NULL) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;

CREATE TRIGGER catalog_market_entity_delete AFTER DELETE ON product_search_entities BEGIN
INSERT INTO catalog_market_dirty(catalog_product_id)
  SELECT target.id FROM (SELECT OLD.catalog_product_id AS id WHERE OLD.catalog_product_id IS NOT NULL) target
  WHERE EXISTS (SELECT 1 FROM knowledge_catalog_products kp WHERE kp.id = target.id)
    AND NOT EXISTS (SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id = target.id AND d.claim_token IS NULL)
  ON CONFLICT(catalog_product_id) DO UPDATE SET claim_token=NULL;
END;

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

-- Enqueue retained catalog projections only; migration never reads the sample/history ledger.
INSERT INTO catalog_market_dirty(catalog_product_id)
SELECT catalog_product_id FROM knowledge_catalog_price_indexes
UNION SELECT catalog_product_id FROM product_search_entities WHERE catalog_product_id IS NOT NULL;
