-- Keep sold-out availability distinct from unknown availability in product-level summaries.
-- This remains additive so an already-deployed Phase 4 Worker can keep reading the 0021 columns
-- while migrations run before the new Worker is deployed.
ALTER TABLE product_search_entities
ADD COLUMN sold_out_offer_count INTEGER NOT NULL DEFAULT 0;

-- Backfill the new aggregate for entities created by 0021. This intentionally matches
-- refreshEntityAggregatesSql() so migration and runtime repair converge on the same values.
UPDATE product_search_entities AS e
SET manufacturer = COALESCE(agg.display_manufacturer, e.manufacturer),
    offer_count = agg.offer_count,
    in_stock_offer_count = agg.in_stock_offer_count,
    sold_out_offer_count = agg.sold_out_offer_count,
    shop_count = agg.shop_count,
    lowest_price_yen = agg.lowest_price_yen,
    lowest_in_stock_price_yen = agg.lowest_in_stock_price_yen,
    highest_price_yen = agg.highest_price_yen,
    latest_activity_at = agg.latest_activity_at,
    newest_listed_at = agg.newest_listed_at,
    has_price_drop = agg.has_price_drop
FROM (
  SELECT m.entity_id AS entity_id,
         MIN(NULLIF(p.manufacturer, '')) AS display_manufacturer,
         COUNT(*) AS offer_count,
         SUM(CASE WHEN p.stock_status = 'in_stock' THEN 1 ELSE 0 END) AS in_stock_offer_count,
         SUM(CASE WHEN p.stock_status = 'sold_out' THEN 1 ELSE 0 END) AS sold_out_offer_count,
         COUNT(DISTINCT p.shop_key) AS shop_count,
         MIN(p.price_yen) AS lowest_price_yen,
         MIN(CASE WHEN p.stock_status = 'in_stock' THEN p.price_yen END) AS lowest_in_stock_price_yen,
         MAX(p.price_yen) AS highest_price_yen,
         MAX(p.last_activity_at) AS latest_activity_at,
         MAX(COALESCE(p.source_published_at, p.first_seen_at)) AS newest_listed_at,
         MAX(CASE
               WHEN p.previous_price_yen IS NOT NULL AND p.price_yen IS NOT NULL
                    AND p.price_yen < p.previous_price_yen THEN 1
               ELSE 0
             END) AS has_price_drop
  FROM product_search_entity_offers m
  JOIN products p ON p.id = m.listing_product_id
  WHERE p.is_active = 1
  GROUP BY m.entity_id
) AS agg
WHERE e.id = agg.entity_id;
