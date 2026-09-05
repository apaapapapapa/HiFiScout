-- Reparent tape equipment without renaming durable leaf IDs. The previous runtime can still
-- read/write ANA.TAPE between migration and deployment. Classifier version 18 replays derived
-- fields/facets in bounded pages; this migration only repairs affected ancestor memberships.
-- Raw evidence, primary categories, identities, prices and decision timestamps are unchanged.

UPDATE product_admin_overrides
SET category_ids = json_array('ANA.TAPE', 'SRC')
WHERE primary_category_id = 'ANA.TAPE'
  AND category_ids IS NOT json_array('ANA.TAPE', 'SRC');

-- The override owns the leaf; reparenting that same leaf must also repair its ancestor.
DROP TRIGGER product_admin_overrides_categories_bd;

DELETE FROM product_categories
WHERE category_id = 'ANA' AND is_direct = 0
  AND product_id IN (SELECT product_id FROM product_categories WHERE category_id = 'ANA.TAPE')
  AND NOT EXISTS (
    SELECT 1 FROM product_categories sibling
    WHERE sibling.product_id = product_categories.product_id AND sibling.is_direct = 1
      AND sibling.category_id IN ('ANA.TURNTABLE', 'ANA.TONEARM', 'ANA.CARTRIDGE', 'ANA.STYLUS', 'ANA.HEADSHELL')
  );

CREATE TRIGGER product_admin_overrides_categories_bd
BEFORE DELETE ON product_categories
WHEN EXISTS (
  SELECT 1 FROM product_admin_overrides o
  WHERE o.listing_product_id = OLD.product_id AND o.primary_category_id IS NOT NULL
)
BEGIN
  SELECT RAISE(IGNORE);
END;

INSERT OR IGNORE INTO product_categories(product_id, category_id, is_direct)
SELECT product_id, 'SRC', 0 FROM product_categories WHERE category_id = 'ANA.TAPE';

DELETE FROM product_search_entity_categories
WHERE category_id = 'ANA' AND is_direct = 0
  AND entity_id IN (SELECT entity_id FROM product_search_entity_categories WHERE category_id = 'ANA.TAPE')
  AND NOT EXISTS (
    SELECT 1 FROM product_search_entity_categories sibling
    WHERE sibling.entity_id = product_search_entity_categories.entity_id AND sibling.is_direct = 1
      AND sibling.category_id IN ('ANA.TURNTABLE', 'ANA.TONEARM', 'ANA.CARTRIDGE', 'ANA.STYLUS', 'ANA.HEADSHELL')
  );

INSERT OR IGNORE INTO product_search_entity_categories(entity_id, category_id, is_direct)
SELECT entity_id, 'SRC', 0 FROM product_search_entity_categories WHERE category_id = 'ANA.TAPE';
