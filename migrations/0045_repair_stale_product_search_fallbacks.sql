-- Repair Product Search entities whose upstream Product Identity already moved to a verified
-- Knowledge Catalog product while the read-model membership was left on an unresolved fallback.
--
-- This mirrors the relevant unscoped maintenance SQL in src/db/product-search-entity-sql.ts. The
-- statements are idempotent: Catalog entities converge on entity_key, memberships converge on
-- listing_product_id, and the abandoned fallback entity is removed after its offer moves.

-- Ensure every verified Catalog product needed by an active matched listing has an entity.
INSERT INTO product_search_entities(
  entity_key, entity_kind, catalog_product_id, fallback_listing_id,
  manufacturer_id, manufacturer, model, normalized_model, primary_category_id,
  manufacturer_terms, model_terms, title_terms, category_terms
)
SELECT 'c-' || kp.id, 'catalog', kp.id, NULL,
       kp.manufacturer_id,
       '',
       kp.canonical_model,
       kp.normalized_model,
       COALESCE((
         SELECT kpc.category_id FROM knowledge_catalog_product_categories kpc
         WHERE kpc.product_id = kp.id
         ORDER BY kpc.is_primary DESC, kpc.category_id
         LIMIT 1
       ), 'unclassified'),
       TRIM(kp.manufacturer_id),
       TRIM(
         kp.canonical_model || ' ' || kp.normalized_model || ' ' ||
         COALESCE((
           SELECT group_concat(a.alias, ' ') FROM knowledge_catalog_aliases a
           WHERE a.product_id = kp.id AND a.alias_type = 'model'
         ), '')
       ),
       '',
       ''
FROM knowledge_catalog_products kp
WHERE kp.verification_status = 'verified'
  AND EXISTS (
    SELECT 1 FROM product_identity_resolutions r
    JOIN products p ON p.id = r.listing_product_id
    WHERE r.catalog_product_id = kp.id AND r.status = 'matched' AND p.is_active = 1
  )
ON CONFLICT(entity_key) DO UPDATE SET
  manufacturer_id = excluded.manufacturer_id,
  model = excluded.model,
  normalized_model = excluded.normalized_model,
  primary_category_id = excluded.primary_category_id,
  manufacturer_terms = excluded.manufacturer_terms,
  model_terms = excluded.model_terms;

-- Move every active, verified Catalog match to its authoritative Catalog entity. This is broader
-- than the single observed stale row by design and makes the migration safe against concurrent
-- historical drift of the same class.
INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
SELECT p.id, e.id, p.shop_key
FROM products p
JOIN product_identity_resolutions r ON r.listing_product_id = p.id AND r.status = 'matched'
JOIN knowledge_catalog_products kp
  ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
JOIN product_search_entities e ON e.entity_key = 'c-' || kp.id
WHERE p.is_active = 1
ON CONFLICT(listing_product_id) DO UPDATE SET
  entity_id = excluded.entity_id,
  shop_key = excluded.shop_key;

-- Recompute buyer-visible aggregates after memberships move.
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

-- Refresh FTS-backed seller evidence for both the Catalog entity that gained the offer and any
-- other entities touched by historical membership changes.
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

-- The stale fallback entity now has no offer and must not remain searchable.
DELETE FROM product_search_entities
WHERE NOT EXISTS (
  SELECT 1 FROM product_search_entity_offers m WHERE m.entity_id = product_search_entities.id
);
