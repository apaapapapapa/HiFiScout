/**
 * The Knowledge Catalog remediation loop.
 *
 * Listings that Product Identity cannot resolve become a structured, impact-ordered candidate
 * process instead of an unorganized backlog, and a catalog entry that becomes verified can be
 * applied to the listings it explains without any shop being crawled again.
 *
 * Candidate creation is not verification: nothing here promotes a listing to a canonical product.
 * Replay only re-runs the existing conservative resolver against evidence that has changed, so a
 * group repeated across many shops still cannot merge until the catalog says it may.
 */

import { normalizeIdentityModel } from "../catalog/product-identity.js";
import { refreshListingProjections } from "./listing-projection-refresh.js";
import { remediationEventStatement } from "./remediation-event-repository.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 250;
const MAX_IDENTITY_MODELS = 20;
const LOOKUP_CHUNK_SIZE = 50;
const WRITE_BATCH_SIZE = 50;

export interface CatalogRemediationTarget {
  catalogProductId: number;
  manufacturerId: string;
  canonicalModel: string;
  /** Identity-normalized canonical model plus verified model aliases. */
  identityModels: string[];
}

export interface CatalogRemediationOptions {
  afterId?: number;
  limit?: number;
  evaluatedAt?: string;
}

export interface CatalogRemediationResult {
  processedCount: number;
  changedCount: number;
  matchedCount: number;
  nextAfterId: number | null;
  hasMore: boolean;
}

