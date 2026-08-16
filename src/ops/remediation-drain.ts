import {
  classifyCategoryEvidence,
  summarizeCategoryEvidence,
} from "../catalog/category-classifier.js";
import { collectListingCategoryEvidence } from "../catalog/category-evidence.js";
import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import type { CategoryEvidenceInput } from "../catalog/types.js";
import { reprocessStaleManufacturerListings } from "../db/manufacturer-repository.js";
import { reprocessStaleModelListings } from "../db/model-repository.js";
import { refreshListingProjections } from "../db/listing-projection-refresh.js";
import type { QueryableDatabase } from "../db/types.js";
import { isRecord } from "../types.js";

interface RemediationDrainEnv {
  DB: D1Database;
}

interface ReplayStatusRow {
  active_listings: number;
  stale_manufacturer: number;
  stale_model: number;
  stale_category: number;
  stale_identity: number;
  projection_dirty: number;
}

interface QueueStatusRow {
  pending: number;
  processing: number;
  resolved: number;
  failed: number;
}

interface CategoryReplayRow {
  id: number;
  shop_key: string;
  source_id: string;
  title: string;
  category: string;
  raw_category: string;
  metadata_json: string;
}

const BULK_LIMIT = 250;
const WRITE_BATCH_SIZE = 50;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function metadataObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function categoryMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return isRecord(metadata.categoryClassification) ? metadata.categoryClassification : {};
}

function categoryEvidence(row: CategoryReplayRow, metadata: Record<string, unknown>) {
  const stored = categoryMetadata(metadata).evidence;
  if (Array.isArray(stored)) {
    const evidence = stored.filter(
      (entry): entry is CategoryEvidenceInput =>
        isRecord(entry) &&
        Array.isArray(entry.categoryIds) &&
        typeof entry.source === "string" &&
        typeof entry.strength === "string",
    );
    if (evidence.length) return evidence;
  }
  return collectListingCategoryEvidence({
    title: row.title,
    rawCategory: row.raw_category,
    hintedCategory: row.category,
  }).evidence;
}

async function replayStatus(db: QueryableDatabase) {
  const versions = RESOLUTION_VERSIONS;
  const [stale, queue] = await Promise.all([
    db
      .prepare(`
        SELECT
          COUNT(*) AS active_listings,
          SUM(CASE WHEN p.manufacturer_resolver_version < ? THEN 1 ELSE 0 END) AS stale_manufacturer,
          SUM(CASE WHEN p.model_resolver_version < ? THEN 1 ELSE 0 END) AS stale_model,
          SUM(CASE
            WHEN COALESCE(CAST(json_extract(p.metadata_json, '$.categoryClassification.version') AS INTEGER), 0) < ?
            THEN 1 ELSE 0 END) AS stale_category,
          SUM(CASE WHEN COALESCE(r.identity_resolver_version, 0) < ? THEN 1 ELSE 0 END) AS stale_identity,
          SUM(CASE WHEN p.remediation_projection_required = 1 THEN 1 ELSE 0 END) AS projection_dirty
        FROM products p
        LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
        WHERE p.is_active = 1
      `)
      .bind(versions.manufacturer, versions.model, versions.category, versions.identity)
      .first<ReplayStatusRow>(),
    db
      .prepare(`
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM data_quality_remediation_queue
      `)
      .first<QueueStatusRow>(),
  ]);

  const safeStale = stale || {
    active_listings: 0,
    stale_manufacturer: 0,
    stale_model: 0,
    stale_category: 0,
    stale_identity: 0,
    projection_dirty: 0,
  };
  const safeQueue = queue || { pending: 0, processing: 0, resolved: 0, failed: 0 };
  const staleTotal =
    Number(safeStale.stale_manufacturer || 0) +
    Number(safeStale.stale_model || 0) +
    Number(safeStale.stale_category || 0) +
    Number(safeStale.stale_identity || 0) +
    Number(safeStale.projection_dirty || 0);

  return {
    versions,
    activeListings: Number(safeStale.active_listings || 0),
    stale: {
      manufacturer: Number(safeStale.stale_manufacturer || 0),
      model: Number(safeStale.stale_model || 0),
      category: Number(safeStale.stale_category || 0),
      identity: Number(safeStale.stale_identity || 0),
      projection: Number(safeStale.projection_dirty || 0),
      total: staleTotal,
    },
    queue: {
      pending: Number(safeQueue.pending || 0),
      processing: Number(safeQueue.processing || 0),
      resolved: Number(safeQueue.resolved || 0),
      failed: Number(safeQueue.failed || 0),
    },
  };
}

