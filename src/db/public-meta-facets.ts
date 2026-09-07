import type { QueryableDatabase } from "./types.js";

/** A count limit bounds entities, not their offers. Reads stay scoped to each changed entity. */
export const PUBLIC_META_ENTITY_PAGE = 100;

const desiredFacets = `WITH requested AS MATERIALIZED (
  SELECT value AS entity_id FROM json_each(?)
), desired AS MATERIALIZED (
  SELECT DISTINCT r.entity_id, f.facet_id, f.facet_value
  FROM requested r
  CROSS JOIN product_search_entity_offers m ON m.entity_id = r.entity_id
  CROSS JOIN products p ON p.id = m.listing_product_id
  CROSS JOIN product_facet_facts f ON f.product_id = p.id
  WHERE p.is_active = 1
)`;

/** Re-evaluate current facts inside the same transaction that acknowledges their dirty keys.
 * A concurrent write before the batch is included; one after it creates a new obligation.
 * Replaced fact rows and duplicate sources never double-count an entity's facet membership.
 */
export async function refreshPublicMetaFacets(db: QueryableDatabase): Promise<number> {
  const page = await db
    .prepare("SELECT entity_id FROM public_meta_dirty_entities ORDER BY entity_id LIMIT ?")
    .bind(PUBLIC_META_ENTITY_PAGE)
    .all<{ entity_id: number }>();
  const ids = (page.results || []).map((row) => row.entity_id);
  if (!ids.length) return 0;
  const payload = JSON.stringify(ids);
  await db.batch([
    db
      .prepare(`${desiredFacets}
      DELETE FROM public_meta_entity_facets
      WHERE entity_id IN (SELECT entity_id FROM requested)
        AND NOT EXISTS (SELECT 1 FROM desired d
          WHERE d.entity_id = public_meta_entity_facets.entity_id
            AND d.facet_id = public_meta_entity_facets.facet_id
            AND d.facet_value = public_meta_entity_facets.facet_value)
    `)
      .bind(payload),
    db
      .prepare(`${desiredFacets}
      INSERT INTO public_meta_entity_facets(entity_id, facet_id, facet_value)
      SELECT entity_id, facet_id, facet_value FROM desired WHERE 1
      ON CONFLICT(entity_id, facet_id, facet_value) DO NOTHING
    `)
      .bind(payload),
    db
      .prepare(`DELETE FROM public_meta_dirty_entities
      WHERE entity_id IN (SELECT value FROM json_each(?))`)
      .bind(payload),
  ]);
  return ids.length;
}
