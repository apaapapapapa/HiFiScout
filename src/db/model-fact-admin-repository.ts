import { parseModelFactInput } from "../catalog/model-relations.js";
import type { ModelFactsAdminSnapshot, ModelFactWriteInput } from "../catalog/types.js";
import { listModelFacts, saveModelFact } from "./model-relation-repository.js";
import { firstMeasured } from "./read-accounting.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

export async function readModelFactsAdmin(db: ReadableDatabase, productId: number): Promise<ModelFactsAdminSnapshot | null> {
  const product = await firstMeasured<{ id: number; name: string; manufacturerId: string }>(db.prepare(
    "SELECT id,canonical_name AS name,manufacturer_id AS manufacturerId FROM knowledge_catalog_products WHERE id = ?",
  ).bind(productId));
  if (!product) return null;
  const facts = await listModelFacts(db, productId);
  const sources = await db.prepare(`SELECT id,source_type AS sourceType,source_url AS url,status,retrieved_at AS retrievedAt
    FROM knowledge_catalog_sources WHERE product_id=? ORDER BY id LIMIT 40`).bind(productId)
    .all<ModelFactsAdminSnapshot["sources"][number]>();
  const audits = await db.prepare(`SELECT id,actor,occurred_at,before_json,after_json
    FROM knowledge_catalog_model_fact_audits WHERE id IN (
      SELECT id FROM (SELECT id FROM knowledge_catalog_model_fact_audits WHERE product_id=? ORDER BY id DESC LIMIT 20)
      UNION SELECT id FROM (SELECT id FROM knowledge_catalog_model_fact_audits WHERE related_product_id=? ORDER BY id DESC LIMIT 20)
    ) ORDER BY id DESC LIMIT 20`).bind(productId,productId)
    .all<{ id: number; actor: string; occurred_at: string; before_json: string | null; after_json: string | null }>();
  return { product, facts: facts.map((row) => {
    const input = parseModelFactInput(JSON.parse(row.data_json));
    if (!input) throw new Error("catalog_model_fact_invalid");
    return { id: row.id, version: row.version, productId: row.product_id, productName: row.product_name,
      relatedProductName: row.related_product_name, input, reviewState: row.review_state, sourceUrl: row.source_url,
      verifiedAt: row.verified_at, reviewDueAt: row.review_due_at };
  }), sources: sources.results, audits: audits.results.map((row) => ({ id: row.id, actor: row.actor, occurredAt: row.occurred_at, before: row.before_json ? JSON.parse(row.before_json) : null, after: row.after_json ? JSON.parse(row.after_json) : null })) };
}

export async function saveModelFactsAdmin(db: QueryableDatabase, productId: number, input: ModelFactWriteInput, actor: string) {
  await saveModelFact(db, productId, input.fact, { id: input.id ?? undefined, expectedVersion: input.expectedVersion ?? undefined, reverify: input.reverify, actor });
  return readModelFactsAdmin(db, productId);
}
