-- Membership transitions need a durable obligation separate from full listing projections.
-- Otherwise an interrupted Identity -> Search write waits for a whole audit cursor cycle.
CREATE TABLE product_search_catalog_pending (
  listing_product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_product_search_catalog_pending_attempt
  ON product_search_catalog_pending(last_attempt_at, listing_product_id);

CREATE TRIGGER product_identity_catalog_membership_insert
AFTER INSERT ON product_identity_resolutions
WHEN NEW.status = 'matched' AND NEW.catalog_product_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM knowledge_catalog_products kp
    WHERE kp.id = NEW.catalog_product_id AND kp.verification_status = 'verified'
  )
  AND EXISTS (
    SELECT 1 FROM product_search_entity_offers o
    JOIN product_search_entities e ON e.id = o.entity_id
    WHERE o.listing_product_id = NEW.listing_product_id
      AND (e.entity_kind <> 'catalog' OR e.catalog_product_id IS NOT NEW.catalog_product_id)
  )
BEGIN
  INSERT INTO product_search_catalog_pending(listing_product_id, token)
  VALUES (NEW.listing_product_id, lower(hex(randomblob(16))))
  ON CONFLICT(listing_product_id) DO UPDATE SET token = excluded.token, last_attempt_at = '';
END;

CREATE TRIGGER product_identity_catalog_membership_update
AFTER UPDATE OF status, catalog_product_id ON product_identity_resolutions
WHEN (OLD.status IS NOT NEW.status OR OLD.catalog_product_id IS NOT NEW.catalog_product_id)
  AND NEW.status = 'matched' AND NEW.catalog_product_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM knowledge_catalog_products kp
    WHERE kp.id = NEW.catalog_product_id AND kp.verification_status = 'verified'
  )
  AND EXISTS (
    SELECT 1 FROM product_search_entity_offers o
    JOIN product_search_entities e ON e.id = o.entity_id
    WHERE o.listing_product_id = NEW.listing_product_id
      AND (e.entity_kind <> 'catalog' OR e.catalog_product_id IS NOT NEW.catalog_product_id)
  )
BEGIN
  INSERT INTO product_search_catalog_pending(listing_product_id, token)
  VALUES (NEW.listing_product_id, lower(hex(randomblob(16))))
  ON CONFLICT(listing_product_id) DO UPDATE SET token = excluded.token, last_attempt_at = '';
END;

CREATE TRIGGER knowledge_catalog_verified_membership_update
AFTER UPDATE OF verification_status ON knowledge_catalog_products
WHEN OLD.verification_status IS NOT NEW.verification_status AND NEW.verification_status = 'verified'
BEGIN
  INSERT INTO product_search_catalog_pending(listing_product_id, token)
  SELECT r.listing_product_id, lower(hex(randomblob(16)))
  FROM product_identity_resolutions r
  JOIN product_search_entity_offers o ON o.listing_product_id = r.listing_product_id
  JOIN product_search_entities e ON e.id = o.entity_id
  WHERE r.catalog_product_id = NEW.id AND r.status = 'matched'
    AND (e.entity_kind <> 'catalog' OR e.catalog_product_id IS NOT NEW.id)
  ON CONFLICT(listing_product_id) DO UPDATE SET token = excluded.token, last_attempt_at = '';
END;

-- Capture only mismatched verified memberships, without rewriting listings or history.
INSERT INTO product_search_catalog_pending(listing_product_id, token)
SELECT r.listing_product_id, lower(hex(randomblob(16)))
FROM product_identity_resolutions r
JOIN knowledge_catalog_products kp ON kp.id = r.catalog_product_id
JOIN product_search_entity_offers o ON o.listing_product_id = r.listing_product_id
JOIN product_search_entities e ON e.id = o.entity_id
WHERE r.status = 'matched' AND kp.verification_status = 'verified'
  AND (e.entity_kind <> 'catalog' OR e.catalog_product_id IS NOT r.catalog_product_id);
