-- Derive in-stock sort values once, then maintain them with the existing entity aggregate refresh.
-- Older Workers can keep reading/writing their original columns during the additive rollout.
ALTER TABLE product_search_entities ADD COLUMN latest_in_stock_activity_at TEXT;
ALTER TABLE product_search_entities ADD COLUMN newest_in_stock_listed_at TEXT;

UPDATE product_search_entities AS e
SET latest_in_stock_activity_at = agg.latest_activity_at,
    newest_in_stock_listed_at = agg.newest_listed_at
FROM (
  SELECT m.entity_id,
         MAX(p.last_activity_at) AS latest_activity_at,
         MAX(COALESCE(p.source_published_at, p.first_seen_at)) AS newest_listed_at
  FROM product_search_entity_offers m
  JOIN products p ON p.id = m.listing_product_id
  WHERE p.is_active = 1 AND p.stock_status = 'in_stock'
  GROUP BY m.entity_id
) AS agg
WHERE e.id = agg.entity_id;

CREATE INDEX idx_product_search_entities_in_stock_newest
  ON product_search_entities(newest_in_stock_listed_at DESC, id DESC)
  WHERE in_stock_offer_count > 0;
CREATE INDEX idx_product_search_entities_in_stock_activity
  ON product_search_entities(latest_in_stock_activity_at DESC, id DESC)
  WHERE in_stock_offer_count > 0;
