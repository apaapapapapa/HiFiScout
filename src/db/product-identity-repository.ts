import {
  loadCatalogLookupCandidates,
  loadFuzzyCatalogCandidates,
  type CatalogLookupRow,
  type CatalogLookupAliasRow,
} from "./catalog-lookup-candidates.js";
import { identitySafeModelLookupVariants } from "../catalog/knowledge-catalog.js";
import { prepareIdentityCandidates, resolveProductIdentity } from "../catalog/product-identity.js";
import { IDENTITY_RESOLVER_VERSION } from "../catalog/resolution-versions.js";
import type { IdentityCandidateInput, ProductIdentityResolution } from "../catalog/types.js";
import type {
  IdentitySyncMetrics,
  ProductIdentityResolutionRow,
  ProductRow,
  QueryableDatabase,
} from "./types.js";

const CHUNK_SIZE = 40;

export interface ProductIdentitySyncOptions {
  /** Legacy hint. Indexed candidate queries now always scope to one maker's requested model keys. */
  candidateManufacturerChunkSize?: number;
  /** Emit bounded candidate-query telemetry. Intended for operational replay, not normal crawls. */
  traceCandidateScopes?: boolean;
}

interface CatalogIdentityCandidate extends IdentityCandidateInput {
  id: number;
  manufacturerId: string;
  canonicalModel: string;
  persistedNormalizedModel: string;
  categoryIds: string[];
  aliases: string[];
}

type IdentityListingRow = Pick<
  ProductRow,
  | "id"
  | "source_id"
  | "canonical_manufacturer_id"
  | "model"
  | "title"
  | "raw_model"
  | "model_resolution_status"
  | "primary_category_id"
  | "classification_status"
>;

interface VersionedIdentityResolutionRow extends ProductIdentityResolutionRow {
  identity_resolver_version: number;
}

interface SerializedResolution {
  catalogProductId: number | null;
  candidateCatalogProductId: number | null;
  status: ProductIdentityResolution["status"];
  matchMethod: ProductIdentityResolution["matchMethod"];
  confidence: ProductIdentityResolution["confidence"];
  normalizedModel: string;
  modelStem: string;
  variantsJson: string;
  matchedFieldsJson: string;
  rejectedByJson: string;
}

function unique(values: readonly unknown[] = []): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function candidatesFromRows(
  rows: readonly CatalogLookupRow[],
  aliases: readonly CatalogLookupAliasRow[],
): CatalogIdentityCandidate[] {
  const byId = new Map<number, CatalogIdentityCandidate>();
  for (const row of rows) {
    let candidate = byId.get(Number(row.id));
    if (!candidate) {
      candidate = {
        id: Number(row.id),
        manufacturerId: row.manufacturer_id,
        canonicalModel: row.canonical_model,
        persistedNormalizedModel: row.normalized_model,
        categoryIds: [],
        aliases: [],
      };
      byId.set(candidate.id, candidate);
    }
    if (row.category_id && !candidate.categoryIds.includes(row.category_id))
      candidate.categoryIds.push(row.category_id);
  }
  for (const alias of aliases) byId.get(alias.product_id)?.aliases.push(alias.alias);
  for (const candidate of byId.values())
    candidate.aliases = unique([
      ...candidate.aliases,
      ...identitySafeModelLookupVariants({
        manufacturerId: candidate.manufacturerId,
        model: candidate.canonicalModel,
      }),
    ]);
  return [...byId.values()];
}

async function loadVerifiedIdentityCandidates(
  db: QueryableDatabase,
  listings: readonly IdentityListingRow[],
  traceCandidateScopes = false,
): Promise<Map<string, CatalogIdentityCandidate[]>> {
  const loaded = await loadCatalogLookupCandidates(
    db,
    listings.map((row) => ({
      manufacturerId: row.canonical_manufacturer_id.toLowerCase(),
      model: row.model,
    })),
    "identity",
  );
  const candidates = candidatesFromRows(loaded.rows, loaded.aliases);
  if (traceCandidateScopes)
    console.log(
      JSON.stringify({
        event: "product_identity_candidate_scope_complete",
        listing_count: listings.length,
        catalog_row_count: loaded.rows.length,
        scope: "model_keys",
      }),
    );
  const byManufacturer = new Map<string, CatalogIdentityCandidate[]>();
  for (const candidate of candidates) {
    const group = byManufacturer.get(candidate.manufacturerId) ?? [];
    group.push(candidate);
    byManufacturer.set(candidate.manufacturerId, group);
  }
  return byManufacturer;
}

