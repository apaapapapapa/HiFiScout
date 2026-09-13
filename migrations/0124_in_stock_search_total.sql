-- The public first page asks for an exact total. Counting every in-stock search entity on each
-- regional cache miss makes reads grow with the catalog even though the projection already knows
-- when an entity enters or leaves the in-stock set. Keep one exact source-maintained total instead.
CREATE TABLE product_search_totals (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  in_stock_entity_count INTEGER NOT NULL CHECK(in_stock_entity_count >= 0)
) WITHOUT ROWID;

INSERT INTO product_search_totals(singleton, in_stock_entity_count)
SELECT 1, COUNT(*) FROM product_search_entities WHERE in_stock_offer_count > 0;

CREATE TRIGGER product_search_total_insert
AFTER INSERT ON product_search_entities
WHEN NEW.in_stock_offer_count > 0
BEGIN
  UPDATE product_search_totals
  SET in_stock_entity_count = in_stock_entity_count + 1
  WHERE singleton = 1;
END;

CREATE TRIGGER product_search_total_delete
AFTER DELETE ON product_search_entities
WHEN OLD.in_stock_offer_count > 0
BEGIN
  UPDATE product_search_totals
  SET in_stock_entity_count = in_stock_entity_count - 1
  WHERE singleton = 1;
END;

CREATE TRIGGER product_search_total_stock_transition
AFTER UPDATE OF in_stock_offer_count ON product_search_entities
WHEN (OLD.in_stock_offer_count > 0) IS NOT (NEW.in_stock_offer_count > 0)
BEGIN
  UPDATE product_search_totals
  SET in_stock_entity_count = in_stock_entity_count
    + CASE WHEN NEW.in_stock_offer_count > 0 THEN 1 ELSE -1 END
  WHERE singleton = 1;
END;
