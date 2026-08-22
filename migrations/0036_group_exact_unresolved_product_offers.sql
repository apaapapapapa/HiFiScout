-- Collapse the safe pre-catalog duplicate window in the product search read model.
--
-- Verified Knowledge Catalog matches remain authoritative. This only groups active listings whose
-- model resolver produced an exact resolved identity, whose canonical manufacturer/model are equal,
-- and whose non-`other` category evidence does not conflict. Candidates and fuzzy identity evidence
-- remain isolated. The runtime keeps this invariant after the one-time backfill.

INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
SELECT p.id, e.id, p.shop_key
FROM products p
JOIN product_search_entities e
  ON e.entity_key = 'l-' || (
    SELECT MIN(anchor.id)
    FROM products anchor
    WHERE anchor.is_active = 1
      AND anchor.model_resolution_status = 'resolved'
      AND COALESCE(anchor.canonical_manufacturer_id, '') <> ''
      AND COALESCE(anchor.normalized_model, '') <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM product_identity_resolutions r
        JOIN knowledge_catalog_products kp
          ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
        WHERE r.listing_product_id = anchor.id AND r.status = 'matched'
      )
      AND anchor.canonical_manufacturer_id = p.canonical_manufacturer_id
      AND anchor.normalized_model = p.normalized_model
  )
WHERE p.is_active = 1
  AND p.model_resolution_status = 'resolved'
  AND COALESCE(p.canonical_manufacturer_id, '') <> ''
  AND COALESCE(p.normalized_model, '') <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM product_identity_resolutions r
    JOIN knowledge_catalog_products kp
      ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
    WHERE r.listing_product_id = p.id AND r.status = 'matched'
  )
  AND (
    SELECT COUNT(DISTINCT CASE
      WHEN peer.primary_category_id <> 'other' THEN peer.primary_category_id
      ELSE NULL
    END)
    FROM products peer
    WHERE peer.is_active = 1
      AND peer.model_resolution_status = 'resolved'
      AND COALESCE(peer.canonical_manufacturer_id, '') <> ''
      AND COALESCE(peer.normalized_model, '') <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM product_identity_resolutions r
        JOIN knowledge_catalog_products kp
          ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
        WHERE r.listing_product_id = peer.id AND r.status = 'matched'
      )
      AND peer.canonical_manufacturer_id = p.canonical_manufacturer_id
      AND peer.normalized_model = p.normalized_model
  ) <= 1
ON CONFLICT(listing_product_id) DO UPDATE SET
  entity_id = excluded.entity_id,
  shop_key = excluded.shop_key;

-- Recompute the aggregates that cards and ordering read after memberships move.
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

-- Refresh bounded seller evidence so the grouped entity remains searchable by every retailer's
-- presentation. Keep the same sample bound as the runtime read-model derivation.
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

DELETE FROM product_search_entities
WHERE NOT EXISTS (
  SELECT 1 FROM product_search_entity_offers m WHERE m.entity_id = product_search_entities.id
);
