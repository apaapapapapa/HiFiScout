/**
 * Model Resolution against stored listings.
 *
 * Everything here re-derives model fields from evidence that is already in D1, so a resolver rule
 * change never needs a shop to be crawled again. Replay is bounded, cursor-restartable, and
 * idempotent: a completed page has the current `model_resolver_version` and no pending projection
 * refresh. A page whose downstream refresh failed remains selected even though its derived fields
 * were already evaluated, and only values that actually moved are counted or recorded.
 */

import {
  applyManufacturerResolution,
  createManufacturerResolver,
} from "../catalog/manufacturer-resolver.js";
import { presentationColorLabel } from "../catalog/model-presentation-color.js";
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
  /** Optional seller scope for prioritizing a shop-specific resolver change. */
  shopKey?: string;
}

export interface ModelReplayResult {
  processedCount: number;
  changedCount: number;
  nextAfterId: number | null;
  hasMore: boolean;
}

export interface ModelReplayDependencies {
  /** Test seam for deterministic downstream failure injection. */
  refreshListings?: typeof refreshListingProjections;
}

export interface ResolveProductCatalogFieldsOptions {
  aliases?: readonly ManufacturerAliasEvidence[];
  /** Source seller used by narrowly scoped model-annotation rules. */
  shopKey?: string;
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
  presentation_color: string;
  model_resolution_status: string;
  model_resolution_method: string;
  model_resolution_confidence: string;
  model_resolver_version: number;
  remediation_projection_required: number;
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
  options: ResolveProductCatalogFieldsOptions = {},
): Promise<NormalizedCatalogProduct[]> {
  const evidence = options.aliases ?? (await listManufacturerAliasEvidence(db));
  const manufacturerResolver = createManufacturerResolver(evidence);
  const modelResolver = createModelResolver(evidence);
  return products.map((product) =>
    applyModelResolution(
      applyManufacturerResolution(product, manufacturerResolver),
      modelResolver,
      options.shopKey,
    ),
  );
}

/** `model (normalized/finish/status)`, the shape remediation history is read in. */
function modelAuditValue(
  model: string,
  normalizedModel: string,
  presentationColor: string,
  status: string,
): string {
  return `${model} (${normalizedModel || "-"}/${presentationColor || "-"}/${status})`;
}

export async function selectStaleModelListings(
  db: ReadableDatabase,
  { afterId = 0, limit, shopKey = "" }: ModelReplayOptions = {},
): Promise<{ rows: ModelReplayListingRow[]; hasMore: boolean }> {
  const take = boundedLimit(limit);
  const result = await db
    .prepare(`
      SELECT id, shop_key, source_id, canonical_manufacturer_id, model, raw_model, normalized_model,
             presentation_color, model_resolution_status, model_resolution_method,
             model_resolution_confidence,
             model_resolver_version, remediation_projection_required, title, metadata_json
      FROM products
      WHERE is_active = 1 AND id > ?
        AND (? = '' OR shop_key = ?)
        AND (model_resolver_version < ? OR remediation_projection_required = 1)
      ORDER BY id
      LIMIT ?
    `)
    .bind(afterId, shopKey, shopKey, MODEL_RESOLVER_VERSION, take + 1)
    .all<ModelReplayListingRow>();
  const rows = result.results || [];
  return { rows: rows.slice(0, take), hasMore: rows.length > take };
}

/**
 * Replay one bounded page of listings whose stored model predates the current resolver version.
 *
 * Only derived model fields move; price, stock, source URL and shop timestamps are seller facts and
 * are never touched. Identity and the Phase 4 projection are refreshed in dependency order for
 * every selected listing, including a retry whose derived values already moved on its failed pass.
 */
export async function reprocessStaleModelListings(
  db: QueryableDatabase,
  options: ModelReplayOptions = {},
  dependencies: ModelReplayDependencies = {},
): Promise<ModelReplayResult> {
  const evaluatedAt = options.evaluatedAt || new Date().toISOString();
  const selected = await selectStaleModelListings(db, options);
  if (!selected.rows.length) {
    return {
      processedCount: 0,
      changedCount: 0,
      nextAfterId: null,
      hasMore: false,
    };
  }
  const resolver = createModelResolver(await listManufacturerAliasEvidence(db));
  const refreshListings = dependencies.refreshListings || refreshListingProjections;
  const replayToken = crypto.randomUUID();
  const changed: ModelReplayListingRow[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const row of selected.rows) {
    const resolution = resolver({
      rawModel: row.raw_model,
      title: row.title,
      manufacturerId: row.canonical_manufacturer_id,
      shopKey: row.shop_key,
    });
    const presentationColor = presentationColorLabel(resolution.presentationColors);
    const moved =
      row.model !== resolution.model ||
      row.normalized_model !== resolution.normalizedModel ||
      (row.presentation_color ?? "") !== presentationColor ||
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
      presentationColors: resolution.presentationColors,
    };
    // The resolver version means the algorithm ran. The separate pending bit remains set until all
    // downstream read models have refreshed, so a failure cannot make this row disappear from the
    // retry selector merely because its resolver version is already current.
    statements.push(
      db
        .prepare(`
          UPDATE products SET
            model = ?, normalized_model = ?, presentation_color = ?, model_resolution_status = ?,
            model_resolution_method = ?, model_resolution_confidence = ?,
            model_resolver_version = ?,
            remediation_projection_required = 1,
            remediation_projection_token = ?,
            metadata_json = json_set(
              CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
              '$.modelNormalization', json(?)
            ),
            last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END
          WHERE id = ?
        `)
        .bind(
          resolution.model,
          resolution.normalizedModel,
          presentationColor,
          resolution.status,
          resolution.method,
          resolution.confidence,
          MODEL_RESOLVER_VERSION,
          replayToken,
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
        // A replay may move only the finish; include it so the audit event still has a real diff.
        previousValue: modelAuditValue(
          row.model,
          row.normalized_model,
          row.presentation_color,
          row.model_resolution_status,
        ),
        newValue: modelAuditValue(
          resolution.model,
          resolution.normalizedModel,
          presentationColor,
          resolution.status,
        ),
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
  // Refresh every selected row, not just values that moved. A retry sees the already-derived values
  // as a no-op, but the pending bit proves its previous projection refresh did not finish.
  await refreshListings(db, selected.rows, evaluatedAt);
  const completed = selected.rows.map((row) =>
    db
      .prepare(`
        UPDATE products
        SET remediation_projection_required = 0, remediation_projection_token = ''
        WHERE id = ? AND model_resolver_version = ? AND remediation_projection_token = ?
      `)
      .bind(row.id, MODEL_RESOLVER_VERSION, replayToken),
  );
  for (let index = 0; index < completed.length; index += WRITE_BATCH_SIZE) {
    await db.batch(completed.slice(index, index + WRITE_BATCH_SIZE));
  }

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
