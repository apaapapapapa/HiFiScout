import type { ProductMetadataLookupRow, QueryableDatabase } from "./types.js";
import { isRecord } from "../types.js";
import {
  canonicalCategoryAudit,
  categoryRuleVersion,
  metadataObject,
} from "../catalog/category-change.js";

const LOOKUP_CHUNK_SIZE = 50;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_METADATA_KEYS = 50;

/** Product carrying the metadata blob that `syncProductMetadata()` persists. */
interface ProductMetadataSyncInput {
  sourceId: string;
  metadata?: unknown;
}

function stableObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => typeof key === "string" && key.length <= 64 && entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_METADATA_KEYS),
  );
}

export function normalizeMetadataJson(metadata: unknown): string {
  const normalized = stableObject(metadata);
  if (isRecord(normalized.categoryClassification))
    normalized.categoryClassification = canonicalCategoryAudit(normalized.categoryClassification);
  const json = JSON.stringify(normalized);
  if (new TextEncoder().encode(json).byteLength > MAX_METADATA_BYTES) {
    throw new Error(`product metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  return json;
}

/** A repeated catalog decision is not a product change; retain its original decision time. */
function preserveCatalogDecisionTime(metadata: unknown, previousJson: string): unknown {
  if (!isRecord(metadata) || !isRecord(metadata.categoryClassification)) return metadata;
  let previous: unknown;
  try {
    previous = JSON.parse(previousJson);
  } catch {
    return metadata;
  }
  if (!isRecord(previous) || !isRecord(previous.categoryClassification)) return metadata;
  const { catalogMatchedAt: previousAt, ...previousDecision } = previous.categoryClassification;
  const { catalogMatchedAt: nextAt, ...nextDecision } = metadata.categoryClassification;
  if (typeof previousAt !== "string" || typeof nextAt !== "string") return metadata;
  if (
    JSON.stringify(canonicalCategoryAudit(previousDecision)) !==
    JSON.stringify(canonicalCategoryAudit(nextDecision))
  ) {
    return metadata;
  }
  return {
    ...metadata,
    categoryClassification: { ...metadata.categoryClassification, catalogMatchedAt: previousAt },
  };
}

async function existingMetadata(
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[],
  chunkSize = LOOKUP_CHUNK_SIZE,
): Promise<Array<ProductMetadataLookupRow & { last_seen_at?: string }>> {
  const uniqueIds = [...new Set(sourceIds)];
  const rows: Array<ProductMetadataLookupRow & { last_seen_at?: string }> = [];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT id, source_id, metadata_json, last_seen_at FROM products WHERE shop_key = ? AND source_id IN (${placeholders})`,
      )
      .bind(shopKey, ...chunk)
      .all<ProductMetadataLookupRow & { last_seen_at?: string }>();
    rows.push(...(result.results || []));
  }
  return rows;
}

export async function syncProductMetadata(
  db: QueryableDatabase,
  shopKey: string,
  products: readonly ProductMetadataSyncInput[],
  observedAt: string,
): Promise<number> {
  const rows = await existingMetadata(
    db,
    shopKey,
    products.map((product) => product.sourceId),
  );
  const bySourceId = new Map(rows.map((row) => [row.source_id, row]));
  const writes: D1PreparedStatement[] = [];

  for (const product of products) {
    const existing = bySourceId.get(product.sourceId);
    if (!existing) continue;
    if (existing.last_seen_at && Date.parse(observedAt) < Date.parse(existing.last_seen_at))
      continue;
    const previous = metadataObject(existing.metadata_json);
    let incoming = product.metadata;
    const version = categoryRuleVersion(incoming);
    if (version > 0 && version < categoryRuleVersion(previous)) {
      incoming = {
        ...metadataObject(incoming),
        categoryClassification: previous.categoryClassification,
      };
    }
    const metadataJson = normalizeMetadataJson(
      preserveCatalogDecisionTime(incoming, existing.metadata_json || "{}"),
    );
    if (normalizeMetadataJson(previous) === metadataJson) continue;
    writes.push(
      db
        .prepare(`UPDATE products SET metadata_json = ?, last_changed_at = ? WHERE id = ?
          AND metadata_json IS ? AND last_seen_at IS ?`)
        .bind(
          metadataJson,
          observedAt,
          existing.id,
          existing.metadata_json,
          existing.last_seen_at ?? null,
        ),
    );
  }

  if (!writes.length) return 0;
  let changedCount = 0;
  for (let i = 0; i < writes.length; i += LOOKUP_CHUNK_SIZE) {
    const results = await db.batch(writes.slice(i, i + LOOKUP_CHUNK_SIZE));
    for (const result of results || []) changedCount += Number(result?.meta?.changes || 0);
  }
  return changedCount;
}
