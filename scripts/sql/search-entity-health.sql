WITH listing_drift(kind, id) AS MATERIALIZED (
  SELECT 'unmembered_active_listings', p.id FROM products p
  WHERE p.is_active = 1 AND NOT EXISTS (
    SELECT 1 FROM product_search_entity_offers m WHERE m.listing_product_id = p.id)
  UNION ALL
  SELECT 'inactive_offer_memberships', m.listing_product_id
  FROM product_search_entity_offers m JOIN products p ON p.id = m.listing_product_id
  WHERE p.is_active = 0
), entity_drift(kind, id) AS MATERIALIZED (
  SELECT 'entities_without_offers', e.id FROM product_search_entities e
  WHERE NOT EXISTS (SELECT 1 FROM product_search_entity_offers m WHERE m.entity_id = e.id)
  UNION ALL
  SELECT 'stale_fallback_entities', e.id FROM product_search_entities e
  WHERE e.entity_kind = 'unresolved_listing' AND EXISTS (
    SELECT 1 FROM product_identity_resolutions r JOIN knowledge_catalog_products kp
      ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
    WHERE r.listing_product_id = e.fallback_listing_id AND r.status = 'matched')
  UNION ALL
  SELECT 'ineligible_catalog_entities', e.id FROM product_search_entities e
  WHERE e.entity_kind = 'catalog' AND NOT EXISTS (
    SELECT 1 FROM knowledge_catalog_products kp
    WHERE kp.id = e.catalog_product_id AND kp.verification_status = 'verified')
  UNION ALL
  SELECT 'offer_count_mismatches', e.id FROM product_search_entities e
  WHERE e.offer_count <> (
    SELECT COUNT(*) FROM product_search_entity_offers m JOIN products p ON p.id = m.listing_product_id
    WHERE m.entity_id = e.id AND p.is_active = 1)
), drift(kind, id) AS MATERIALIZED (
  SELECT kind, id FROM listing_drift
  UNION ALL SELECT kind, id FROM entity_drift
), tracked_entities AS MATERIALIZED (
  SELECT id FROM entity_drift
  UNION SELECT m.entity_id FROM listing_drift d
    CROSS JOIN product_search_entity_offers m ON m.listing_product_id = d.id
  LIMIT 1001
), tracked_listings AS (
  SELECT id FROM drift WHERE kind IN ('unmembered_active_listings', 'inactive_offer_memberships')
  UNION SELECT e.fallback_listing_id FROM tracked_entities t
    CROSS JOIN product_search_entities e ON e.id = t.id WHERE e.fallback_listing_id IS NOT NULL
  UNION SELECT m.listing_product_id FROM tracked_entities t
    CROSS JOIN product_search_entity_offers m ON m.entity_id = t.id
  LIMIT 1001
)
SELECT
  (SELECT COUNT(*) FROM product_search_entities) AS entity_count,
  (SELECT COUNT(*) FROM product_search_entities WHERE entity_kind = 'catalog') AS catalog_entity_count,
  (SELECT COUNT(*) FROM product_search_entities WHERE entity_kind = 'unresolved_listing') AS fallback_entity_count,
  (SELECT COUNT(*) FROM product_search_entities WHERE shop_count > 1) AS multi_shop_entity_count,
  (SELECT COUNT(*) FROM product_search_entity_offers) AS offer_count,
  (SELECT COUNT(*) FROM drift WHERE kind = 'unmembered_active_listings') AS unmembered_active_listings,
  (SELECT COUNT(*) FROM drift WHERE kind = 'inactive_offer_memberships') AS inactive_offer_memberships,
  (SELECT COUNT(*) FROM drift WHERE kind = 'entities_without_offers') AS entities_without_offers,
  (SELECT COUNT(*) FROM drift WHERE kind = 'stale_fallback_entities') AS stale_fallback_entities,
  (SELECT COUNT(*) FROM drift WHERE kind = 'ineligible_catalog_entities') AS ineligible_catalog_entities,
  (SELECT COUNT(*) FROM drift WHERE kind = 'offer_count_mismatches') AS offer_count_mismatches,
  (SELECT json_group_array(id) FROM tracked_entities) AS entity_ids,
  (SELECT json_group_array(id) FROM tracked_listings) AS listing_ids;
