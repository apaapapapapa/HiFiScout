import type { FacetFact } from "../catalog/types.js";
import type { QueryableDatabase } from "./types.js";

/** Bounded by one listing's facts. Keep manual sources and unchanged decision times. */
export async function syncAutomaticFacetFacts(
  db: QueryableDatabase,
  productId: number,
  next: readonly FacetFact[],
): Promise<void> {
  const json = JSON.stringify(next);
  await db.batch([
    db
      .prepare(`DELETE FROM product_facet_facts
      WHERE product_id = ? AND (source IN ('title','seller_category') OR source LIKE 'verified_model:%')
        AND NOT EXISTS (SELECT 1 FROM json_each(?) j
          WHERE json_extract(j.value,'$.facetId') = product_facet_facts.facet_id
            AND json_extract(j.value,'$.value') = product_facet_facts.facet_value
            AND json_extract(j.value,'$.source') = product_facet_facts.source)`)
      .bind(productId, json),
    db
      .prepare(`INSERT INTO product_facet_facts(product_id,facet_id,facet_value,source,confidence,verified_at)
      SELECT ?,json_extract(j.value,'$.facetId'),json_extract(j.value,'$.value'),
        json_extract(j.value,'$.source'),json_extract(j.value,'$.confidence'),json_extract(j.value,'$.verifiedAt')
      FROM json_each(?) j
      WHERE NOT EXISTS (SELECT 1 FROM product_facet_facts f WHERE f.product_id = ?
        AND f.facet_id = json_extract(j.value,'$.facetId') AND f.facet_value = json_extract(j.value,'$.value')
        AND f.source = json_extract(j.value,'$.source') AND f.confidence = json_extract(j.value,'$.confidence'))
      ON CONFLICT(product_id,facet_id,facet_value,source) DO UPDATE SET
        confidence = excluded.confidence, verified_at = excluded.verified_at
      WHERE product_facet_facts.confidence IS NOT excluded.confidence`)
      .bind(productId, json, productId),
  ]);
}
