-- Give "not classified" its own category id, separate from the `other` leaf.
--
-- `other` is a real, intentional category — tuner, equalizer, channel divider — and the classifier
-- used it as its "no answer" sentinel too. Because the read model re-derives the label from the id
-- (`src/db/product-search-entity-mapper.ts`), the stored "未分類" was discarded and every one of
-- these listings surfaced to users as "その他", inside the same filter as the genuine ones. The
-- classifier now answers `unclassified`; this repairs the rows written before that.
--
-- Scope note: the condition is `classification_status`, not `category_ids`. Filtering on
-- `category_ids = '[]'` would miss the rows that carry `["other"]` (see migration 0040). The
-- `primary_category_id = 'other'` guard is defensive only — an unclassified row cannot hold a real
-- leaf — and makes a re-run a no-op.
UPDATE products
SET primary_category_id = 'unclassified',
    category_ids = json_array('unclassified'),
    category = '未分類',
    search_aliases = ''
WHERE classification_status = 'unclassified'
  AND primary_category_id = 'other';

-- The read model mirrors the listing for a fallback entity, so move the ones whose representative
-- listing just changed. Listing counts and entity counts do not match here: exact-identity grouping
-- (migration 0036) lets an unclassified listing sit inside an entity whose representative is
-- classified, and those entities must keep the representative's category.
UPDATE product_search_entities
SET primary_category_id = 'unclassified'
WHERE entity_kind = 'unresolved_listing'
  AND primary_category_id = 'other'
  AND fallback_listing_id IN (
    SELECT id FROM products
    WHERE classification_status = 'unclassified' AND primary_category_id = 'unclassified'
  );

-- A verified catalog product with no category row was backfilled as `other` by migration 0021.
-- `upsertCatalogEntitiesSql()` now writes the sentinel there; this repairs the frozen rows so the
-- read model does not depend on when an entity was last refreshed.
UPDATE product_search_entities
SET primary_category_id = 'unclassified'
WHERE entity_kind = 'catalog'
  AND primary_category_id = 'other'
  AND catalog_product_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM knowledge_catalog_product_categories kpc
    WHERE kpc.product_id = product_search_entities.catalog_product_id
  );
