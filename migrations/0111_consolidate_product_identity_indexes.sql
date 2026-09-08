-- `products` is the highest-write table in the crawler. Exact identity changes currently maintain
-- two indexes with the same leading identity columns:
--
-- * `idx_products_identity_group` serves the unresolved-identity dashboard;
-- * `idx_products_exact_identity` serves exact-identity peer expansion and repair.
--
-- Keep the wider exact-identity key shape: catalog correction pages intentionally include both
-- active and inactive listings, and use that index before their id cursor. Its consumers all require
-- non-empty identities, so retain the old grouping index's partial predicate as well. This prevents
-- unresolved dashboards from walking schema-default blank identities while still replacing two
-- maintained entries with one for every usable manufacturer/model identity.
DROP INDEX IF EXISTS idx_products_identity_group;
DROP INDEX IF EXISTS idx_products_exact_identity;
CREATE INDEX idx_products_exact_identity
  ON products(canonical_manufacturer_id, normalized_model, is_active, model_resolution_status)
  WHERE COALESCE(canonical_manufacturer_id, '') <> ''
    AND COALESCE(normalized_model, '') <> '';
