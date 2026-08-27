-- Repair safe exact manufacturer/model identities that are already split across multiple Product
-- Search fallback entities before the new Worker is deployed.
--
-- Runtime self-healing now detects this drift, but Production Operational Health runs immediately
-- after deployment and therefore precedes the next five-minute maintenance sweep. This migration
-- makes rollout deterministic: existing drift converges during the normal D1 migration phase, and
-- the bounded runtime repair keeps the invariant true afterwards.
--
-- The staged shape deliberately follows migration 0036. Materializing eligibility/groups avoids
-- repeating correlated exact-identity scans per listing, which previously exceeded D1's per-query
-- CPU budget. Unlike 0036, this version uses the current taxonomy semantics: both `other` and
-- `unclassified` are non-specific evidence and therefore do not veto otherwise exact grouping.

DROP TABLE IF EXISTS migration_0059_affected_entities;
DROP TABLE IF EXISTS migration_0059_groups;
DROP TABLE IF EXISTS migration_0059_eligible;

CREATE TABLE migration_0059_eligible (
  listing_id INTEGER PRIMARY KEY,
  canonical_manufacturer_id TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  primary_category_id TEXT NOT NULL,
  shop_key TEXT NOT NULL,
  current_entity_id INTEGER NOT NULL
);

-- Resolve exact-identity eligibility once and retain current membership so the next GROUP BY can
-- select only identities that are actually split. A verified Catalog match remains authoritative.
INSERT INTO migration_0059_eligible(
  listing_id,
  canonical_manufacturer_id,
  normalized_model,
  primary_category_id,
  shop_key,
  current_entity_id
)
SELECT
  p.id,
  p.canonical_manufacturer_id,
  p.normalized_model,
  p.primary_category_id,
  p.shop_key,
  membership.entity_id
FROM products p
JOIN product_search_entity_offers membership ON membership.listing_product_id = p.id
LEFT JOIN product_identity_resolutions resolution ON resolution.listing_product_id = p.id
LEFT JOIN knowledge_catalog_products catalog
  ON catalog.id = resolution.catalog_product_id
 AND resolution.status = 'matched'
 AND catalog.verification_status = 'verified'
WHERE p.is_active = 1
  AND p.model_resolution_status = 'resolved'
  AND COALESCE(p.canonical_manufacturer_id, '') <> ''
  AND COALESCE(p.normalized_model, '') <> ''
  AND catalog.id IS NULL;

CREATE INDEX migration_0059_eligible_identity
  ON migration_0059_eligible(canonical_manufacturer_id, normalized_model);

CREATE TABLE migration_0059_groups (
  canonical_manufacturer_id TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  representative_listing_id INTEGER NOT NULL,
  PRIMARY KEY(canonical_manufacturer_id, normalized_model)
);

-- Restrict the migration to persisted drift: multiple eligible listings that currently point at
-- multiple entities and have no contradictory specific category evidence.
INSERT INTO migration_0059_groups(
  canonical_manufacturer_id,
  normalized_model,
  representative_listing_id
)
SELECT
  canonical_manufacturer_id,
  normalized_model,
  MIN(listing_id)
FROM migration_0059_eligible
GROUP BY canonical_manufacturer_id, normalized_model
HAVING COUNT(*) > 1
  AND COUNT(DISTINCT current_entity_id) > 1
  AND COUNT(DISTINCT CASE
    WHEN primary_category_id NOT IN ('other', 'unclassified') THEN primary_category_id
    ELSE NULL
  END) <= 1;

CREATE TABLE migration_0059_affected_entities (
  id INTEGER PRIMARY KEY
);

-- Capture source entities before membership moves so their aggregates/categories can be refreshed
-- or the row can be pruned when it becomes empty.
INSERT OR IGNORE INTO migration_0059_affected_entities(id)
SELECT eligible.current_entity_id
FROM migration_0059_eligible eligible
JOIN migration_0059_groups grouped
  ON grouped.canonical_manufacturer_id = eligible.canonical_manufacturer_id
 AND grouped.normalized_model = eligible.normalized_model;