async function reprocessStaleCategoryListings(db: QueryableDatabase) {
  const selected = await db
    .prepare(`
      SELECT id, shop_key, source_id, title, category, raw_category, metadata_json
      FROM products
      WHERE is_active = 1
        AND COALESCE(CAST(json_extract(metadata_json, '$.categoryClassification.version') AS INTEGER), 0) < ?
      ORDER BY id
      LIMIT ?
    `)
    .bind(RESOLUTION_VERSIONS.category, BULK_LIMIT)
    .all<CategoryReplayRow>();
  const rows = selected.results || [];
  if (!rows.length) return { processedCount: 0, changedCount: 0, hasMore: false };

  const replayToken = crypto.randomUUID();
  const evaluatedAt = new Date().toISOString();
  const updates: D1PreparedStatement[] = [];
  let changedCount = 0;

  for (const row of rows) {
    const metadata = metadataObject(row.metadata_json);
    const evidence = categoryEvidence(row, metadata);
    const classification = classifyCategoryEvidence(evidence);
    const nextMetadata = {
      ...metadata,
      categoryClassification: {
        ...categoryMetadata(metadata),
        version: RESOLUTION_VERSIONS.category,
        state: classification.classificationState,
        status: classification.classificationStatus,
        reason: classification.classificationReason,
        source: classification.classificationSource,
        categoryIds: classification.categoryIds,
        candidateCategoryIds: classification.candidateCategoryIds,
        evidence: summarizeCategoryEvidence(evidence),
      },
    };
    const categoryIds = JSON.stringify(classification.categoryIds);
    const metadataJson = JSON.stringify(nextMetadata);
    if (row.category !== classification.displayName || row.metadata_json !== metadataJson) {
      changedCount += 1;
    }
    updates.push(
      db
        .prepare(`
          UPDATE products SET
            category = ?, primary_category_id = ?, category_ids = ?, classification_status = ?,
            search_aliases = ?, metadata_json = ?, remediation_projection_required = 1,
            remediation_projection_token = ?
          WHERE id = ?
        `)
        .bind(
          classification.displayName,
          classification.primaryCategoryId,
          categoryIds,
          classification.classificationStatus,
          classification.searchAliases,
          metadataJson,
          replayToken,
          row.id,
        ),
    );
  }
  for (let index = 0; index < updates.length; index += WRITE_BATCH_SIZE) {
    await db.batch(updates.slice(index, index + WRITE_BATCH_SIZE));
  }
  await refreshListingProjections(db, rows, evaluatedAt);
  const clears = rows.map((row) =>
    db
      .prepare(`
        UPDATE products
        SET remediation_projection_required = 0, remediation_projection_token = ''
        WHERE id = ? AND remediation_projection_token = ?
      `)
      .bind(row.id, replayToken),
  );
  for (let index = 0; index < clears.length; index += WRITE_BATCH_SIZE) {
    await db.batch(clears.slice(index, index + WRITE_BATCH_SIZE));
  }
  return { processedCount: rows.length, changedCount, hasMore: rows.length === BULK_LIMIT };
}

/** Local-only operational worker. It is never deployed and only exposes bounded bulk replay. */
export default {
  async fetch(request: Request, env: RemediationDrainEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return json(await replayStatus(env.DB));
    }
    if (request.method === "POST" && url.pathname === "/replay/manufacturer") {
      const before = await replayStatus(env.DB);
      const replay = await reprocessStaleManufacturerListings(env.DB, { limit: BULK_LIMIT });
      const after = await replayStatus(env.DB);
      return json({ before, replay, after });
    }
    if (request.method === "POST" && url.pathname === "/replay/model") {
      const before = await replayStatus(env.DB);
      const replay = await reprocessStaleModelListings(env.DB, { limit: BULK_LIMIT });
      const after = await replayStatus(env.DB);
      return json({ before, replay, after });
    }
    if (request.method === "POST" && url.pathname === "/replay/category") {
      const before = await replayStatus(env.DB);
      const replay = await reprocessStaleCategoryListings(env.DB);
      const after = await replayStatus(env.DB);
      return json({ before, replay, after });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<RemediationDrainEnv>;
