import { catalogModelLookupVariants } from "../catalog/knowledge-catalog.js";
import { resolveProductIdentity } from "../catalog/product-identity.js";
import type { IdentityCandidateInput, ProductIdentityResolution } from "../catalog/types.js";
import type {
  IdentitySyncMetrics,
  ProductIdentityResolutionRow,
  ProductRow,
  QueryableDatabase,
} from "./types.js";

const CHUNK_SIZE = 40;

interface CatalogIdentityCandidate extends IdentityCandidateInput {
  id: number;
  manufacturerId: string;
  canonicalModel: string;
  persistedNormalizedModel: string;
  categoryIds: string[];
  aliases: string[];
}

interface CatalogIdentityRow {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  normalized_model: string;
  category_id: string | null;
}

interface CatalogAliasRow {
  product_id: number;
  alias: string;
}

type IdentityListingRow = Pick<
  ProductRow,
  | "id"
  | "source_id"
  | "canonical_manufacturer_id"
  | "model"
  | "primary_category_id"
  | "classification_status"
>;

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

async function loadVerifiedIdentityCandidates(
  db: QueryableDatabase,
  manufacturerIds: readonly string[] = [],
): Promise<Map<string, CatalogIdentityCandidate[]>> {
  const ids = unique(manufacturerIds.map((value) => value.toLowerCase()));
  if (!ids.length) return new Map<string, CatalogIdentityCandidate[]>();

  const byId = new Map<number, CatalogIdentityCandidate>();
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model,
               kpc.category_id
        FROM knowledge_catalog_products kp
        LEFT JOIN knowledge_catalog_product_categories kpc ON kpc.product_id = kp.id
        WHERE kp.verification_status = 'verified'
          AND kp.manufacturer_id IN (${placeholders})
        ORDER BY kp.id, kpc.is_primary DESC, kpc.category_id
      `)
      .bind(...chunk)
      .all<CatalogIdentityRow>();

    for (const row of result.results || []) {
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
      if (row.category_id && !candidate.categoryIds.includes(row.category_id)) {
        candidate.categoryIds.push(row.category_id);
      }
    }
  }

  const candidateIds = [...byId.keys()];
  for (let i = 0; i < candidateIds.length; i += CHUNK_SIZE) {
    const chunk = candidateIds.slice(i, i + CHUNK_SIZE);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT product_id, alias
        FROM knowledge_catalog_aliases
        WHERE alias_type = 'model' AND product_id IN (${placeholders})
      `)
      .bind(...chunk)
      .all<CatalogAliasRow>();
    for (const row of result.results || []) {
      const candidate = byId.get(Number(row.product_id));
      if (candidate && row.alias && !candidate.aliases.includes(row.alias))
        candidate.aliases.push(row.alias);
    }
  }

  const byManufacturer = new Map<string, CatalogIdentityCandidate[]>();
  for (const candidate of byId.values()) {
    candidate.aliases = unique([
      ...candidate.aliases,
      ...catalogModelLookupVariants({
        manufacturerId: candidate.manufacturerId,
        model: candidate.canonicalModel,
      }),
    ]);
    const manufacturerCandidates = byManufacturer.get(candidate.manufacturerId) ?? [];
    manufacturerCandidates.push(candidate);
    byManufacturer.set(candidate.manufacturerId, manufacturerCandidates);
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
        SELECT id, source_id, canonical_manufacturer_id, model, primary_category_id,
               classification_status
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
): Promise<Map<number, ProductIdentityResolutionRow>> {
  const rows: ProductIdentityResolutionRow[] = [];
  for (let i = 0; i < productIds.length; i += CHUNK_SIZE) {
    const chunk = productIds.slice(i, i + CHUNK_SIZE);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT listing_product_id, catalog_product_id, candidate_catalog_product_id, status,
               match_method, confidence, normalized_model, model_stem, variants_json,
               matched_fields_json, rejected_by_json
        FROM product_identity_resolutions
        WHERE listing_product_id IN (${placeholders})
      `)
      .bind(...chunk)
      .all<ProductIdentityResolutionRow>();
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
  existing: ProductIdentityResolutionRow | undefined,
  next: SerializedResolution,
): boolean {
  return Boolean(
    existing &&
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
    listings.map((row) => row.canonical_manufacturer_id),
  );
  const existing = await loadExistingResolutions(
    db,
    listings.map((row) => Number(row.id)),
  );
  const statements: D1PreparedStatement[] = [];

  for (const listing of listings) {
    const manufacturerId = String(listing.canonical_manufacturer_id || "").toLowerCase();
    const resolution = resolveProductIdentity(
      { ...listing, manufacturer_id: manufacturerId },
      candidatesByManufacturer.get(manufacturerId) || [],
    );
    countMetrics(metrics, resolution);
    const serialized = serializedResolution(resolution);
    if (sameResolution(existing.get(Number(listing.id)), serialized)) continue;

    statements.push(
      db
        .prepare(`
          INSERT INTO product_identity_resolutions(
            listing_product_id, catalog_product_id, candidate_catalog_product_id, status,
            match_method, confidence, normalized_model, model_stem, variants_json,
            matched_fields_json, rejected_by_json, evaluated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