-- The deterministic destination is the representative listing's fallback entity. Re-create it if
-- an interrupted historical write pruned that row, and refresh its canonical seller projection.
INSERT INTO product_search_entities(
  entity_key, entity_kind, catalog_product_id, fallback_listing_id,
  manufacturer_id, manufacturer, model, normalized_model, primary_category_id,
  manufacturer_terms, model_terms, title_terms, category_terms
)
SELECT
  'l-' || p.id,
  'unresolved_listing',
  NULL,
  p.id,
  COALESCE(NULLIF(projection.manufacturer_id, ''), p.manufacturer_id),
  p.manufacturer,
  p.model,
  COALESCE(projection.normalized_model, ''),
  p.primary_category_id,
  COALESCE(NULLIF(projection.manufacturer_terms, ''), p.manufacturer),
  COALESCE(NULLIF(projection.model_terms, ''), p.model),
  '',
  ''
FROM migration_0059_groups grouped
JOIN products p ON p.id = grouped.representative_listing_id
LEFT JOIN product_search_projection projection ON projection.product_id = p.id
ON CONFLICT(entity_key) DO UPDATE SET
  manufacturer_id = excluded.manufacturer_id,
  manufacturer = excluded.manufacturer,
  model = excluded.model,
  normalized_model = excluded.normalized_model,
  primary_category_id = excluded.primary_category_id,
  manufacturer_terms = excluded.manufacturer_terms,
  model_terms = excluded.model_terms;

-- Capture the destination entity as part of the refresh set before offers move into it.
INSERT OR IGNORE INTO migration_0059_affected_entities(id)
SELECT entity.id
FROM migration_0059_groups grouped
JOIN product_search_entities entity
  ON entity.entity_key = 'l-' || grouped.representative_listing_id;

-- Converge every eligible member of each split group onto the deterministic representative entity.
INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
SELECT eligible.listing_id, entity.id, eligible.shop_key
FROM migration_0059_eligible eligible
JOIN migration_0059_groups grouped
  ON grouped.canonical_manufacturer_id = eligible.canonical_manufacturer_id
 AND grouped.normalized_model = eligible.normalized_model
JOIN product_search_entities entity
  ON entity.entity_key = 'l-' || grouped.representative_listing_id
ON CONFLICT(listing_product_id) DO UPDATE SET
  entity_id = excluded.entity_id,
  shop_key = excluded.shop_key;

-- Recompute the buyer-visible offer aggregates only for entities touched by the repair.
UPDATE product_search_entities AS entity
SET manufacturer = COALESCE(aggregate.display_manufacturer, entity.manufacturer),
    offer_count = aggregate.offer_count,
    in_stock_offer_count = aggregate.in_stock_offer_count,
    sold_out_offer_count = aggregate.sold_out_offer_count,
    shop_count = aggregate.shop_count,
    lowest_price_yen = aggregate.lowest_price_yen,
    lowest_in_stock_price_yen = aggregate.lowest_in_stock_price_yen,
    highest_price_yen = aggregate.highest_price_yen,
    latest_activity_at = aggregate.latest_activity_at,
    newest_listed_at = aggregate.newest_listed_at,
    has_price_drop = aggregate.has_price_drop
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
  JOIN migration_0059_affected_entities affected ON affected.id = membership.entity_id
  JOIN products p ON p.id = membership.listing_product_id
  WHERE p.is_active = 1
  GROUP BY membership.entity_id
) AS aggregate
WHERE entity.id = aggregate.entity_id;

-- Presentation colour is another membership-derived aggregate introduced after migration 0036.
UPDATE product_search_entities AS entity
SET presentation_colors = aggregate.presentation_colors
FROM (
  SELECT membership.entity_id AS entity_id,
         COALESCE(group_concat(DISTINCT NULLIF(p.presentation_color, '')), '') AS presentation_colors
  FROM product_search_entity_offers membership
  JOIN migration_0059_affected_entities affected ON affected.id = membership.entity_id
  JOIN products p ON p.id = membership.listing_product_id
  WHERE p.is_active = 1
  GROUP BY membership.entity_id
) AS aggregate
WHERE entity.id = aggregate.entity_id
  AND entity.presentation_colors IS NOT aggregate.presentation_colors;

