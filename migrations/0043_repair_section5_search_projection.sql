-- Data-quality remediation §5 follow-up: keep the product search read model transactionally aligned
-- with the bulk N-1 deactivation performed by migration 0042.
--
-- The normal crawler/remediation path repairs the same invariants in bounded batches, but 0042
-- intentionally deactivates roughly 1,700 Hifido music-software rows at once. Waiting for bounded
-- replay leaves inactive offer memberships behind long enough to fail the production deploy gate.
-- This migration mirrors the unscoped maintenance SQL in src/db/product-search-entity-sql.ts for
-- the only state transition 0042 performs: active -> inactive.

-- A deactivated listing is no longer an offer.
DELETE FROM product_search_entity_offers
WHERE listing_product_id IN (
  SELECT p.id
  FROM products p
  WHERE p.is_active = 0
);

-- Recompute buyer-visible aggregate fields for entities that still have active offers.
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

-- Removed offers must also stop contributing seller evidence to FTS-backed search terms.
UPDATE product_search_entities AS e
SET title_terms = agg.title_terms,
    category_terms = agg.category_terms
FROM (
  SELECT t.entity_id AS entity_id,
         TRIM(COALESCE(group_concat(t.title_terms, ' '), '')) AS title_terms,
         TRIM(COALESCE(group_concat(t.category_terms, ' '), '')) AS category_terms
  FROM (
    SELECT m.entity_id AS entity_id,
           TRIM(
             COALESCE(NULLIF(sp.title, ''), p.title) || ' ' ||
             COALESCE(sp.manufacturer_terms, '') || ' ' ||
             COALESCE(sp.model_terms, '')
           ) AS title_terms,
           COALESCE(NULLIF(sp.category_terms, ''), p.category) AS category_terms,
           ROW_NUMBER() OVER (PARTITION BY m.entity_id ORDER BY p.id) AS rn
    FROM product_search_entity_offers m
    JOIN products p ON p.id = m.listing_product_id
    LEFT JOIN product_search_projection sp ON sp.product_id = p.id
    WHERE p.is_active = 1
  ) t
  WHERE t.rn <= 3
  GROUP BY t.entity_id
) AS agg
WHERE e.id = agg.entity_id
  AND (e.title_terms IS NOT agg.title_terms OR e.category_terms IS NOT agg.category_terms);

-- An entity without an active offer is not a searchable product.
DELETE FROM product_search_entities
WHERE NOT EXISTS (
  SELECT 1
  FROM product_search_entity_offers m
  WHERE m.entity_id = product_search_entities.id
);