async function loadListingRows(
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[] = [],
): Promise<IdentityListingRow[]> {
  const ids = unique(sourceIds);
  const rows: IdentityListingRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT id, source_id, canonical_manufacturer_id, model, title, raw_model, model_resolution_status,
               primary_category_id, classification_status
        FROM products
        WHERE shop_key = ? AND source_id IN (${placeholders})
      `)
      .bind(shopKey, ...chunk)
      .all<IdentityListingRow>();
    rows.push(...(result.results || []));
  }
  return rows;
}

async function loadExistingResolutions(
  db: QueryableDatabase,
  productIds: readonly number[] = [],
): Promise<Map<number, VersionedIdentityResolutionRow>> {
  const rows: VersionedIdentityResolutionRow[] = [];
  for (let i = 0; i < productIds.length; i += CHUNK_SIZE) {
    const chunk = productIds.slice(i, i + CHUNK_SIZE);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT listing_product_id, catalog_product_id, candidate_catalog_product_id, status,
               match_method, confidence, normalized_model, model_stem, variants_json,
               matched_fields_json, rejected_by_json, identity_resolver_version
        FROM product_identity_resolutions
        WHERE listing_product_id IN (${placeholders})
      `)
      .bind(...chunk)
      .all<VersionedIdentityResolutionRow>();
    rows.push(...(result.results || []));
  }
  return new Map(rows.map((row) => [Number(row.listing_product_id), row]));
}

function serializedResolution(resolution: ProductIdentityResolution): SerializedResolution {
  return {
    catalogProductId:
      resolution.catalogProductId == null ? null : Number(resolution.catalogProductId),
    candidateCatalogProductId:
      resolution.candidateCatalogProductId == null
        ? null
        : Number(resolution.candidateCatalogProductId),
    status: resolution.status,
    matchMethod: resolution.matchMethod,
    confidence: resolution.confidence,
    normalizedModel: resolution.normalizedModel,
    modelStem: resolution.modelStem,
    variantsJson: JSON.stringify(resolution.variants || []),
    matchedFieldsJson: JSON.stringify(resolution.matchedFields || []),
    rejectedByJson: JSON.stringify(resolution.rejectedBy || []),
  };
}

function sameResolution(
  existing: VersionedIdentityResolutionRow | undefined,
  next: SerializedResolution,
): boolean {
  return Boolean(
    existing &&
    Number(existing.identity_resolver_version) === IDENTITY_RESOLVER_VERSION &&
    (existing.catalog_product_id == null ? null : Number(existing.catalog_product_id)) ===
      next.catalogProductId &&
    (existing.candidate_catalog_product_id == null
      ? null
      : Number(existing.candidate_catalog_product_id)) === next.candidateCatalogProductId &&
    existing.status === next.status &&
    existing.match_method === next.matchMethod &&
    existing.confidence === next.confidence &&
    existing.normalized_model === next.normalizedModel &&
    existing.model_stem === next.modelStem &&
    existing.variants_json === next.variantsJson &&
    existing.matched_fields_json === next.matchedFieldsJson &&
    existing.rejected_by_json === next.rejectedByJson,
  );
}

function countMetrics(metrics: IdentitySyncMetrics, resolution: ProductIdentityResolution): void {
  if (resolution.matchMethod === "manufacturer_model_exact")
    metrics.identity_exact_match_count += 1;
  if (resolution.matchMethod === "catalog_alias") metrics.identity_alias_match_count += 1;
  if (
    resolution.matchMethod === "fuzzy_candidate" ||
    resolution.matchMethod === "fuzzy_ambiguous"
  ) {
    metrics.identity_fuzzy_match_count += 1;
  }
  if (resolution.status === "unresolved") metrics.identity_unresolved_count += 1;
  if (resolution.matchMethod === "vetoed") metrics.identity_veto_count += 1;
}

