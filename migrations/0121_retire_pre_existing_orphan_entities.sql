-- Clear the orphan entities that predate the scoped retention sweep.
--
-- Retention used to end with this same delete over the whole of `product_search_entities`, on every
-- run. It is now scoped to the entities the listings it just deleted belonged to, which is bounded
-- but only answers for orphans that path creates from here on.
--
-- The residue it cannot reach is real. The old implementation deleted the listings and swept the
-- entities as two separate statements rather than one transaction, so an invocation interrupted
-- between them committed the cascade and lost the sweep. The membership and the listing are both
-- gone by then, so no later run has anything left to derive a candidate from, and the scoped sweep
-- would never see those rows again.
--
-- That matters because unfiltered product search selects straight from `product_search_entities`
-- with no join to offers -- it relies on the invariant that every row has one. An orphan is a
-- product in the results with nothing to buy.
--
-- One full pass, once, at deploy: exactly the cost the daily path stops paying. The window that
-- produced these is closed in the same change, since both halves now go in one batch.
DELETE FROM product_search_entities
WHERE NOT EXISTS (
  SELECT 1 FROM product_search_entity_offers m WHERE m.entity_id = product_search_entities.id
);
