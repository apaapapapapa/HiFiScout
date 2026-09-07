import { inferOfferFacts } from "../catalog/offer-facts.js";
import type { ReadableDatabase } from "./types.js";

/** Two statements, inside the caller's listing transaction. Equal facts retain decision time. */
export function sellerOfferFactWrites(
  db: ReadableDatabase,
  shopKey: string,
  sourceId: string,
  title: string,
  conditionText: string,
  observedAt: string,
): D1PreparedStatement[] {
  const facts = JSON.stringify(inferOfferFacts(title, conditionText, observedAt));
  return [
    db
      .prepare(`DELETE FROM product_offer_facts
      WHERE product_id = (SELECT id FROM products WHERE shop_key = ? AND source_id = ?)
        AND source = 'seller'
        AND fact_id NOT IN (SELECT json_extract(value, '$.factId') FROM json_each(?))`)
      .bind(shopKey, sourceId, facts),
    db
      .prepare(`INSERT INTO product_offer_facts
      (product_id, fact_id, source, state, source_field, rule_id, confidence, observed_at)
      SELECT p.id, json_extract(j.value, '$.factId'), 'seller',
        json_extract(j.value, '$.state'), json_extract(j.value, '$.sourceField'),
        json_extract(j.value, '$.ruleId'), json_extract(j.value, '$.confidence'), ?
      FROM products p CROSS JOIN json_each(?) j
      WHERE p.shop_key = ? AND p.source_id = ?
        AND NOT EXISTS (SELECT 1 FROM product_offer_facts f
          WHERE f.product_id = p.id AND f.fact_id = json_extract(j.value, '$.factId')
            AND f.source = 'seller' AND f.state = json_extract(j.value, '$.state')
            AND f.source_field = json_extract(j.value, '$.sourceField')
            AND f.rule_id = json_extract(j.value, '$.ruleId')
            AND f.confidence = json_extract(j.value, '$.confidence'))
      ON CONFLICT(product_id, fact_id, source) DO UPDATE SET
        state = excluded.state, source_field = excluded.source_field,
        rule_id = excluded.rule_id, confidence = excluded.confidence,
        observed_at = excluded.observed_at`)
      .bind(observedAt, facts, shopKey, sourceId),
  ];
}
