import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import { retainedCategoryEvidence } from "../catalog/retained-category-evidence.js";
import { summarizeCategoryEvidence } from "../catalog/category-classifier.js";
import { isRecord } from "../types.js";
import { registryVersion } from "./admin-manufacturer-management.js";
import {
  loadCatalogLookupCandidates,
  loadFuzzyCatalogCandidates,
} from "./catalog-lookup-candidates.js";
import { reclassifyAdminCsvListings } from "./knowledge-catalog-repository.js";
import { replayAdminCsvListings } from "./data-quality-remediation-service.js";
import { firstMeasured } from "./read-accounting.js";
import { CATEGORY_VERSION_EXPRESSION } from "./resolution-version-sql.js";
import type { ManufacturerAliasEvidence } from "../catalog/types.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

// This scope owns the fingerprint contract as well as the dependency order. Changing either must
// invalidate saved cursors/receipts, even when the domain's resolver versions remain unchanged.
export const CATALOG_REPLAY_VERSIONS_JSON = JSON.stringify({
  ...RESOLUTION_VERSIONS,
  scope: "catalog-input-v1",
});

interface CatalogReplayListing {
  id: number;
  shop_key: string;
  source_id: string;
  is_active: number;
  canonical_manufacturer_id: string;
  manufacturer: string;
  manufacturer_id: string;
  raw_manufacturer: string;
  raw_category: string;
  model: string;
  normalized_model: string;
  presentation_color: string;
  manufacturer_resolver_version: number;
  model_resolver_version: number;
  category_version: number;
  raw_model: string;
  title: string;
  model_resolution_status: string;
  metadata_json: string;
  category: string;
  primary_category_id: string;
  category_ids: string;
  direct_category_ids: string;
  classification_status: string;
  search_aliases: string;
  remediation_projection_required: number;
  remediation_projection_token: string;
  identity_json: string | null;
  override_json: string | null;
}

export interface CatalogReplaySnapshot {
  listing: CatalogReplayListing;
  fingerprint: string;
  sourceFingerprint: string;
  catalogFingerprint: string;
}

export class CatalogReplayChangedError extends Error {
  constructor() {
    super("catalog_replay_input_changed");
  }
}

