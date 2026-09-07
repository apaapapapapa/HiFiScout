-- Listing facts are independent of catalog capabilities and product identity.
-- No full-catalog backfill during deployment; existing listings use bounded replay.
CREATE TABLE product_offer_facts (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  fact_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('seller', 'manual')),
  state TEXT NOT NULL CHECK (state IN ('present', 'absent', 'unknown')),
  source_field TEXT NOT NULL CHECK (source_field IN ('title', 'condition_text', 'manual')),
  rule_id TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (product_id, fact_id, source),
  CHECK (source = 'manual' OR state <> 'unknown')
) WITHOUT ROWID;

CREATE INDEX idx_product_offer_facts_filter
  ON product_offer_facts(fact_id, state, product_id);