export interface UnresolvedIdentityGroup {
  canonicalManufacturerId: string;
  normalizedModel: string;
  sampleModel: string;
  sampleRawModel: string;
  sampleSourceUrl: string;
  identityRejectionReason: string;
  listingCount: number;
  shopCount: number;
  unclassifiedCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface UnresolvedIdentityGroupRow {
  canonical_manufacturer_id: string;
  normalized_model: string;
  sample_model: string;
  sample_raw_model: string;
  sample_source_url: string;
  identity_rejection_reason: string;
  listing_count: number;
  shop_count: number;
  unclassified_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

interface RemediationListingRow {
  id: number;
  shop_key: string;
  source_id: string;
}

interface IdentityStateRow {
  listing_product_id: number;
  catalog_product_id: number | null;
  status: string;
  match_method: string;
}

interface IdentityState {
  catalogProductId: number | null;
  status: string;
  matchMethod: string;
}

function boundedLimit(value: number | undefined): number {
  return Math.min(MAX_REPLAY_LIMIT, Math.max(1, Number(value) || DEFAULT_REPLAY_LIMIT));
}

function describe(state: IdentityState | undefined): string {
  if (!state) return "none";
  return `${state.status}:${state.matchMethod}:${state.catalogProductId ?? "-"}`;
}

/**
 * Highest-impact unresolved groups, keyed exactly as the skill requires: canonical manufacturer
 * plus normalized model. A human can read one row and decide whether to add a catalog entry.
 */
export async function listUnresolvedIdentityGroups(
  db: ReadableDatabase,
  limit = 50,
): Promise<UnresolvedIdentityGroup[]> {
  const result = await db
    .prepare(`
      SELECT p.canonical_manufacturer_id,
             p.normalized_model,
             MIN(p.model) AS sample_model,
             MIN(p.raw_model) AS sample_raw_model,
             MIN(p.source_url) AS sample_source_url,
             MIN(COALESCE(r.match_method, 'missing_resolution')) AS identity_rejection_reason,
             COUNT(*) AS listing_count,
             COUNT(DISTINCT p.shop_key) AS shop_count,
             SUM(CASE WHEN p.classification_status <> 'classified' THEN 1 ELSE 0 END)
               AS unclassified_count,
             MIN(p.first_seen_at) AS first_seen_at,
             MAX(p.last_seen_at) AS last_seen_at
      FROM products p
      LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
      WHERE p.is_active = 1
        AND p.canonical_manufacturer_id <> ''
        AND p.normalized_model <> ''
        AND COALESCE(r.status, 'unresolved') <> 'matched'
      GROUP BY p.canonical_manufacturer_id, p.normalized_model
      ORDER BY listing_count DESC, shop_count DESC,
               p.canonical_manufacturer_id, p.normalized_model
      LIMIT ?
    `)
    .bind(Math.min(200, Math.max(1, Number(limit) || 50)))
    .all<UnresolvedIdentityGroupRow>();
  return (result.results || []).map((row) => ({
    canonicalManufacturerId: row.canonical_manufacturer_id,
    normalizedModel: row.normalized_model,
    sampleModel: row.sample_model || "",
    sampleRawModel: row.sample_raw_model || "",
    sampleSourceUrl: row.sample_source_url || "",
    identityRejectionReason: row.identity_rejection_reason || "missing_resolution",
    listingCount: Number(row.listing_count),
    shopCount: Number(row.shop_count),
    unclassifiedCount: Number(row.unclassified_count || 0),
    firstSeenAt: row.first_seen_at || "",
    lastSeenAt: row.last_seen_at || "",
  }));
}

/**
 * Resolve which stored listings a verified catalog entry can now explain.
 *
 * The selector is the identity normalization, not the catalog's own model spelling, because that
 * is the representation Product Identity actually compares.
 */
export async function loadCatalogRemediationTarget(
  db: ReadableDatabase,
  catalogProductId: number,
): Promise<CatalogRemediationTarget | null> {
  const product = await db
    .prepare(`
      SELECT id, manufacturer_id, canonical_model
      FROM knowledge_catalog_products
      WHERE id = ? AND verification_status = 'verified'
    `)
    .bind(catalogProductId)
    .first<{ id: number; manufacturer_id: string; canonical_model: string }>();
  if (!product) return null;

  const aliases = await db
    .prepare(`
      SELECT alias FROM knowledge_catalog_aliases
      WHERE product_id = ? AND alias_type = 'model'
      ORDER BY normalized_alias
      LIMIT ?
    `)
    .bind(product.id, MAX_IDENTITY_MODELS)
    .all<{ alias: string }>();

  const identityModels = [
    ...new Set(
      [product.canonical_model, ...(aliases.results || []).map((row) => row.alias)]
        .map((value) => normalizeIdentityModel(value))
        .filter(Boolean),
    ),
  ]
    .sort()
    .slice(0, MAX_IDENTITY_MODELS);
  if (!identityModels.length) return null;

  return {
    catalogProductId: Number(product.id),
    manufacturerId: String(product.manufacturer_id || "").toLowerCase(),
    canonicalModel: product.canonical_model,
    identityModels,
  };
}

export async function selectListingsForCatalogRemediation(
  db: ReadableDatabase,
  target: CatalogRemediationTarget,
  { afterId = 0, limit }: CatalogRemediationOptions = {},
): Promise<{ rows: RemediationListingRow[]; hasMore: boolean }> {
  const take = boundedLimit(limit);
  const placeholders = target.identityModels.map(() => "?").join(",");
  const result = await db
    .prepare(`
      SELECT id, shop_key, source_id
      FROM products
      WHERE is_active = 1 AND id > ? AND canonical_manufacturer_id = ?
        AND normalized_model IN (${placeholders})
      ORDER BY id
      LIMIT ?
    `)
    .bind(afterId, target.manufacturerId, ...target.identityModels, take + 1)
    .all<RemediationListingRow>();
  const rows = result.results || [];
  return { rows: rows.slice(0, take), hasMore: rows.length > take };
}

async function loadIdentityStates(
  db: ReadableDatabase,
  listingIds: readonly number[],
): Promise<Map<number, IdentityState>> {
  const states = new Map<number, IdentityState>();
  for (let index = 0; index < listingIds.length; index += LOOKUP_CHUNK_SIZE) {
    const chunk = listingIds.slice(index, index + LOOKUP_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT listing_product_id, catalog_product_id, status, match_method
        FROM product_identity_resolutions
        WHERE listing_product_id IN (${placeholders})
      `)
      .bind(...chunk)
      .all<IdentityStateRow>();
    for (const row of result.results || []) {
      states.set(Number(row.listing_product_id), {
        catalogProductId: row.catalog_product_id === null ? null : Number(row.catalog_product_id),
        status: row.status,
        matchMethod: row.match_method,
      });
    }
  }
  return states;
}

/**
 * Apply one verified catalog entry to a bounded page of the listings it explains.
 *
 * Seller facts are untouched. Only Product Identity and the projections that depend on it are
 * recomputed, and only listings whose identity actually moved produce a provenance row.
 */
export async function reprocessCatalogRemediationTarget(
  db: QueryableDatabase,
  target: CatalogRemediationTarget,
  options: CatalogRemediationOptions = {},
): Promise<CatalogRemediationResult> {
  const evaluatedAt = options.evaluatedAt || new Date().toISOString();
  const selected = await selectListingsForCatalogRemediation(db, target, options);
  const listingIds = selected.rows.map((row) => Number(row.id));
  const before = await loadIdentityStates(db, listingIds);

  await refreshListingProjections(db, selected.rows, evaluatedAt);

  const after = await loadIdentityStates(db, listingIds);
  const statements: D1PreparedStatement[] = [];
  let matchedCount = 0;
  for (const row of selected.rows) {
    const previous = before.get(Number(row.id));
    const next = after.get(Number(row.id));
    if (next?.status === "matched") matchedCount += 1;
    if (describe(previous) === describe(next)) continue;
    statements.push(
      remediationEventStatement(db, {
        listingProductId: Number(row.id),
        shopKey: row.shop_key,
        sourceId: row.source_id,
        field: "identity",
        previousValue: describe(previous),
        newValue: describe(next),
        reason: `verified_catalog_product:${target.catalogProductId}`,
        resolverMethod: next?.matchMethod || "",
        resolverConfidence: next?.status === "matched" ? "high" : "none",
        processedAt: evaluatedAt,
      }),
    );
  }
  for (let index = 0; index < statements.length; index += WRITE_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + WRITE_BATCH_SIZE));
  }

  const last = selected.rows.at(-1);
  return {
    processedCount: selected.rows.length,
    changedCount: statements.length,
    matchedCount,
    nextAfterId: selected.hasMore && last ? Number(last.id) : null,
    hasMore: selected.hasMore,
  };
}

/** Load the verified catalog entry and replay its first page; resume with `nextAfterId`. */
export async function reprocessVerifiedCatalogProduct(
  db: QueryableDatabase,
  catalogProductId: number,
  options: CatalogRemediationOptions = {},
): Promise<{ target: CatalogRemediationTarget | null; replay: CatalogRemediationResult | null }> {
  const target = await loadCatalogRemediationTarget(db, catalogProductId);
  if (!target) return { target: null, replay: null };
  return { target, replay: await reprocessCatalogRemediationTarget(db, target, options) };
}

export interface PendingCatalogReplayOptions extends CatalogRemediationOptions {
  productLimit?: number;
}

export interface PendingCatalogReplaySummary {
  catalogProducts: number;
  processedCount: number;
  changedCount: number;
  matchedCount: number;
  /** Verified products still owed a replay after this invocation, including this run's leftovers. */
  pendingProducts: number;
  /** True when either the product page or a product's listing page left durable work behind. */
  hasMoreProducts: boolean;
  /** Exact durable product backlog after this invocation. */
  remainingProductCount: number;
  /** Backward-compatible explicit incomplete count for finalizer/status reporting. */
  incompleteProductCount: number;
}

interface PendingCatalogProductRow {
  id: number;
  last_verified_at: string;
  remediation_after_listing_id: number;
}

/** Verified entries whose listings have not been replayed since the entry was last verified. */
const PENDING_REMEDIATION_PREDICATE = `
  verification_status = 'verified'
  AND (last_remediated_at IS NULL OR last_remediated_at < last_verified_at)
`;

/**
 * Drain the remediation backlog.
 *
 * Selection is a durable watermark rather than a time window: a run that verifies more entries than
 * one invocation can replay leaves the remainder selectable, so the next run continues instead of
 * stranding them behind a newer `started_at`. Oldest verification first, so the backlog drains in
 * order. `last_remediated_at` advances only when a product's listings are fully replayed, which
 * makes a partially replayed product resume on the next invocation.
 *
 * Bounded on both axes — at most `productLimit` entries, one listing page each — and
 * `pendingProducts` reports what is still owed rather than truncating silently.
 */
export async function reprocessPendingCatalogRemediation(
  db: QueryableDatabase,
  { productLimit = 20, limit, evaluatedAt }: PendingCatalogReplayOptions = {},
): Promise<PendingCatalogReplaySummary> {
  const processedAt = evaluatedAt || new Date().toISOString();
  const take = Math.min(100, Math.max(1, Math.trunc(Number(productLimit) || 20)));
  const productPage = await db
    .prepare(`
      SELECT id, last_verified_at, remediation_after_listing_id
      FROM knowledge_catalog_products
      WHERE ${PENDING_REMEDIATION_PREDICATE}
      ORDER BY last_verified_at, id
      LIMIT ?
    `)
    .bind(take + 1)
    .all<PendingCatalogProductRow>();
  const pendingPage = productPage.results || [];
  const products = pendingPage.slice(0, take);

  const summary: PendingCatalogReplaySummary = {
    catalogProducts: 0,
    processedCount: 0,
    changedCount: 0,
    matchedCount: 0,
    pendingProducts: 0,
    hasMoreProducts: pendingPage.length > take,
    remainingProductCount: 0,
    incompleteProductCount: 0,
  };
  for (const row of products) {
    const { target, replay } = await reprocessVerifiedCatalogProduct(db, Number(row.id), {
      afterId: Number(row.remediation_after_listing_id) || 0,
      limit,
      evaluatedAt: processedAt,
    });
    if (!target || !replay) continue;
    summary.catalogProducts += 1;
    summary.processedCount += replay.processedCount;
    summary.changedCount += replay.changedCount;
    summary.matchedCount += replay.matchedCount;
    // Persist progress after each successfully refreshed product. If a later product fails, this
    // one does not lose its cursor; if this write itself fails, replaying the same page is safe.
    if (replay.hasMore && replay.nextAfterId !== null) {
      await db.batch([
        db
          .prepare(`
            UPDATE knowledge_catalog_products
            SET remediation_after_listing_id = ?, updated_at = ?
            WHERE id = ? AND last_verified_at = ?
          `)
          .bind(replay.nextAfterId, processedAt, target.catalogProductId, row.last_verified_at),
      ]);
    } else {
      await db.batch([
        db
          .prepare(`
            UPDATE knowledge_catalog_products
            SET last_remediated_at = ?, remediation_after_listing_id = 0, updated_at = ?
            WHERE id = ? AND last_verified_at = ?
          `)
          .bind(processedAt, processedAt, target.catalogProductId, row.last_verified_at),
      ]);
    }
  }

  const remaining = await db
    .prepare(
      `SELECT COUNT(*) AS pending FROM knowledge_catalog_products WHERE ${PENDING_REMEDIATION_PREDICATE}`,
    )
    .first<{ pending: number }>();
  summary.pendingProducts = Number(remaining?.pending || 0);
  summary.hasMoreProducts ||= summary.pendingProducts > 0;
  summary.remainingProductCount = summary.pendingProducts;
  summary.incompleteProductCount = summary.pendingProducts;
  return summary;
}
