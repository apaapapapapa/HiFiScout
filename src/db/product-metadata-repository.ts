const LOOKUP_CHUNK_SIZE = 50;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_METADATA_KEYS = 50;

function stableObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => typeof key === "string" && key.length <= 64 && entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_METADATA_KEYS),
  );
}

export function normalizeMetadataJson(metadata) {
  const json = JSON.stringify(stableObject(metadata));
  if (new TextEncoder().encode(json).byteLength > MAX_METADATA_BYTES) {
    throw new Error(`product metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  return json;
}

async function existingMetadata(db, shopKey, sourceIds, chunkSize = LOOKUP_CHUNK_SIZE) {
  const uniqueIds = [...new Set(sourceIds)];
  const rows = [];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT id, source_id, metadata_json FROM products WHERE shop_key = ? AND source_id IN (${placeholders})`,
      )
      .bind(shopKey, ...chunk)
      .all();
    rows.push(...(result.results || []));
  }
  return rows;
}

export async function syncProductMetadata(db, shopKey, products, observedAt) {
  const rows = await existingMetadata(
    db,
    shopKey,
    products.map((product) => product.sourceId),
  );
  const bySourceId = new Map(rows.map((row) => [row.source_id, row]));
  const writes = [];

  for (const product of products) {
    const existing = bySourceId.get(product.sourceId);
    if (!existing) continue;
    const metadataJson = normalizeMetadataJson(product.metadata);
    if ((existing.metadata_json || "{}") === metadataJson) continue;
    writes.push(
      db
        .prepare("UPDATE products SET metadata_json = ?, last_changed_at = ? WHERE id = ?")
        .bind(metadataJson, observedAt, existing.id),
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
