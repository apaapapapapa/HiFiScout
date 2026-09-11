-- Audit all listing/entity state; aggregate the entity flags and counts together.
-- Temporary CTEs add no persistent counters or writes to the crawler's hot path.
WITH listing_drift(kind, id) AS MATERIALIZED (
  SELECT 'unmembered_active_listings', p.id FROM products p
  WHERE p.is_active = 1 AND NOT EXISTS (
    SELECT 1 FROM product_search_entity_offers m WHERE m.listing_product_id = p.id)
  UNION ALL
  SELECT 'inactive_offer_memberships', m.listing_product_id
  FROM product_search_entity_offers m CROSS JOIN products p ON p.id = m.listing_product_id
  WHERE p.is_active = 0
), entity_state AS MATERIALIZED (
  SELECT e.id, e.entity_kind, e.fallback_listing_id, e.shop_count,
    NOT EXISTS (SELECT 1 FROM product_search_entity_offers m WHERE m.entity_id = e.id) AS entities_without_offers,
    CASE WHEN e.entity_kind = 'unresolved_listing' AND r.status = 'matched'
      AND kp.verification_status = 'verified' THEN 1 ELSE 0 END AS stale_fallback_entities,
    CASE WHEN e.entity_kind = 'catalog' AND (kp.id IS NULL OR kp.verification_status <> 'verified')
      THEN 1 ELSE 0 END AS ineligible_catalog_entities,
    e.offer_count <> (
      SELECT COUNT(*) FROM product_search_entity_offers m
      CROSS JOIN products p ON p.id = m.listing_product_id
      WHERE m.entity_id = e.id AND p.is_active = 1
    ) AS offer_count_mismatches
  FROM product_search_entities e
  LEFT JOIN product_identity_resolutions r ON r.listing_product_id = e.fallback_listing_id
  LEFT JOIN knowledge_catalog_products kp
    ON kp.id = CASE WHEN e.entity_kind = 'catalog' THEN e.catalog_product_id ELSE r.catalog_product_id END
), entity_totals AS (
  SELECT COUNT(*) AS entity_count,
    COALESCE(SUM(entity_kind = 'catalog'), 0) AS catalog_entity_count,
    COALESCE(SUM(entity_kind = 'unresolved_listing'), 0) AS fallback_entity_count,
    COALESCE(SUM(shop_count > 1), 0) AS multi_shop_entity_count,
    COALESCE(SUM(entities_without_offers), 0) AS entities_without_offers,
    COALESCE(SUM(stale_fallback_entities), 0) AS stale_fallback_entities,
    COALESCE(SUM(ineligible_catalog_entities), 0) AS ineligible_catalog_entities,
    COALESCE(SUM(offer_count_mismatches), 0) AS offer_count_mismatches
  FROM entity_state
), tracked_entities AS MATERIALIZED (
  SELECT id FROM entity_state
  WHERE entities_without_offers OR stale_fallback_entities OR ineligible_catalog_entities OR offer_count_mismatches
  UNION SELECT m.entity_id FROM listing_drift d
    CROSS JOIN product_search_entity_offers m ON m.listing_product_id = d.id
  LIMIT 1001
), tracked_listings AS (
  SELECT id FROM listing_drift
  UNION SELECT e.fallback_listing_id FROM tracked_entities t
    CROSS JOIN product_search_entities e ON e.id = t.id WHERE e.fallback_listing_id IS NOT NULL
  UNION SELECT m.listing_product_id FROM tracked_entities t
    CROSS JOIN product_search_entity_offers m ON m.entity_id = t.id
  LIMIT 1001
)
SELECT entity_totals.*,
  (SELECT COUNT(*) FROM product_search_entity_offers) AS offer_count,
  (SELECT COUNT(*) FROM listing_drift WHERE kind = 'unmembered_active_listings') AS unmembered_active_listings,
  (SELECT COUNT(*) FROM listing_drift WHERE kind = 'inactive_offer_memberships') AS inactive_offer_memberships,
  (SELECT json_group_array(id) FROM tracked_entities) AS entity_ids,
  (SELECT json_group_array(id) FROM tracked_listings) AS listing_ids
FROM entity_totals;