export async function syncProductIdentityResolutions(
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[] = [],
  evaluatedAt = new Date().toISOString(),
  options: ProductIdentitySyncOptions = {},
): Promise<IdentitySyncMetrics> {
  const listings = await loadListingRows(db, shopKey, sourceIds);
  const metrics: IdentitySyncMetrics = {
    identity_exact_match_count: 0,
    identity_alias_match_count: 0,
    identity_fuzzy_match_count: 0,
    identity_unresolved_count: 0,
    identity_veto_count: 0,
    identity_resolution_write_count: 0,
  };
  if (!listings.length) return metrics;

  const candidatesByManufacturer = await loadVerifiedIdentityCandidates(
    db,
    listings,
    options.traceCandidateScopes,
  );
  const preparedByManufacturer = new Map(
    [...candidatesByManufacturer].map(
      ([manufacturer, candidates]) =>
        [manufacturer, prepareIdentityCandidates(candidates)] as const,
    ),
  );
  const existing = await loadExistingResolutions(
    db,
    listings.map((row) => Number(row.id)),
  );
  const statements: D1PreparedStatement[] = [];

  const fuzzyByKey = new Map<string, ReturnType<typeof prepareIdentityCandidates>>();
  for (const listing of listings) {
    const manufacturerId = String(listing.canonical_manufacturer_id || "").toLowerCase();
    let resolution = resolveProductIdentity(
      { ...listing, manufacturer_id: manufacturerId },
      preparedByManufacturer.get(manufacturerId) || [],
    );
    if (resolution.matchMethod === "unresolved" && !resolution.rejectedBy.length) {
      const key = `${manufacturerId}:${listing.model}`;
      let fuzzy = fuzzyByKey.get(key);
      if (!fuzzy) {
        const loaded = await loadFuzzyCatalogCandidates(db, {
          manufacturerId,
          model: listing.model,
        });
        fuzzy = prepareIdentityCandidates(
          candidatesFromRows(loaded.rows, loaded.aliases).map((candidate) => ({
            ...candidate,
            fuzzyOnly: true,
          })),
        );
        fuzzyByKey.set(key, fuzzy);
      }
      if (fuzzy.length)
        resolution = resolveProductIdentity({ ...listing, manufacturer_id: manufacturerId }, [
          ...(preparedByManufacturer.get(manufacturerId) || []),
          ...fuzzy,
        ]);
    }
    countMetrics(metrics, resolution);
    const serialized = serializedResolution(resolution);
    if (sameResolution(existing.get(Number(listing.id)), serialized)) continue;

    statements.push(
      db
        .prepare(`
          INSERT INTO product_identity_resolutions(
            listing_product_id, catalog_product_id, candidate_catalog_product_id, status,
            match_method, confidence, normalized_model, model_stem, variants_json,
            matched_fields_json, rejected_by_json, identity_resolver_version, evaluated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(listing_product_id) DO UPDATE SET
            catalog_product_id = excluded.catalog_product_id,
            candidate_catalog_product_id = excluded.candidate_catalog_product_id,
            status = excluded.status,
            match_method = excluded.match_method,
            confidence = excluded.confidence,
            normalized_model = excluded.normalized_model,
            model_stem = excluded.model_stem,
            variants_json = excluded.variants_json,
            matched_fields_json = excluded.matched_fields_json,
            rejected_by_json = excluded.rejected_by_json,
            identity_resolver_version = excluded.identity_resolver_version,
            evaluated_at = excluded.evaluated_at
        `)
        .bind(
          Number(listing.id),
          serialized.catalogProductId,
          serialized.candidateCatalogProductId,
          serialized.status,
          serialized.matchMethod,
          serialized.confidence,
          serialized.normalizedModel,
          serialized.modelStem,
          serialized.variantsJson,
          serialized.matchedFieldsJson,
          serialized.rejectedByJson,
          IDENTITY_RESOLVER_VERSION,
          evaluatedAt,
        ),
    );
  }

  for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + CHUNK_SIZE));
  }
  metrics.identity_resolution_write_count = statements.length;
  console.log(JSON.stringify({ event: "product_identity_resolution", shopKey, ...metrics }));
  return metrics;
}
