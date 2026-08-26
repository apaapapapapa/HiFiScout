/**
 * Recomputes the direct component categories cached on a search entity.
 *
 * `product_search_entity_categories` remains the normalized source of truth used by filters and
 * facets. This is only the compact card/API projection, equivalent to the presentation-colour
 * aggregate: unordered in SQLite, then canonicalized by the DTO mapper.
 *
 * The LEFT JOIN is deliberate. An entity that loses its last direct membership must be written
 * back to the empty string; aggregating only rows that still exist would leave a stale category on
 * the card after the normalized membership had already been removed.
 */
export function refreshEntityDirectCategoryIdsSql(entityScope = ""): string {
  return `
    UPDATE product_search_entities AS e
    SET direct_category_ids = agg.direct_category_ids
    FROM (
      SELECT source.id AS entity_id,
             COALESCE(group_concat(ec.category_id), '') AS direct_category_ids
      FROM product_search_entities source
      LEFT JOIN product_search_entity_categories ec
        ON ec.entity_id = source.id AND ec.is_direct = 1
      WHERE 1 = 1${entityScope}
      GROUP BY source.id
    ) AS agg
    WHERE e.id = agg.entity_id AND e.direct_category_ids IS NOT agg.direct_category_ids
  `;
}
