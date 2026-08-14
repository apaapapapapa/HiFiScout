-- Phase 1 rollout cleanup: all production search callers use product_search_fts now, so the
-- legacy external-content FTS table and its products triggers only add duplicate write/storage cost.
DROP TRIGGER IF EXISTS products_fts_ai;
DROP TRIGGER IF EXISTS products_fts_ad;
DROP TRIGGER IF EXISTS products_fts_au;
DROP TABLE IF EXISTS products_fts;

-- Phase 2 identity-quality cleanup: every listing must have an explicit resolution row so active
-- listing coverage is complete. Valid identity fields remain backfill_pending until the normal
-- crawler resolver evaluates them; listings missing identity fields are explicitly unresolved.
INSERT OR IGNORE INTO product_identity_resolutions(
  listing_product_id, catalog_product_id, candidate_catalog_product_id, status,
  match_method, confidence, normalized_model, model_stem, variants_json,
  matched_fields_json, rejected_by_json, evaluated_at
)
SELECT
  p.id,
  NULL,
  NULL,
  'unresolved',
  CASE
    WHEN COALESCE(p.manufacturer_id, '') <> '' AND COALESCE(p.model, '') <> ''
      THEN 'backfill_pending'
    ELSE 'unresolved'
  END,
  'none',
  UPPER(REPLACE(REPLACE(REPLACE(COALESCE(p.model, ''), ' ', ''), '-', ''), '_', '')),
  '',
  '[]',
  CASE WHEN COALESCE(p.manufacturer_id, '') <> '' THEN '["manufacturer_id"]' ELSE '[]' END,
  CASE
    WHEN COALESCE(p.manufacturer_id, '') = '' OR COALESCE(p.model, '') = ''
      THEN '["missing_identity_fields"]'
    ELSE '[]'
  END,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products p
LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
WHERE r.listing_product_id IS NULL;
