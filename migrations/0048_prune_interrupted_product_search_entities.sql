-- Remove Product Search entities stranded by the pre-0048 incremental writer.
--
-- Before this migration, entity creation/membership reassignment and empty-entity pruning were
-- separate D1 commits. A Worker termination between those writes could therefore leave an entity
-- with no offers indefinitely. The runtime fix shipped with this migration performs the critical
-- writes and scoped pruning in one D1 batch transaction, so this is a one-time cleanup of rows
-- created by the old writer.
DELETE FROM product_search_entities
WHERE NOT EXISTS (
  SELECT 1
  FROM product_search_entity_offers offer
  WHERE offer.entity_id = product_search_entities.id
);
