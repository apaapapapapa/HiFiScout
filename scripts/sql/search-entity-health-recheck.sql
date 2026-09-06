-- The caller substitutes validated integer JSON arrays, retaining the original observation's IDs.
WITH observed_listings AS MATERIALIZED (
  SELECT value AS id FROM json_each('__LISTING_IDS__')
), target_entities AS MATERIALIZED (
  SELECT value AS id FROM json_each('__ENTITY_IDS__')
  UNION SELECT m.entity_id FROM observed_listings t
    CROSS JOIN product_search_entity_offers m ON m.listing_product_id = t.id
), target_listings AS MATERIALIZED (
  SELECT id FROM observed_listings
  UNION SELECT m.listing_product_id FROM target_entities t
    CROSS JOIN product_search_entity_offers m ON m.entity_id = t.id
), scoped_entities AS MATERIALIZED (
  SELECT e.* FROM target_entities t CROSS JOIN product_search_entities e ON e.id = t.id
)
SELECT
  (SELECT COUNT(*) FROM target_listings t CROSS JOIN products p ON p.id = t.id
    WHERE p.is_active = 1 AND NOT EXISTS (
      SELECT 1 FROM product_search_entity_offers m WHERE m.listing_product_id = p.id)
  ) AS unmembered_active_listings,
  (SELECT COUNT(*) FROM target_listings t
    CROSS JOIN product_search_entity_offers m ON m.listing_product_id = t.id
    JOIN products p ON p.id = m.listing_product_id WHERE p.is_active = 0
  ) AS inactive_offer_memberships,
  (SELECT COUNT(*) FROM scoped_entities e
    WHERE NOT EXISTS (SELECT 1 FROM product_search_entity_offers m WHERE m.entity_id = e.id)
  ) AS entities_without_offers,
  (SELECT COUNT(*) FROM scoped_entities e
    WHERE e.entity_kind = 'unresolved_listing' AND EXISTS (
      SELECT 1 FROM product_identity_resolutions r JOIN knowledge_catalog_products kp
        ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
      WHERE r.listing_product_id = e.fallback_listing_id AND r.status = 'matched')
  ) AS stale_fallback_entities,
  (SELECT COUNT(*) FROM scoped_entities e
    WHERE e.entity_kind = 'catalog' AND NOT EXISTS (
      SELECT 1 FROM knowledge_catalog_products kp
      WHERE kp.id = e.catalog_product_id AND kp.verification_status = 'verified')
  ) AS ineligible_catalog_entities,
  (SELECT COUNT(*) FROM scoped_entities e
    WHERE e.offer_count <> (
      SELECT COUNT(*) FROM product_search_entity_offers m JOIN products p ON p.id = m.listing_product_id
      WHERE m.entity_id = e.id AND p.is_active = 1)
  ) AS offer_count_mismatches;
