-- Direct component categories on the entity read model.
--
-- Category filters/facets already read `product_search_entity_categories`; the card/API needs the
-- direct subset without joining that relation on every result row. Like presentation colours, keep
-- the small aggregate on the entity and canonicalise its order at the mapper boundary.
ALTER TABLE product_search_entities
ADD COLUMN direct_category_ids TEXT NOT NULL DEFAULT '';

UPDATE product_search_entities AS e
SET direct_category_ids = agg.direct_category_ids
FROM (
  SELECT source.id AS entity_id,
         COALESCE(group_concat(ec.category_id), '') AS direct_category_ids
  FROM product_search_entities source
  LEFT JOIN product_search_entity_categories ec
    ON ec.entity_id = source.id AND ec.is_direct = 1
  GROUP BY source.id
) AS agg
WHERE e.id = agg.entity_id;