/** A bounded ID window, including retained inactive listings; never a filtered whole-table scan. */
export async function scanAdminCatalogReplay(db: ReadableDatabase, afterId: number, maxId: number) {
  const { results } = await db
    .prepare("SELECT id FROM products WHERE id > ? AND id <= ? ORDER BY id LIMIT 25")
    .bind(afterId, maxId)
    .all<{ id: number }>();
  return {
    ids: results.map((row) => row.id),
    scanned: results.length,
    afterId: results.at(-1)?.id ?? afterId,
    complete: results.length < 25 || results.at(-1)?.id === maxId,
  };
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalRows(rows: readonly unknown[]): string[] {
  return [...new Set(rows.map((row) => JSON.stringify(row)))].sort();
}

/** Only identity/category inputs and results participate. Price/stock/observation timestamps do
 * not invalidate an otherwise unchanged catalog decision. Receipts live in the admin DO, so normal
 * ingestion and catalog writers incur no new D1 writes merely to support this optional operation. */
export async function readCatalogReplaySnapshot(
  db: ReadableDatabase,
  id: number,
): Promise<CatalogReplaySnapshot | null> {
  const listing = await firstMeasured<CatalogReplayListing>(
    db
      .prepare(`SELECT p.id,p.shop_key,p.source_id,p.is_active,p.canonical_manufacturer_id,
      p.manufacturer,p.manufacturer_id,p.raw_manufacturer,p.raw_category,
      p.model,p.normalized_model,p.presentation_color,p.manufacturer_resolver_version,p.model_resolver_version,
      ${CATEGORY_VERSION_EXPRESSION} AS category_version,
      p.raw_model,p.title,p.model_resolution_status,
      p.metadata_json,p.category,p.primary_category_id,p.category_ids,p.direct_category_ids,
      p.classification_status,p.search_aliases,p.remediation_projection_required,
      p.remediation_projection_token,
      CASE WHEN r.listing_product_id IS NULL THEN NULL ELSE json_array(r.catalog_product_id,
        r.candidate_catalog_product_id,r.status,r.match_method,r.confidence,r.normalized_model,
        r.model_stem,r.variants_json,r.matched_fields_json,r.rejected_by_json,
        r.identity_resolver_version) END AS identity_json,
      CASE WHEN o.listing_product_id IS NULL THEN NULL ELSE json_array(o.manufacturer_id,
        o.model,o.primary_category_id,o.presentation_color) END AS override_json
      FROM products p
      LEFT JOIN product_identity_resolutions r ON r.listing_product_id=p.id
      LEFT JOIN product_admin_overrides o ON o.listing_product_id=p.id
      WHERE p.id=?`)
      .bind(id),
  );
  if (!listing) return null;
  const input = {
    manufacturerId: listing.canonical_manufacturer_id.toLowerCase(),
    model: listing.model,
  };
  // Share retrieval with the real resolvers, including aliases, category variants, and bounded
  // fuzzy discovery. A new competing candidate or a deleted alias must invalidate the receipt too.
  const candidates = await Promise.all([
    loadCatalogLookupCandidates(db, [input], "identity"),
    loadCatalogLookupCandidates(db, [input], "category"),
    loadFuzzyCatalogCandidates(db, input),
  ]);
  const catalogFingerprint = await fingerprint(
    candidates.map((candidate) => ({
      rows: canonicalRows(candidate.rows),
      aliases: canonicalRows(candidate.aliases),
    })),
  );
  const sourceFingerprint = await fingerprint([
    await registryVersion(db),
    listing.id,
    listing.shop_key,
    listing.source_id,
    listing.is_active,
    listing.raw_manufacturer,
    listing.raw_category,
    listing.raw_model,
    listing.title,
    sourceCategoryEvidence(listing),
    listing.override_json,
  ]);
  return {
    listing,
    sourceFingerprint,
    catalogFingerprint,
    fingerprint: await fingerprint([
      CATALOG_REPLAY_VERSIONS_JSON,
      sourceFingerprint,
      { ...listing, metadata_json: undefined },
      catalogFingerprint,
    ]),
  };
}

function sourceCategoryEvidence(listing: CatalogReplayListing) {
  let metadata: unknown;
  try {
    metadata = JSON.parse(listing.metadata_json);
  } catch {
    metadata = {};
  }
  return summarizeCategoryEvidence(
    retainedCategoryEvidence(
      {
        title: listing.title,
        rawCategory: listing.raw_category,
        hintedCategory: listing.category,
        manufacturer: listing.raw_manufacturer || listing.manufacturer,
      },
      isRecord(metadata) ? metadata : {},
    ),
  );
}

/** Refresh only this listing, then apply verified catalog category authority. Failed or concurrent
 * work receives no receipt; its durable pending ID is retried with fresh evidence. */
export async function applyCatalogReplay(
  db: QueryableDatabase,
  before: CatalogReplaySnapshot,
  aliases: ManufacturerAliasEvidence[],
  evaluatedAt = new Date().toISOString(),
): Promise<CatalogReplaySnapshot> {
  const { listing } = before;
  await replayAdminCsvListings(db, [listing.id], evaluatedAt, aliases, { forceProjection: true });
  await reclassifyAdminCsvListings(db, [listing.id], evaluatedAt);
  const after = await readCatalogReplaySnapshot(db, listing.id);
  if (
    !after ||
    before.sourceFingerprint !== after.sourceFingerprint ||
    before.catalogFingerprint !== after.catalogFingerprint ||
    after.listing.remediation_projection_required
  )
    throw new CatalogReplayChangedError();
  return after;
}
