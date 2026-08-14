-- Phase 4 product search: the user-facing result unit becomes a product, not a seller listing.
--
-- Purely additive. Migrations are applied before the new Worker is deployed, so the listing search
-- structures from 0017 (product_search_projection, product_search_fts) are left untouched and the
-- currently deployed Worker keeps serving traffic while these tables fill in.

-- One row per search entity: either a confirmed Knowledge Catalog product shared by every shop
-- that lists it, or a single unresolved listing standing in for itself.
CREATE TABLE IF NOT EXISTS product_search_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_key TEXT NOT NULL UNIQUE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('catalog', 'unresolved_listing')),
  catalog_product_id INTEGER,
  fallback_listing_id INTEGER,
  manufacturer_id TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  normalized_model TEXT NOT NULL DEFAULT '',
  primary_category_id TEXT NOT NULL DEFAULT 'other',
  manufacturer_terms TEXT NOT NULL DEFAULT '',
  model_terms TEXT NOT NULL DEFAULT '',
  title_terms TEXT NOT NULL DEFAULT '',
  category_terms TEXT NOT NULL DEFAULT '',
  offer_count INTEGER NOT NULL DEFAULT 0,
  in_stock_offer_count INTEGER NOT NULL DEFAULT 0,
  shop_count INTEGER NOT NULL DEFAULT 0,
  lowest_price_yen INTEGER,
  lowest_in_stock_price_yen INTEGER,
  highest_price_yen INTEGER,
  latest_activity_at TEXT,
  newest_listed_at TEXT,
  has_price_drop INTEGER NOT NULL DEFAULT 0 CHECK (has_price_drop IN (0, 1)),
  CHECK (
    (entity_kind = 'catalog' AND catalog_product_id IS NOT NULL AND fallback_listing_id IS NULL)
    OR
    (entity_kind = 'unresolved_listing' AND catalog_product_id IS NULL AND fallback_listing_id IS NOT NULL)
  ),
  FOREIGN KEY (catalog_product_id) REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE,
  FOREIGN KEY (fallback_listing_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_search_entities_newest
  ON product_search_entities(newest_listed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_product_search_entities_activity
  ON product_search_entities(latest_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_product_search_entities_price
  ON product_search_entities(lowest_price_yen, id);
CREATE INDEX IF NOT EXISTS idx_product_search_entities_in_stock_price
  ON product_search_entities(lowest_in_stock_price_yen, id);
CREATE INDEX IF NOT EXISTS idx_product_search_entities_manufacturer
  ON product_search_entities(manufacturer_id, id);
CREATE INDEX IF NOT EXISTS idx_product_search_entities_category
  ON product_search_entities(primary_category_id, id);
CREATE INDEX IF NOT EXISTS idx_product_search_entities_catalog
  ON product_search_entities(catalog_product_id)
  WHERE catalog_product_id IS NOT NULL;

-- Membership. listing_product_id is the primary key, so a listing cannot belong to two entities
-- and duplicate membership is impossible rather than merely discouraged.
CREATE TABLE IF NOT EXISTS product_search_entity_offers (
  listing_product_id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL,
  shop_key TEXT NOT NULL,
  FOREIGN KEY (listing_product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES product_search_entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_search_entity_offers_entity
  ON product_search_entity_offers(entity_id, shop_key);

CREATE VIRTUAL TABLE IF NOT EXISTS product_search_entities_fts USING fts5(
  manufacturer_terms,
  normalized_model,
  model_terms,
  title_terms,
  category_terms,
  content='product_search_entities',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS product_search_entities_ai
AFTER INSERT ON product_search_entities BEGIN
  INSERT INTO product_search_entities_fts(
    rowid, manufacturer_terms, normalized_model, model_terms, title_terms, category_terms
  ) VALUES (
    new.id, new.manufacturer_terms, new.normalized_model, new.model_terms, new.title_terms, new.category_terms
  );
END;

CREATE TRIGGER IF NOT EXISTS product_search_entities_ad
AFTER DELETE ON product_search_entities BEGIN
  INSERT INTO product_search_entities_fts(
    product_search_entities_fts, rowid, manufacturer_terms, normalized_model, model_terms, title_terms, category_terms
  ) VALUES (
    'delete', old.id, old.manufacturer_terms, old.normalized_model, old.model_terms, old.title_terms, old.category_terms
  );
END;

-- Restricted to the indexed columns: re-aggregating a price change must not rewrite the index.
CREATE TRIGGER IF NOT EXISTS product_search_entities_au
AFTER UPDATE OF manufacturer_terms, normalized_model, model_terms, title_terms, category_terms
ON product_search_entities BEGIN
  INSERT INTO product_search_entities_fts(
    product_search_entities_fts, rowid, manufacturer_terms, normalized_model, model_terms, title_terms, category_terms
  ) VALUES (
    'delete', old.id, old.manufacturer_terms, old.normalized_model, old.model_terms, old.title_terms, old.category_terms
  );
  INSERT INTO product_search_entities_fts(
    rowid, manufacturer_terms, normalized_model, model_terms, title_terms, category_terms
  ) VALUES (
    new.id, new.manufacturer_terms, new.normalized_model, new.model_terms, new.title_terms, new.category_terms
  );
END;

-- Deterministic backfill. Identical to the unscoped statements in src/db/product-search-entity-sql.ts,
-- and idempotent: entity_key and listing_product_id are unique, so re-running converges.
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
       ), 'other'),
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

INSERT INTO product_search_entities(
  entity_key, entity_kind, catalog_product_id, fallback_listing_id,
  manufacturer_id, manufacturer, model, normalized_model, primary_category_id,
  manufacturer_terms, model_terms, title_terms, category_terms
)
SELECT 'l-' || p.id, 'unresolved_listing', NULL, p.id,
       COALESCE(NULLIF(sp.manufacturer_id, ''), p.manufacturer_id),
       p.manufacturer,
       p.model,
       COALESCE(sp.normalized_model, ''),
       p.primary_category_id,
       COALESCE(NULLIF(sp.manufacturer_terms, ''), p.manufacturer),
       COALESCE(NULLIF(sp.model_terms, ''), p.model),
       '',
       ''
FROM products p
LEFT JOIN product_search_projection sp ON sp.product_id = p.id
WHERE p.is_active = 1
  AND NOT EXISTS (
    SELECT 1 FROM product_identity_resolutions r
    JOIN knowledge_catalog_products kp
      ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
    WHERE r.listing_product_id = p.id AND r.status = 'matched'
  )
ON CONFLICT(entity_key) DO UPDATE SET
  manufacturer_id = excluded.manufacturer_id,
  manufacturer = excluded.manufacturer,
  model = excluded.model,
  normalized_model = excluded.normalized_model,
  primary_category_id = excluded.primary_category_id,
  manufacturer_terms = excluded.manufacturer_terms,
  model_terms = excluded.model_terms;

DELETE FROM product_search_entity_offers
WHERE listing_product_id IN (
  SELECT m.listing_product_id
  FROM product_search_entity_offers m
  JOIN products p ON p.id = m.listing_product_id
  WHERE p.is_active = 0
);

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

-- The identity predicate is repeated rather than assumed: a fallback entity outlives the moment a
-- listing is confirmed, so joining on the key alone would pull the listing back out of the
-- canonical product it just joined.
INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
SELECT p.id, e.id, p.shop_key
FROM products p
JOIN product_search_entities e ON e.entity_key = 'l-' || p.id
WHERE p.is_active = 1
  AND NOT EXISTS (
    SELECT 1 FROM product_identity_resolutions r
    JOIN knowledge_catalog_products kp
      ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
    WHERE r.listing_product_id = p.id AND r.status = 'matched'
  )
ON CONFLICT(listing_product_id) DO UPDATE SET
  entity_id = excluded.entity_id,
  shop_key = excluded.shop_key;

UPDATE product_search_entities AS e
SET manufacturer = COALESCE(agg.display_manufacturer, e.manufacturer),
    offer_count = agg.offer_count,
    in_stock_offer_count = agg.in_stock_offer_count,
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
