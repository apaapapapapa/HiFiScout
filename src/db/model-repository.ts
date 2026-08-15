/**
 * Model Resolution against stored listings.
 *
 * Everything here re-derives model fields from evidence that is already in D1, so a resolver rule
 * change never needs a shop to be crawled again. Replay is bounded, cursor-restartable, and
 * idempotent: a page always advances `model_resolver_version`, so a second run over the same rows
 * selects nothing, and only listings whose derived values actually moved are counted or recorded.
 */

import {
  applyManufacturerResolution,
  createManufacturerResolver,
} from "../catalog/manufacturer-resolver.js";
import {
  applyModelResolution,
  createModelResolver,
  MODEL_RESOLVER_VERSION,
} from "../catalog/model-resolver.js";
import type { ManufacturerAliasEvidence, NormalizedCatalogProduct } from "../catalog/types.js";
import { refreshListingProjections } from "./listing-projection-refresh.js";
import { listManufacturerAliasEvidence } from "./manufacturer-repository.js";
import { remediationEventStatement } from "./remediation-event-repository.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 250;
const WRITE_BATCH_SIZE = 50;

export interface ModelReplayOptions {
  afterId?: number;
  limit?: number;
  evaluatedAt?: string;
}

export interface ModelReplayResult {
  processedCount: number;
  changedCount: number;
  nextAfterId: number | null;
  hasMore: boolean;
}

export interface UnresolvedModelGroup {
  canonicalManufacturerId: string;
  normalizedModel: string;
  sampleRawModel: string;
  resolutionStatus: string;
  resolutionMethod: string;
  listingCount: number;
  shopCount: number;
}

interface ModelReplayListingRow {
  id: number;
  shop_key: string;
  source_id: string;
  canonical_manufacturer_id: string;
  model: string;
  raw_model: string;
  normalized_model: string;
  model_resolution_status: string;
  model_resolution_method: string;
  model_resolution_confidence: string;
  title: string;
  metadata_json: string;
}

interface UnresolvedModelGroupRow {
  canonical_manufacturer_id: string;
  normalized_model: string;
  sample_raw_model: string;
  model_resolution_status: string;
  model_resolution_method: string;
  listing_count: number;
  shop_count: number;
}

function boundedLimit(value: number | undefined): number {
  return Math.min(MAX_REPLAY_LIMIT, Math.max(1, Number(value) || DEFAULT_REPLAY_LIMIT));
}

/**
 * Manufacturer first, then model: Model Resolution needs the canonical manufacturer to know which
 * presentation tokens are safe to remove and whether title evidence may be used at all.
 */
export async function resolveProductCatalogFields(
  db: ReadableDatabase,
  products: readonly NormalizedCatalogProduct[],
  aliases?: readonly ManufacturerAliasEvidence[],
): Promise<NormalizedCatalogProduct[]> {
  const evidence = aliases ?? (await listManufacturerAliasEvidence(db));
  const manufacturerResolver = createManufacturerResolver(evidence);
  const modelResolver = createModelResolver(evidence);
  return products.map((product) =>
    applyModelResolution(applyManufacturerResolution(product, manufacturerResolver), modelResolver),
  );
}

export async function selectStaleModelListings(
  db: ReadableDatabase,
  { afterId = 0, limit }: ModelReplayOptions = {},
): Promise<{ rows: ModelReplayListingRow[]; hasMore: boolean }> {
  const take = boundedLimit(limit);
  const result = await db
    .prepare(`
      SELECT id, shop_key, source_id, canonical_manufacturer_id, model, raw_model, normalized_model,
             model_resolution_status, model_resolution_method, model_resolution_confidence,
             title, metadata_json
      FROM products
      WHERE is_active = 1 AND id > ? AND model_resolver_version < ?
      ORDER BY id
      LIMIT ?
    `)
    .bind(afterId, MODEL_RESOLVER_VERSION, take + 1)
    .all<ModelReplayListingRow>();
  const rows = result.results || [];
  return { rows: rows.slice(0, take), hasMore: rows.length > take };
}

/**
 * Replay one bounded page of listings whose stored model predates the current resolver version.
 *
 * Only derived model fields move; price, stock, source URL and shop timestamps are seller facts and
 * are never touched. Identity and the Phase 4 projection are refreshed in dependency order for the
 * listings that actually changed.
 */
