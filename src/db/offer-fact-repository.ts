import { inferOfferFacts } from "../catalog/offer-facts.js";
import { isOfferFactId } from "../catalog/types.js";
import type { OfferFact } from "../catalog/types.js";
import type { ReadableDatabase } from "./types.js";
import { EFFECTIVE_OFFER_FACT_SQL } from "./offer-fact-precedence.js";

/** One bounded detail read; a manual decision (including unknown) overrides seller extraction. */
export async function effectiveOfferFacts(
  db: ReadableDatabase,
  productIds: readonly number[],
): Promise<Map<number, OfferFact[]>> {
  const result = new Map<number, OfferFact[]>();
  if (!productIds.length) return result;
  if (productIds.length > 200) throw new Error("offer_facts_scope_too_large");
  const rows = await db
    .prepare(`SELECT f.product_id, f.fact_id, f.state, f.source, f.source_field,
      f.rule_id, f.confidence, f.observed_at, f.warranty_months FROM product_offer_facts f
      WHERE f.product_id IN (SELECT value FROM json_each(?))
        AND ${EFFECTIVE_OFFER_FACT_SQL}
      ORDER BY f.product_id, f.fact_id`)
    .bind(JSON.stringify(productIds))
    .all<{
      product_id: number;
      fact_id: string;
      state: OfferFact["state"];
      source: OfferFact["source"];
      source_field: OfferFact["sourceField"];
      rule_id: string;
      confidence: number;
      observed_at: string;
      warranty_months: number | null;
    }>();
  for (const row of rows.results) {
    if (!isOfferFactId(row.fact_id)) continue;
    const facts = result.get(row.product_id) ?? [];
    facts.push({
      factId: row.fact_id,
      state: row.state,
      source: row.source,
      sourceField: row.source_field,
      ruleId: row.rule_id,
      confidence: row.confidence,
      observedAt: row.observed_at,
      ...(row.warranty_months != null ? { warrantyMonths: row.warranty_months } : {}),
    });
    result.set(row.product_id, facts);
  }
  return result;
}

/** Two statements, inside the caller's listing transaction. Equal facts retain decision time. */
export function sellerOfferFactWrites(
  db: ReadableDatabase,
  shopKey: string,
  sourceId: string,
  title: string,
  conditionText: string,
  observedAt: string,
  replay?: { ruleVersion: number; token: string },
): D1PreparedStatement[] {
  const facts = JSON.stringify(inferOfferFacts(title, conditionText, observedAt));
  const guard = replay
    ? " AND EXISTS (SELECT 1 FROM product_offer_fact_replays r WHERE r.rule_version = ? AND r.step_token = ?)"
    : "";
  const guardBinds = replay ? [replay.ruleVersion, replay.token] : [];
  return [
    db
      .prepare(`DELETE FROM product_offer_facts
      WHERE product_id = (SELECT id FROM products WHERE shop_key = ? AND source_id = ?)
        AND ((source = 'seller'
          AND fact_id NOT IN (SELECT json_extract(value, '$.factId') FROM json_each(?)))
        OR (source = 'seller_detail' AND EXISTS (
          SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.factId') = product_offer_facts.fact_id
            AND json_extract(j.value,'$.state') <> product_offer_facts.state
            AND NOT EXISTS (SELECT 1 FROM product_offer_facts previous
              WHERE previous.product_id = product_offer_facts.product_id
                AND previous.fact_id = product_offer_facts.fact_id AND previous.source = 'seller'
                AND previous.state = json_extract(j.value,'$.state')))))${guard}`)
      .bind(shopKey, sourceId, facts, facts, ...guardBinds),
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
            AND f.confidence = json_extract(j.value, '$.confidence'))${guard}
      ON CONFLICT(product_id, fact_id, source) DO UPDATE SET
        state = excluded.state, source_field = excluded.source_field,
        rule_id = excluded.rule_id, confidence = excluded.confidence,
        observed_at = excluded.observed_at`)
      .bind(observedAt, facts, shopKey, sourceId, ...guardBinds),
  ];
}
