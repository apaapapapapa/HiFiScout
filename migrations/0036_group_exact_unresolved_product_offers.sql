-- Collapse the safe pre-catalog duplicate window in the product search read model.
--
-- Verified Knowledge Catalog matches remain authoritative. This only groups active listings whose
-- model resolver produced an exact resolved identity, whose canonical manufacturer/model are equal,
-- and whose non-`other` category evidence does not conflict. Candidates and fuzzy identity evidence
-- remain isolated. The runtime keeps this invariant after the one-time backfill.
--
-- IMPORTANT: this migration is intentionally staged through small helper tables. The original
-- implementation expressed representative/category checks as correlated subqueries for every
-- product and then re-aggregated the entire search read model. That shape exceeded Cloudflare D1's
-- per-query CPU budget in production. Here eligibility and group decisions are materialized once,
-- and only entities whose membership can change are refreshed.

-- Defensive cleanup makes a retry safe even if a previous remote attempt was interrupted after a
-- helper table was created. These names are migration-private and dropped again at the end.
DROP TABLE IF EXISTS migration_0036_affected_entities;
DROP TABLE IF EXISTS migration_0036_groups;
DROP TABLE IF EXISTS migration_0036_eligible;

CREATE TABLE migration_0036_eligible (
  listing_id INTEGER PRIMARY KEY,
  canonical_manufacturer_id TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  primary_category_id TEXT NOT NULL,
  shop_key TEXT NOT NULL
);

-- Resolve the expensive eligibility predicate once. product_identity_resolutions has one row per
-- listing, so a LEFT JOIN can express "no matched verified catalog product" without a correlated
-- NOT EXISTS for every candidate/peer/anchor comparison.
INSERT INTO migration_0036_eligible(
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

CREATE INDEX migration_0036_eligible_identity
  ON migration_0036_eligible(canonical_manufacturer_id, normalized_model);

CREATE TABLE migration_0036_groups (
  canonical_manufacturer_id TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  representative_listing_id INTEGER NOT NULL,
  PRIMARY KEY(canonical_manufacturer_id, normalized_model)
);

-- One GROUP BY replaces both the per-listing representative MIN() and category COUNT(DISTINCT)
-- subqueries. `other` remains non-contradictory evidence exactly as in the runtime rule.
INSERT INTO migration_0036_groups(
  canonical_manufacturer_id, normalized_model, representative_listing_id
)
SELECT
  canonical_manufacturer_id,
  normalized_model,
  MIN(listing_id)
FROM migration_0036_eligible
GROUP BY canonical_manufacturer_id, normalized_model
HAVING COUNT(DISTINCT CASE
  WHEN primary_category_id <> 'other' THEN primary_category_id
  ELSE NULL
END) <= 1;

CREATE TABLE migration_0036_affected_entities (
  id INTEGER PRIMARY KEY
);

-- Capture entities listings may leave so their aggregates can be refreshed or the empty row pruned.
INSERT OR IGNORE INTO migration_0036_affected_entities(id)
SELECT membership.entity_id
FROM product_search_entity_offers membership
JOIN migration_0036_eligible eligible
  ON eligible.listing_id = membership.listing_product_id
JOIN migration_0036_groups grouped
  ON grouped.canonical_manufacturer_id = eligible.canonical_manufacturer_id
 AND grouped.normalized_model = eligible.normalized_model;

INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
SELECT eligible.listing_id, entity.id, eligible.shop_key
FROM migration_0036_eligible eligible
JOIN migration_0036_groups grouped
  ON grouped.canonical_manufacturer_id = eligible.canonical_manufacturer_id
 AND grouped.normalized_model = eligible.normalized_model
JOIN product_search_entities entity
  ON entity.entity_key = 'l-' || grouped.representative_listing_id
ON CONFLICT(listing_product_id) DO UPDATE SET
  entity_id = excluded.entity_id,
  shop_key = excluded.shop_key;

-- Include destination entities as well as sources in the bounded refresh set.
INSERT OR IGNORE INTO migration_0036_affected_entities(id)
SELECT membership.entity_id
FROM product_search_entity_offers membership
JOIN migration_0036_eligible eligible
  ON eligible.listing_id = membership.listing_product_id
JOIN migration_0036_groups grouped
  ON grouped.canonical_manufacturer_id = eligible.canonical_manufacturer_id
 AND grouped.normalized_model = eligible.normalized_model;

-- Recompute only aggregates whose membership may have moved.
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
  JOIN migration_0036_affected_entities affected ON affected.id = membership.entity_id
  JOIN products p ON p.id = membership.listing_product_id
  WHERE p.is_active = 1
  GROUP BY membership.entity_id
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
    SELECT membership.entity_id AS entity_id,
           TRIM(
             COALESCE(NULLIF(sp.title, ''), p.title) || ' ' ||
             COALESCE(sp.manufacturer_terms, '') || ' ' ||
             COALESCE(sp.model_terms, '')
           ) AS title_terms,
           COALESCE(NULLIF(sp.category_terms, ''), p.category) AS category_terms,
           ROW_NUMBER() OVER (PARTITION BY membership.entity_id ORDER BY p.id) AS rn
    FROM product_search_entity_offers membership
    JOIN migration_0036_affected_entities affected ON affected.id = membership.entity_id
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
WHERE id IN (SELECT id FROM migration_0036_affected_entities)
  AND NOT EXISTS (
    SELECT 1
    FROM product_search_entity_offers membership
    WHERE membership.entity_id = product_search_entities.id
  );

DROP TABLE migration_0036_affected_entities;
DROP TABLE migration_0036_groups;
DROP TABLE migration_0036_eligible;