export async function reprocessStaleModelListings(
  db: QueryableDatabase,
  options: ModelReplayOptions = {},
): Promise<ModelReplayResult> {
  const evaluatedAt = options.evaluatedAt || new Date().toISOString();
  const selected = await selectStaleModelListings(db, options);
  const resolver = createModelResolver(await listManufacturerAliasEvidence(db));
  const changed: ModelReplayListingRow[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const row of selected.rows) {
    const resolution = resolver({
      rawModel: row.raw_model || row.model,
      title: row.title,
      manufacturerId: row.canonical_manufacturer_id,
    });
    const moved =
      row.model !== resolution.model ||
      row.normalized_model !== resolution.normalizedModel ||
      row.model_resolution_status !== resolution.status ||
      row.model_resolution_method !== resolution.method ||
      row.model_resolution_confidence !== resolution.confidence;
    const metadata = {
      version: MODEL_RESOLVER_VERSION,
      status: resolution.status,
      method: resolution.method,
      confidence: resolution.confidence,
      normalizedModel: resolution.normalizedModel,
      removedAnnotations: resolution.removedAnnotations,
      unclassifiedTokens: resolution.unclassifiedTokens,
    };
    // The version always advances, even for a no-op, so the cursor cannot re-select this row.
    statements.push(
      db
        .prepare(`
          UPDATE products SET
            model = ?, raw_model = ?, normalized_model = ?, model_resolution_status = ?,
            model_resolution_method = ?, model_resolution_confidence = ?,
            model_resolver_version = ?,
            metadata_json = json_set(
              CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
              '$.modelNormalization', json(?)
            ),
            last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END
          WHERE id = ?
        `)
        .bind(
          resolution.model || row.model,
          resolution.rawModel || row.raw_model || row.model,
          resolution.normalizedModel,
          resolution.status,
          resolution.method,
          resolution.confidence,
          MODEL_RESOLVER_VERSION,
          JSON.stringify(metadata),
          moved ? 1 : 0,
          evaluatedAt,
          row.id,
        ),
    );
    if (!moved) continue;
    statements.push(
      remediationEventStatement(db, {
        listingProductId: Number(row.id),
        shopKey: row.shop_key,
        sourceId: row.source_id,
        field: "model",
        previousValue: `${row.model} (${row.normalized_model || "-"}/${row.model_resolution_status})`,
        newValue: `${resolution.model} (${resolution.normalizedModel || "-"}/${resolution.status})`,
        reason: "model_resolver_version_replay",
        resolverMethod: resolution.method,
        resolverConfidence: resolution.confidence,
        resolverVersion: MODEL_RESOLVER_VERSION,
        processedAt: evaluatedAt,
      }),
    );
    changed.push(row);
  }

  for (let index = 0; index < statements.length; index += WRITE_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + WRITE_BATCH_SIZE));
  }
  await refreshListingProjections(db, changed, evaluatedAt);

  const last = selected.rows.at(-1);
  return {
    processedCount: selected.rows.length,
    changedCount: changed.length,
    nextAfterId: selected.hasMore && last ? Number(last.id) : null,
    hasMore: selected.hasMore,
  };
}

/** Highest-impact model extraction failures for DQ/admin surfaces. */
export async function listUnresolvedModelGroups(
  db: ReadableDatabase,
  limit = 50,
): Promise<UnresolvedModelGroup[]> {
  const result = await db
    .prepare(`
      SELECT canonical_manufacturer_id,
             normalized_model,
             MIN(raw_model) AS sample_raw_model,
             model_resolution_status,
             model_resolution_method,
             COUNT(*) AS listing_count,
             COUNT(DISTINCT shop_key) AS shop_count
      FROM products
      WHERE is_active = 1 AND model_resolution_status <> 'resolved'
      GROUP BY canonical_manufacturer_id, normalized_model, model_resolution_status,
               model_resolution_method
      ORDER BY listing_count DESC, shop_count DESC, canonical_manufacturer_id, normalized_model
      LIMIT ?
    `)
    .bind(Math.min(200, Math.max(1, Number(limit) || 50)))
    .all<UnresolvedModelGroupRow>();
  return (result.results || []).map((row) => ({
    canonicalManufacturerId: row.canonical_manufacturer_id,
    normalizedModel: row.normalized_model,
    sampleRawModel: row.sample_raw_model,
    resolutionStatus: row.model_resolution_status,
    resolutionMethod: row.model_resolution_method,
    listingCount: Number(row.listing_count),
    shopCount: Number(row.shop_count),
  }));
}
