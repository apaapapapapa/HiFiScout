-- Prioritize the exact-identity drift that already exists when the change-driven repair queue is
-- introduced.
--
-- Migration 0074 deliberately seeded every active resolved identity so the new dirty-set path could
-- prove its trigger coverage. That is the correct safety posture, but it also means a pre-existing
-- split can sit behind thousands of clean identities. The general scheduler intentionally drains
-- only 25 identities per five-minute tick, so rollout convergence can otherwise take hours even
-- though the operational health check already knows exactly which identities are wrong.
--
-- This is a one-time rollout prioritization, not a new recurring full scan. It uses the same
-- eligibility predicate as scripts/product-search-identity-health.sh, re-marks only identities that
-- are currently split across Product Search entities, and places them ahead of the broad 0074 seed.
-- Normal post-rollout changes continue to be captured by the 0074/0076 triggers and processed with
-- the existing bounded batch size.

INSERT INTO product_search_exact_identity_dirty(
  canonical_manufacturer_id,
  normalized_model,
  marked_at,
  claimed_at
)
SELECT
  split.canonical_manufacturer_id,
  split.normalized_model,
  '1970-01-01T00:00:00.000Z',
  NULL
FROM (
  SELECT
    p.canonical_manufacturer_id,
    p.normalized_model
  FROM products p
  JOIN product_search_entity_offers m
    ON m.listing_product_id = p.id
  LEFT JOIN product_identity_resolutions r
    ON r.listing_product_id = p.id
   AND r.status = 'matched'
  LEFT JOIN knowledge_catalog_products kp
    ON kp.id = r.catalog_product_id
   AND kp.verification_status = 'verified'
  WHERE p.is_active = 1
    AND p.model_resolution_status = 'resolved'
    AND COALESCE(p.canonical_manufacturer_id, '') <> ''
    AND COALESCE(p.normalized_model, '') <> ''
    AND kp.id IS NULL
  GROUP BY p.canonical_manufacturer_id, p.normalized_model
  HAVING COUNT(*) > 1
    AND COUNT(DISTINCT m.entity_id) > 1
    AND COUNT(DISTINCT CASE
      WHEN p.primary_category_id NOT IN ('other', 'unclassified') THEN p.primary_category_id
      ELSE NULL
    END) <= 1
) AS split
-- SQLite needs a SELECT WHERE before an UPSERT clause to disambiguate ON CONFLICT from a JOIN ON.
WHERE true
ON CONFLICT(canonical_manufacturer_id, normalized_model) DO UPDATE SET
  marked_at = excluded.marked_at,
  claimed_at = NULL;
