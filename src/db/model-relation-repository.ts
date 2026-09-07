import { parseModelFactInput } from "../catalog/model-relations.js";
import type { ModelFactInput } from "../catalog/model-relations.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";
import { firstMeasured } from "./read-accounting.js";

interface ModelFactRow {
  id: string;
  product_id: number;
  related_product_id: number | null;
  family_id: string | null;
  position: number | null;
  relation_type: "successor" | "variant" | null;
  evidence_kind: "source" | "manual";
  data_json: string;
  source_id: number | null;
  source_url: string;
  source_hash: string;
  version: number;
  verified_at: string | null;
  review_due_at: string | null;
  updated_at: string;
}

export function readModelFact(db: ReadableDatabase, id: string) {
  return firstMeasured<ModelFactRow>(
    db.prepare("SELECT * FROM knowledge_catalog_model_facts WHERE id = ?").bind(id),
  );
}

/** Same-value saves are free; re-verification is explicit and advances the proof's decision time. */
export async function saveModelFact(
  db: QueryableDatabase,
  productId: number,
  raw: ModelFactInput,
  options: { id?: string; expectedVersion?: number; reverify?: boolean; actor: string },
  now = new Date().toISOString(),
) {
  const input = parseModelFactInput(raw);
  if (
    !input ||
    !Number.isSafeInteger(productId) ||
    productId <= 0 ||
    !options.actor.trim() ||
    options.actor.length > 200
  )
    throw new Error("catalog_model_fact_invalid");
  const before = options.id ? await readModelFact(db, options.id) : null;
  if (
    options.id &&
    (!before ||
      before.version !== options.expectedVersion ||
      (before.product_id !== productId && before.related_product_id !== productId))
  )
    throw new Error("catalog_model_fact_conflict");
  if (!options.id && input.state === "removed") throw new Error("catalog_model_fact_invalid");
  let from = before?.product_id ?? productId,
    to = input.relatedProductId;
  if (input.kind === "variant" && to !== null && from > to) [from, to] = [to, from];
  const product = await firstMeasured<{ manufacturer_id: string }>(
    db.prepare("SELECT manufacturer_id FROM knowledge_catalog_products WHERE id = ?").bind(from),
  );
  if (!product) throw new Error("catalog_model_fact_product_missing");
  const source =
    input.sourceId === null
      ? null
      : await firstMeasured<{ source_url: string; content_hash: string }>(
          db
            .prepare("SELECT source_url, content_hash FROM knowledge_catalog_sources WHERE id = ?")
            .bind(input.sourceId),
        );
  if (input.sourceId !== null && !source) throw new Error("catalog_model_fact_source_missing");
  // Store the canonical orientation, including for symmetric variants opened from either endpoint.
  const data = JSON.stringify({ ...input, relatedProductId: to });
  const same =
    before &&
    before.product_id === from &&
    before.data_json === data &&
    before.source_hash === (source?.content_hash ?? "") &&
    before.source_url === (source?.source_url ?? "");
  if (same && !options.reverify) return before;
  const id = before?.id ?? crypto.randomUUID();
  const familyId =
    input.kind === "family" ? `${product.manufacturer_id}:${input.familyName.toLowerCase()}` : null;
  const verifiedAt = input.state === "verified" ? now : null;
  const due = verifiedAt ? new Date(Date.parse(now) + 180 * 86400_000).toISOString() : null;
  const values = [
    from,
    to,
    familyId,
    input.position,
    input.kind === "family" ? null : input.kind,
    input.state,
    input.sourceId,
    input.sourceId === null ? "manual" : "source",
    source?.source_url ?? "",
    source?.content_hash ?? "",
    input.manualNote,
    input.manufacturerJustification,
    data,
    verifiedAt,
    due,
    now,
    options.actor,
  ];
  const writes: D1PreparedStatement[] = [];
  if (familyId)
    writes.push(
      db
        .prepare(`INSERT INTO knowledge_catalog_model_families(id,manufacturer_id,name,created_at)
    SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM knowledge_catalog_model_families WHERE id = ?)`)
        .bind(familyId, product.manufacturer_id, input.familyName, now, familyId),
    );
  if (before)
    writes.push(
      db
        .prepare(
          `UPDATE knowledge_catalog_model_facts SET product_id=?,related_product_id=?,family_id=?,position=?,relation_type=?,state=?,source_id=?,evidence_kind=?,source_url=?,source_hash=?,manual_note=?,manufacturer_justification=?,data_json=?,verified_at=?,review_due_at=?,updated_at=?,audit_actor=?,version=version+1 WHERE id=? AND version=?`,
        )
        .bind(...values, id, before.version),
    );
  else
    writes.push(
      db
        .prepare(`INSERT INTO knowledge_catalog_model_facts(product_id,related_product_id,family_id,position,relation_type,state,source_id,evidence_kind,source_url,source_hash,manual_note,manufacturer_justification,data_json,verified_at,review_due_at,updated_at,audit_actor,id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(...values, id),
    );
  const results = await db.batch(writes);
  if (!results.at(-1)?.meta.changes) throw new Error("catalog_model_fact_conflict");
  return readModelFact(db, id);
}

const MODEL_FACT_SELECT = `SELECT f.*, COALESCE(NULLIF(p.canonical_name,''),p.canonical_model) AS product_name,
    COALESCE(NULLIF(target.canonical_name,''),target.canonical_model) AS related_product_name, family.name AS family_name,
    COALESCE(pm.canonical_name,p.manufacturer_id) AS manufacturer,
    COALESCE(tm.canonical_name,target.manufacturer_id) AS related_manufacturer,
    CASE WHEN f.state <> 'verified' THEN f.state
      WHEN f.review_due_at <= ? OR p.verification_status <> 'verified' OR (target.id IS NOT NULL AND target.verification_status <> 'verified') THEN 'due'
      WHEN f.evidence_kind = 'source' AND (s.id IS NULL OR s.status <> 'active' OR s.content_hash <> f.source_hash OR s.source_url <> f.source_url
        OR s.source_type NOT IN ('manufacturer_official','official_distributor','manufacturer_archive','manual_verified')
        OR (s.product_id <> f.product_id AND s.product_id IS NOT f.related_product_id)
        OR julianday(s.retrieved_at) IS NULL OR julianday(s.retrieved_at) < julianday(?) - 180) THEN 'due'
      ELSE 'verified' END AS review_state
    FROM knowledge_catalog_model_facts f
    JOIN knowledge_catalog_products p ON p.id = f.product_id
    LEFT JOIN knowledge_catalog_products target ON target.id = f.related_product_id
    LEFT JOIN knowledge_catalog_model_families family ON family.id = f.family_id
    LEFT JOIN knowledge_catalog_sources s ON s.id = f.source_id
    LEFT JOIN knowledge_catalog_manufacturers pm ON pm.id = p.manufacturer_id
    LEFT JOIN knowledge_catalog_manufacturers tm ON tm.id = target.manufacturer_id`;

export interface ReviewedModelFact extends ModelFactRow {
  product_name: string;
  related_product_name: string | null;
  manufacturer: string;
  related_manufacturer: string | null;
  family_name: string | null;
  review_state: ModelFactInput["state"] | "due";
}

/** Missing/changed/stale sources never remain publishable; no scheduled full-graph scan is needed. */
export async function listModelFacts(db: ReadableDatabase, productId: number, now = new Date().toISOString()) {
  const result = await db.prepare(`${MODEL_FACT_SELECT} WHERE f.id IN (
      SELECT id FROM knowledge_catalog_model_facts WHERE product_id = ? AND state <> 'removed'
      UNION
      SELECT id FROM knowledge_catalog_model_facts WHERE related_product_id = ? AND state <> 'removed'
    ) ORDER BY f.id LIMIT 41`)
    .bind(now, now, productId, productId)
    .all<ReviewedModelFact>();
  return result.results;
}

/** Each requested family has at most 40 current members; fetch all selected families together. */
export async function listFamilyModelFacts(db: ReadableDatabase, familyIds: readonly string[], now: string) {
  if (!familyIds.length) return [];
  if (familyIds.length > 40) throw new Error("model_family_scope_too_large");
  const result = await db.prepare(`${MODEL_FACT_SELECT} WHERE f.id IN (
    SELECT id FROM knowledge_catalog_model_facts INDEXED BY idx_model_facts_family
    WHERE family_id IN (SELECT value FROM json_each(?)) AND state <> 'removed'
  ) ORDER BY f.family_id, f.position IS NULL, f.position, f.product_id LIMIT 1600`)
    .bind(now, now, JSON.stringify(familyIds)).all<ReviewedModelFact>();
  return result.results;
}
