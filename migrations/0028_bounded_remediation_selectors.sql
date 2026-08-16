-- Follow-up to 0027: make every staleness selector stop at its LIMIT.
--
-- 0027 removed the full table reads but left two ways for a five-minute tick to do work
-- proportional to the catalog rather than to the backlog. Both are index shape problems.

-- 1. A range on the leading column ends the usable prefix.
--
-- `(manufacturer_resolver_version, is_active, id)` seeks `version < ?` and then has to read every
-- entry in that range, because a column after a range constraint cannot narrow the search: inactive
-- listings left on an old resolver version are read and discarded one by one.
--
-- Making `is_active` a partial-index predicate rather than a key column settles that without moving
-- it in front of the range: the index simply does not contain inactive listings, so retired
-- inventory on an old resolver version cannot dominate a sweep no matter how much of it accumulates.
-- What the key columns are then free to do is match the selector's `ORDER BY version, id` exactly,
-- so the plan streams and stops at LIMIT instead of collecting every stale row into a temp b-tree
-- first. Keeping the range leading also matters for what these indexes *don't* attract: an
-- `is_active = 1` equality in front would make them look useful to unrelated listing queries, and
-- the identity-group dashboard query promptly picked one up over its own index.
CREATE INDEX IF NOT EXISTS idx_products_active_manufacturer_version
  ON products(manufacturer_resolver_version, id)
  WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_products_active_model_version
  ON products(model_resolver_version, id)
  WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_products_active_category_version
  ON products(
    COALESCE(CAST(json_extract(metadata_json, '$.categoryClassification.version') AS INTEGER), 0),
    id
  )
  WHERE is_active = 1;

-- The versions of the same three indexes that led with the range. `idx_products_model_resolver_version`
-- came from 0024 and had the same column order; the manufacturer/category pair came from 0027. No
-- other statement reaches any of them: the manufacturer and model replay paths
-- (`selectStaleManufacturerListings`, `model-repository.ts`) drive off `id > ?`, not off a version.
DROP INDEX IF EXISTS idx_products_manufacturer_resolver_version;
DROP INDEX IF EXISTS idx_products_category_classifier_version;
DROP INDEX IF EXISTS idx_products_model_resolver_version;

-- 2. Selectors keyed on a resolution *result* have no LIMIT to stop at.
--
-- 0027 gave "manufacturer still unresolved", "category still unclassified", "identity still
-- unresolved" and "identity row missing" an index each, which fixed the plan but not the cost: their
-- candidate set is the persistent unresolved catalog, so every tick walked all of it, probed the
-- queue once per row, and returned nothing once the deterministic work keys were already queued.
--
-- They are gone from automatic seeding, because none of them was ever the signal. A listing that is
-- still unresolved at the current resolver version resolves the same way on replay; what changes an
-- outcome is a resolver version bump or a dependency change, and every dependency already drives its
-- own bounded, cursor-restartable replay: `reprocessManufacturerAliasListings` on alias
-- verification, `reprocessPendingCatalogRemediation` on catalog verification, and
-- `reclassifyProductsFromKnowledgeCatalog`, which sets `remediation_projection_required = 1` and so
-- lands back in this queue through the bounded projection selector. Re-running everything anyway
-- stays available as the explicit, paged `enqueueFullDataQualityRebuild`.
--
-- `idx_products_active_ids` existed only for the "identity row missing" anti-join, which was the one
-- selector that could not be made selective at all.
DROP INDEX IF EXISTS idx_products_active_ids;