-- Keep the normalized entity/category projection aligned with the moved offers. Grow first, then
-- remove stale rows, matching the runtime update order so category filtering never sees a gap.
INSERT INTO product_search_entity_categories(entity_id, category_id, is_direct)
SELECT membership.entity_id, category.category_id, MAX(category.is_direct)
FROM product_search_entity_offers membership
JOIN migration_0059_affected_entities affected ON affected.id = membership.entity_id
JOIN products p ON p.id = membership.listing_product_id
JOIN product_categories category ON category.product_id = membership.listing_product_id
WHERE p.is_active = 1
GROUP BY membership.entity_id, category.category_id
ON CONFLICT(entity_id, category_id) DO UPDATE SET is_direct = excluded.is_direct;

DELETE FROM product_search_entity_categories
WHERE entity_id IN (SELECT id FROM migration_0059_affected_entities)
  AND NOT EXISTS (
    SELECT 1
    FROM product_search_entity_offers membership
    JOIN products p ON p.id = membership.listing_product_id
    JOIN product_categories category ON category.product_id = membership.listing_product_id
    WHERE membership.entity_id = product_search_entity_categories.entity_id
      AND category.category_id = product_search_entity_categories.category_id
      AND p.is_active = 1
  );

-- Refresh the compact direct-category card/API projection from the normalized relation above.
UPDATE product_search_entities AS entity
SET direct_category_ids = aggregate.direct_category_ids
FROM (
  SELECT source.id AS entity_id,
         COALESCE(group_concat(category.category_id), '') AS direct_category_ids
  FROM product_search_entities source
  JOIN migration_0059_affected_entities affected ON affected.id = source.id
  LEFT JOIN product_search_entity_categories category
    ON category.entity_id = source.id AND category.is_direct = 1
  GROUP BY source.id
) AS aggregate
WHERE entity.id = aggregate.entity_id
  AND entity.direct_category_ids IS NOT aggregate.direct_category_ids;

-- Refresh bounded seller evidence. Updates to these columns are what keep the external-content FTS
-- table synchronized through the entity update trigger.
UPDATE product_search_entities AS entity
SET title_terms = aggregate.title_terms,
    category_terms = aggregate.category_terms
FROM (
  SELECT sample.entity_id AS entity_id,
         TRIM(COALESCE(group_concat(sample.title_terms, ' '), '')) AS title_terms,
         TRIM(COALESCE(group_concat(sample.category_terms, ' '), '')) AS category_terms
  FROM (
    SELECT membership.entity_id AS entity_id,
           TRIM(
             COALESCE(NULLIF(projection.title, ''), p.title) || ' ' ||
             COALESCE(projection.manufacturer_terms, '') || ' ' ||
             COALESCE(projection.model_terms, '')
           ) AS title_terms,
           COALESCE(NULLIF(projection.category_terms, ''), p.category) AS category_terms,
           ROW_NUMBER() OVER (PARTITION BY membership.entity_id ORDER BY p.id) AS rn
    FROM product_search_entity_offers membership
    JOIN migration_0059_affected_entities affected ON affected.id = membership.entity_id
    JOIN products p ON p.id = membership.listing_product_id
    LEFT JOIN product_search_projection projection ON projection.product_id = p.id
    WHERE p.is_active = 1
  ) sample
  WHERE sample.rn <= 3
  GROUP BY sample.entity_id
) AS aggregate
WHERE entity.id = aggregate.entity_id
  AND (entity.title_terms IS NOT aggregate.title_terms
       OR entity.category_terms IS NOT aggregate.category_terms);

-- Source fallback entities abandoned by the membership move must not remain searchable. Category
-- rows are removed by ON DELETE CASCADE.
DELETE FROM product_search_entities
WHERE id IN (SELECT id FROM migration_0059_affected_entities)
  AND NOT EXISTS (
    SELECT 1
    FROM product_search_entity_offers membership
    WHERE membership.entity_id = product_search_entities.id
  );

DROP TABLE migration_0059_affected_entities;
DROP TABLE migration_0059_groups;
DROP TABLE migration_0059_eligible;
