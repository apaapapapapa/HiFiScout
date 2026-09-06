-- Persist in-stock sort values with the facts and memberships that define them.
-- Scoped, guarded triggers also maintain them for older Workers during rollout and rollback.
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

CREATE TRIGGER product_search_in_stock_offer_insert
AFTER INSERT ON product_search_entity_offers
BEGIN
  UPDATE product_search_entities
  SET latest_in_stock_activity_at = agg.latest_activity_at,
      newest_in_stock_listed_at = agg.newest_listed_at
  FROM (
    SELECT scoped.id AS entity_id,
           MAX(p.last_activity_at) AS latest_activity_at,
           MAX(COALESCE(p.source_published_at, p.first_seen_at)) AS newest_listed_at
    FROM product_search_entities scoped
    LEFT JOIN product_search_entity_offers m ON m.entity_id = scoped.id
    LEFT JOIN products p ON p.id = m.listing_product_id
      AND p.is_active = 1 AND p.stock_status = 'in_stock'
    WHERE scoped.id = NEW.entity_id
    GROUP BY scoped.id
  ) AS agg
  WHERE product_search_entities.id = agg.entity_id
    AND (product_search_entities.latest_in_stock_activity_at IS NOT agg.latest_activity_at
      OR product_search_entities.newest_in_stock_listed_at IS NOT agg.newest_listed_at);
END;

CREATE TRIGGER product_search_in_stock_offer_delete
AFTER DELETE ON product_search_entity_offers
BEGIN
  UPDATE product_search_entities
  SET latest_in_stock_activity_at = agg.latest_activity_at,
      newest_in_stock_listed_at = agg.newest_listed_at
  FROM (
    SELECT scoped.id AS entity_id,
           MAX(p.last_activity_at) AS latest_activity_at,
           MAX(COALESCE(p.source_published_at, p.first_seen_at)) AS newest_listed_at
    FROM product_search_entities scoped
    LEFT JOIN product_search_entity_offers m ON m.entity_id = scoped.id
    LEFT JOIN products p ON p.id = m.listing_product_id
      AND p.is_active = 1 AND p.stock_status = 'in_stock'
    WHERE scoped.id = OLD.entity_id
    GROUP BY scoped.id
  ) AS agg
  WHERE product_search_entities.id = agg.entity_id
    AND (product_search_entities.latest_in_stock_activity_at IS NOT agg.latest_activity_at
      OR product_search_entities.newest_in_stock_listed_at IS NOT agg.newest_listed_at);
END;

CREATE TRIGGER product_search_in_stock_offer_move
AFTER UPDATE OF entity_id, listing_product_id ON product_search_entity_offers
WHEN OLD.entity_id IS NOT NEW.entity_id OR OLD.listing_product_id IS NOT NEW.listing_product_id
BEGIN
  UPDATE product_search_entities
  SET latest_in_stock_activity_at = agg.latest_activity_at,
      newest_in_stock_listed_at = agg.newest_listed_at
  FROM (
    SELECT scoped.id AS entity_id,
           MAX(p.last_activity_at) AS latest_activity_at,
           MAX(COALESCE(p.source_published_at, p.first_seen_at)) AS newest_listed_at
    FROM product_search_entities scoped
    LEFT JOIN product_search_entity_offers m ON m.entity_id = scoped.id
    LEFT JOIN products p ON p.id = m.listing_product_id
      AND p.is_active = 1 AND p.stock_status = 'in_stock'
    WHERE scoped.id IN (OLD.entity_id, NEW.entity_id)
    GROUP BY scoped.id
  ) AS agg
  WHERE product_search_entities.id = agg.entity_id
    AND (product_search_entities.latest_in_stock_activity_at IS NOT agg.latest_activity_at
      OR product_search_entities.newest_in_stock_listed_at IS NOT agg.newest_listed_at);
END;

CREATE TRIGGER product_search_in_stock_listing_update
AFTER UPDATE OF is_active, stock_status, last_activity_at, first_seen_at, source_published_at ON products
WHEN OLD.is_active IS NOT NEW.is_active OR OLD.stock_status IS NOT NEW.stock_status
  OR OLD.last_activity_at IS NOT NEW.last_activity_at OR OLD.first_seen_at IS NOT NEW.first_seen_at
  OR OLD.source_published_at IS NOT NEW.source_published_at
BEGIN
  UPDATE product_search_entities
  SET latest_in_stock_activity_at = agg.latest_activity_at,
      newest_in_stock_listed_at = agg.newest_listed_at
  FROM (
    SELECT scoped.id AS entity_id,
           MAX(p.last_activity_at) AS latest_activity_at,
           MAX(COALESCE(p.source_published_at, p.first_seen_at)) AS newest_listed_at
    FROM product_search_entities scoped
    LEFT JOIN product_search_entity_offers m ON m.entity_id = scoped.id
    LEFT JOIN products p ON p.id = m.listing_product_id
      AND p.is_active = 1 AND p.stock_status = 'in_stock'
    WHERE scoped.id = (SELECT entity_id FROM product_search_entity_offers WHERE listing_product_id = NEW.id)
    GROUP BY scoped.id
  ) AS agg
  WHERE product_search_entities.id = agg.entity_id
    AND (product_search_entities.latest_in_stock_activity_at IS NOT agg.latest_activity_at
      OR product_search_entities.newest_in_stock_listed_at IS NOT agg.newest_listed_at);
END;
