import type { OfferFact } from "../catalog/types.js";
import type { QueryableDatabase } from "./types.js";

/** Reuse one already-fetched detail page. Never touch manual decisions or list-field evidence. */
export async function saveSellerDetailOfferFacts(
  db: QueryableDatabase,
  productId: number,
  facts: readonly OfferFact[],
): Promise<void> {
  const json = JSON.stringify(facts.filter((f) => f.source === "seller_detail"));
  await db.batch([
    db
      .prepare(`DELETE FROM product_offer_facts WHERE product_id=? AND source='seller_detail'
      AND fact_id NOT IN (SELECT json_extract(value,'$.factId') FROM json_each(?))`)
      .bind(productId, json),
    db
      .prepare(`INSERT INTO product_offer_facts(product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at,warranty_months)
      SELECT ?,json_extract(j.value,'$.factId'),'seller_detail',json_extract(j.value,'$.state'),
        json_extract(j.value,'$.sourceField'),json_extract(j.value,'$.ruleId'),json_extract(j.value,'$.confidence'),
        json_extract(j.value,'$.observedAt'),json_extract(j.value,'$.warrantyMonths')
      FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM product_offer_facts f
        WHERE f.product_id=? AND f.fact_id=json_extract(j.value,'$.factId') AND f.source='seller_detail'
          AND f.state=json_extract(j.value,'$.state') AND f.source_field=json_extract(j.value,'$.sourceField')
          AND f.rule_id=json_extract(j.value,'$.ruleId') AND f.confidence=json_extract(j.value,'$.confidence')
          AND f.warranty_months IS json_extract(j.value,'$.warrantyMonths'))
      ON CONFLICT(product_id,fact_id,source) DO UPDATE SET state=excluded.state,source_field=excluded.source_field,
        rule_id=excluded.rule_id,confidence=excluded.confidence,observed_at=excluded.observed_at,warranty_months=excluded.warranty_months`)
      .bind(productId, json, productId),
  ]);
}
