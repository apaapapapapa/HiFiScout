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
