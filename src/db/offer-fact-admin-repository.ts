import { isOfferFactId } from "../catalog/types.js";
import type { OfferFact } from "../catalog/types.js";
import { parseOfferFactChanges } from "../catalog/offer-fact-decisions.js";
import type { OfferFactChanges } from "../catalog/offer-fact-decisions.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

export async function readOfferFactAdmin(db: ReadableDatabase, listingId: number) {
  const listing = await db
    .prepare(`SELECT id AS listingId, title, condition_text AS conditionText,
      source_url AS sourceUrl FROM products WHERE id = ?`)
    .bind(listingId)
    .first<{ listingId: number; title: string; conditionText: string; sourceUrl: string }>();
  if (!listing) return null;
  const rows = await db
    .prepare(`SELECT fact_id AS factId, state, source, source_field AS sourceField,
      rule_id AS ruleId, confidence, observed_at AS observedAt
      FROM product_offer_facts WHERE product_id = ? ORDER BY fact_id, source`)
    .bind(listingId)
    .all<OfferFact>();
  return { ...listing, facts: rows.results.filter((fact) => isOfferFactId(fact.factId)) };
}

/** Patch only named decisions; inherit removes manual authority without erasing seller evidence. */
export async function updateOfferFactAdmin(
  db: QueryableDatabase,
  listingId: number,
  changes: OfferFactChanges,
  observedAt = new Date().toISOString(),
) {
  const parsed = parseOfferFactChanges(changes);
  if (!parsed) throw new Error("invalid_offer_fact_changes");
  if (!(await readOfferFactAdmin(db, listingId))) return null;
  const statements = Object.entries(parsed).map(([id, state]) =>
    state === "inherit"
      ? db
          .prepare(
            "DELETE FROM product_offer_facts WHERE product_id = ? AND fact_id = ? AND source = 'manual'",
          )
          .bind(listingId, id)
      : db
          .prepare(`INSERT INTO product_offer_facts
            (product_id, fact_id, source, state, source_field, rule_id, confidence, observed_at)
            SELECT p.id, ?, 'manual', ?, 'manual', 'admin.offer.v1', 1, ? FROM products p
            WHERE p.id = ? AND NOT EXISTS (
              SELECT 1 FROM product_offer_facts f WHERE f.product_id = p.id
                AND f.fact_id = ? AND f.source = 'manual' AND f.state = ?)
            ON CONFLICT(product_id, fact_id, source) DO UPDATE SET
              state = excluded.state, source_field = excluded.source_field,
              rule_id = excluded.rule_id, confidence = excluded.confidence,
              observed_at = excluded.observed_at`)
          .bind(id, state, observedAt, listingId, id, state),
  );
  await db.batch(statements);
  return readOfferFactAdmin(db, listingId);
}
