-- Repair historical Product Search drift under the current exact-identity grouping rule.
--
-- Runtime incremental sync already converges touched safe peers. Production health can still expose
-- rows created before that repair path existed, though, and waiting for an unrelated seller crawl
-- leaves duplicate cards indefinitely. This forward-only backfill replays the same conservative
-- grouping shape as migration 0036, updated for the later split between the `other` and
-- `unclassified` sentinels. Helper tables keep the work set materialized so D1 does not repeatedly
-- evaluate correlated identity/category predicates.

DROP TABLE IF EXISTS migration_0067_affected_entities;
DROP TABLE IF EXISTS migration_0067_groups;
DROP TABLE IF EXISTS migration_0067_eligible;

CREATE TABLE migration_0067_eligible (
  listing_id INTEGER PRIMARY KEY,
  canonical_manufacturer_id TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  primary_category_id TEXT NOT NULL,
  shop_key TEXT NOT NULL
);

INSERT INTO migration_0067_eligible(
  listing_id, canonical_manufacturer_id, normalized_model, primary_category_id, shop_key
)
SELECT
  p.id,
  p.canonical_manufacturer_id,
  p.normalized_model,
  p.primary_category_id,
  p.shop_key
FROM products p
LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
LEFT JOIN knowledge_catalog_products kp
  ON kp.id = r.catalog_product_id
 AND r.status = 'matched'
 AND kp.verification_status = 'verified'
WHERE p.is_active = 1
  AND p.model_resolution_status = 'resolved'
  AND COALESCE(p.canonical_manufacturer_id, '') <> ''
  AND COALESCE(p.normalized_model, '') <> ''
  AND kp.id IS NULL;

CREATE INDEX migration_0067_eligible_identity
  ON migration_0067_eligible(canonical_manufacturer_id, normalized_model);

CREATE TABLE migration_0067_groups (
  canonical_manufacturer_id TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  representative_listing_id INTEGER NOT NULL,
  PRIMARY KEY(canonical_manufacturer_id, normalized_model)
);

INSERT INTO migration_0067_groups(
  canonical_manufacturer_id, normalized_model, representative_listing_id
)
SELECT
  canonical_manufacturer_id,
  normalized_model,
  MIN(listing_id)
FROM migration_0067_eligible
GROUP BY canonical_manufacturer_id, normalized_model
HAVING COUNT(DISTINCT CASE
  WHEN primary_category_id NOT IN ('other', 'unclassified') THEN primary_category_id
  ELSE NULL
END) <= 1;

CREATE TABLE migration_0067_affected_entities (
  id INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO migration_0067_affected_entities(id)
SELECT membership.entity_id
FROM product_search_entity_offers membership
JOIN migration_0067_eligible eligible
  ON eligible.listing_id = membership.listing_product_id
JOIN migration_0067_groups grouped
  ON grouped.canonical_manufacturer_id = eligible.canonical_manufacturer_id
 AND grouped.normalized_model = eligible.normalized_model;

INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
SELECT eligible.listing_id, entity.id, eligible.shop_key
FROM migration_0067_eligible eligible
JOIN migration_0067_groups grouped
  ON grouped.canonical_manufacturer_id = eligible.canonical_manufacturer_id
 AND grouped.normalized_model = eligible.normalized_model
JOIN product_search_entities entity
  ON entity.entity_key = 'l-' || grouped.representative_listing_id
ON CONFLICT(listing_product_id) DO UPDATE SET
  entity_id = excluded.entity_id,
  shop_key = excluded.shop_key;

INSERT OR IGNORE INTO migration_0067_affected_entities(id)
SELECT membership.entity_id
FROM product_search_entity_offers membership
JOIN migration_0067_eligible eligible
  ON eligible.listing_id = membership.listing_product_id
JOIN migration_0067_groups grouped
  ON grouped.canonical_manufacturer_id = eligible.canonical_manufacturer_id
 AND grouped.normalized_model = eligible.normalized_model;

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
  SELECT membership.entity_id AS entity_id,
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
  FROM product_search_entity_offers membership
  JOIN migration_0067_affected_entities affected ON affected.id = membership.entity_id
  JOIN products p ON p.id = membership.listing_product_id
  WHERE p.is_active = 1
  GROUP BY membership.entity_id
) AS agg
WHERE e.id = agg.entity_id;

UPDATE product_search_entities AS e
SET title_terms = agg.title_terms,
    category_terms = agg.category_terms
FROM (
  SELECT t.entity_id AS entity_id,
         TRIM(COALESCE(group_concat(t.title_terms, ' '), '')) AS title_terms,
         TRIM(COALESCE(group_concat(t.category_terms, ' '), '')) AS category_terms
  FROM (
    SELECT membership.entity_id AS entity_id,
           TRIM(
             COALESCE(NULLIF(sp.title, ''), p.title) || ' ' ||
             COALESCE(sp.manufacturer_terms, '') || ' ' ||
             COALESCE(sp.model_terms, '')
           ) AS title_terms,
           COALESCE(NULLIF(sp.category_terms, ''), p.category) AS category_terms,
           ROW_NUMBER() OVER (PARTITION BY membership.entity_id ORDER BY p.id) AS rn
    FROM product_search_entity_offers membership
    JOIN migration_0067_affected_entities affected ON affected.id = membership.entity_id
    JOIN products p ON p.id = membership.listing_product_id
    LEFT JOIN product_search_projection sp ON sp.product_id = p.id
    WHERE p.is_active = 1
  ) t
  WHERE t.rn <= 3
  GROUP BY t.entity_id
) AS agg
WHERE e.id = agg.entity_id
  AND (e.title_terms IS NOT agg.title_terms OR e.category_terms IS NOT agg.category_terms);

DELETE FROM product_search_entities
WHERE id IN (SELECT id FROM migration_0067_affected_entities)
  AND NOT EXISTS (
    SELECT 1
    FROM product_search_entity_offers membership
    WHERE membership.entity_id = product_search_entities.id
  );

DROP TABLE migration_0067_affected_entities;
DROP TABLE migration_0067_groups;
DROP TABLE migration_0067_eligible;
