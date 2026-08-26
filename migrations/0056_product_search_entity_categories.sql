-- Category membership at the level search actually queries.
--
-- The category filter selected on `product_search_entities.primary_category_id`: one category per
-- card. A listing that sells a transport and a DAC is in both, so filtering on the representative
-- one made it findable under whichever category happened to win and invisible under the other.
--
-- Listing membership already lives in `product_categories`, but reaching it from an entity means
-- joining through `product_search_entity_offers` on every filtered query, and measuring that
-- showed the planner abandoning the entity indexes for a scan of the offer aggregate. This is the
-- same set, projected onto the entity, so the filter stays one indexed lookup.
CREATE TABLE IF NOT EXISTS product_search_entity_categories (
  entity_id INTEGER NOT NULL,
  category_id TEXT NOT NULL,
  -- 1 when a component product of some offer is directly in this category, 0 for an ancestor
  -- carried so a parent-category filter matches.
  is_direct INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(entity_id, category_id),
  FOREIGN KEY(entity_id) REFERENCES product_search_entities(id) ON DELETE CASCADE
);

-- The filter's access path: given a category, find its entities.
CREATE INDEX IF NOT EXISTS idx_product_search_entity_categories_category
  ON product_search_entity_categories(category_id, entity_id);

-- Backfill from the listing membership the entities already have, so every card is filterable the
-- moment this deploys rather than after its next crawl.
INSERT OR IGNORE INTO product_search_entity_categories(entity_id, category_id, is_direct)
SELECT m.entity_id, pc.category_id, MAX(pc.is_direct)
FROM product_search_entity_offers m
JOIN products p ON p.id = m.listing_product_id
JOIN product_categories pc ON pc.product_id = m.listing_product_id
WHERE p.is_active = 1
GROUP BY m.entity_id, pc.category_id;

-- Entities whose listings carry no membership row at all would become unfilterable, so they keep
-- the representative category they were already filtered by.
INSERT OR IGNORE INTO product_search_entity_categories(entity_id, category_id, is_direct)
SELECT e.id, e.primary_category_id, 1
FROM product_search_entities e
WHERE e.primary_category_id <> ''
  AND NOT EXISTS (
    SELECT 1 FROM product_search_entity_categories ec WHERE ec.entity_id = e.id
  );
