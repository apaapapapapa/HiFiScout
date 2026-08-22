import { normalizeCatalogModel } from "../catalog/knowledge-catalog.js";
import { manufacturerFilterIds } from "../catalog/manufacturers.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import type {
  KnowledgeCatalogAdminCreateInput,
  KnowledgeCatalogAdminListOptions,
} from "../http/knowledge-catalog-admin.js";
import { reprocessVerifiedCatalogProduct } from "./knowledge-catalog-remediation-repository.js";
import {
  catalogAdminCategoryIds,
  updateKnowledgeCatalogAdminProduct,
  type KnowledgeCatalogAdminProduct,
} from "./knowledge-catalog-admin-repository.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

const MANUAL_REPLAY_PAGE_SIZE = 250;
const MANUAL_REPLAY_MAX_PAGES = 8;

interface CandidateRow {
  id: number;
  manufacturer_id: string;
  normalized_model: string;
  observed_manufacturer: string;
  observed_model: string;
  sample_title: string;
  candidate_category_ids: string;
  active_listing_count: number;
  shop_count: number;
  unclassified_count: number;
  priority_score: number;
  verification_status: string;
  last_verification_at: string | null;
  verification_message: string;
  source_url: string;
  updated_at: string;
}

interface CatalogStateRow {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  normalized_model: string;
  canonical_name: string;
  lifecycle_status: "unknown" | "active" | "discontinued";
  verification_status: string;
  primary_category_id: string | null;
}

export interface KnowledgeCatalogAdminCandidate {
  id: number;
  manufacturerId: string;
  normalizedModel: string;
  observedManufacturer: string;
  observedModel: string;
  sampleTitle: string;
  candidateCategoryIds: string[];
  activeListingCount: number;
  shopCount: number;
  unclassifiedCount: number;
  priorityScore: number;
  verificationStatus: string;
  lastVerificationAt: string | null;
  verificationMessage: string;
  sourceUrl: string;
  updatedAt: string;
}

export interface KnowledgeCatalogAdminCandidateListResult {
  items: KnowledgeCatalogAdminCandidate[];
  nextAfterId: number | null;
  hasMore: boolean;
}

export interface KnowledgeCatalogAdminManualWriteResult {
  product: KnowledgeCatalogAdminProduct;
  created: boolean;
  matchedExisting: boolean;
  refreshedListings: number;
  replayedListings: number;
  newlyMatchedListings: number;
  replayComplete: boolean;
}

export interface KnowledgeCatalogAdminMergeResult {
  product: KnowledgeCatalogAdminProduct;
  targetProductId: number;
  removedProductId: number;
  movedMatchedListings: number;
  refreshedListings: number;
  replayedListings: number;
  replayComplete: boolean;
}

function parseJsonStrings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && Boolean(item))
      : [];
  } catch {
    return [];
  }
}

function toCandidate(row: CandidateRow): KnowledgeCatalogAdminCandidate {
  return {
    id: Number(row.id),
    manufacturerId: row.manufacturer_id,
    normalizedModel: row.normalized_model,
    observedManufacturer: row.observed_manufacturer,
    observedModel: row.observed_model,
    sampleTitle: row.sample_title,
    candidateCategoryIds: parseJsonStrings(row.candidate_category_ids),
    activeListingCount: Number(row.active_listing_count || 0),
    shopCount: Number(row.shop_count || 0),
    unclassifiedCount: Number(row.unclassified_count || 0),
    priorityScore: Number(row.priority_score || 0),
    verificationStatus: row.verification_status,
    lastVerificationAt: row.last_verification_at,
    verificationMessage: row.verification_message || "",
    sourceUrl: row.source_url || "",
    updatedAt: row.updated_at,
  };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‐‑‒–—―－]/g, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function compatibleManufacturerIds(value: string): string[] {
  const raw = normalizeSearchText(value);
  return [...new Set([raw, ...manufacturerFilterIds(value)])].filter(Boolean);
}

export async function listKnowledgeCatalogAdminCandidates(
  db: ReadableDatabase,
  options: KnowledgeCatalogAdminListOptions,
): Promise<KnowledgeCatalogAdminCandidateListResult> {
  const where = ["kc.review_status = 'pending'", "kc.id > ?"];
  const params: unknown[] = [options.afterId];
  if (options.query) {
    const textQuery = normalizeSearchText(options.query);
    const identityQuery = normalizeIdentityModel(options.query).toLowerCase();
    where.push(`(
      INSTR(LOWER(kc.observed_manufacturer), ?) > 0 OR
      INSTR(LOWER(kc.observed_model), ?) > 0 OR
      INSTR(LOWER(kc.sample_title), ?) > 0 OR
      INSTR(LOWER(kc.manufacturer_id), ?) > 0 OR
      kc.manufacturer_id IN (SELECT value FROM json_each(?)) OR
      (? <> '' AND INSTR(
        LOWER(REPLACE(REPLACE(REPLACE(REPLACE(kc.normalized_model, ' ', ''), '-', ''), '_', ''), '.', '')),
        ?
      ) > 0)
    )`);
    params.push(
      textQuery,
      textQuery,
      textQuery,
      textQuery,
      JSON.stringify(compatibleManufacturerIds(options.query)),
      identityQuery,
      identityQuery,
    );
  }
  if (options.manufacturerId) {
    where.push("kc.manufacturer_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(compatibleManufacturerIds(options.manufacturerId)));
  }
  if (options.categoryId) {
    where.push(`EXISTS (
      SELECT 1 FROM json_each(kc.candidate_category_ids) candidate_category
      WHERE candidate_category.value = ?
    )`);
    params.push(options.categoryId);
  }

  const result = await db
    .prepare(`
      SELECT kc.id, kc.manufacturer_id, kc.normalized_model, kc.observed_manufacturer,
             kc.observed_model, kc.sample_title, kc.candidate_category_ids,
             kc.active_listing_count, kc.shop_count, kc.unclassified_count, kc.priority_score,
             kc.verification_status, kc.last_verification_at, kc.verification_message,
             kc.source_url, kc.updated_at
      FROM knowledge_catalog_candidates kc
      WHERE ${where.join(" AND ")}
      ORDER BY kc.id
      LIMIT ?
    `)
    .bind(...params, options.limit + 1)
    .all<CandidateRow>();
  const rows = result.results || [];
  const hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  const items = page.map(toCandidate);
  return {
    items,
    hasMore,
    nextAfterId: hasMore && items.length ? items[items.length - 1].id : null,
  };
}

async function loadCandidate(db: ReadableDatabase, candidateId: number): Promise<CandidateRow | null> {
  return db
    .prepare(`
      SELECT id, manufacturer_id, normalized_model, observed_manufacturer, observed_model,
             sample_title, candidate_category_ids, active_listing_count, shop_count,
             unclassified_count, priority_score, verification_status, last_verification_at,
             verification_message, source_url, updated_at
      FROM knowledge_catalog_candidates
      WHERE id = ? AND review_status = 'pending'
      LIMIT 1
    `)
    .bind(candidateId)
    .first<CandidateRow>();
}

async function loadCatalogState(
  db: ReadableDatabase,
  productId: number,
): Promise<CatalogStateRow | null> {
  return db
    .prepare(`
      SELECT kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model,
             kp.canonical_name, kp.lifecycle_status, kp.verification_status,
             (
               SELECT kpc.category_id
               FROM knowledge_catalog_product_categories kpc
               WHERE kpc.product_id = kp.id AND kpc.is_primary = 1
               LIMIT 1
             ) AS primary_category_id
      FROM knowledge_catalog_products kp
      WHERE kp.id = ?
      LIMIT 1
    `)
    .bind(productId)
    .first<CatalogStateRow>();
}

async function findCatalogStateByIdentity(
  db: ReadableDatabase,
  manufacturerId: string,
  normalizedModel: string,
): Promise<CatalogStateRow | null> {
  return db
    .prepare(`
      SELECT kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model,
             kp.canonical_name, kp.lifecycle_status, kp.verification_status,
             (
               SELECT kpc.category_id
               FROM knowledge_catalog_product_categories kpc
               WHERE kpc.product_id = kp.id AND kpc.is_primary = 1
               LIMIT 1
             ) AS primary_category_id
      FROM knowledge_catalog_products kp
      WHERE kp.manufacturer_id = ? AND kp.normalized_model = ?
      LIMIT 1
    `)
    .bind(manufacturerId, normalizedModel)
    .first<CatalogStateRow>();
}

function modelAliasStatement(
  db: QueryableDatabase,
  productId: number,
  alias: string,
  createdAt: string,
): D1PreparedStatement | null {
  const text = alias.normalize("NFKC").trim();
  const normalized = normalizeCatalogModel(text);
  if (!text || !normalized) return null;
  return db
    .prepare(`
      INSERT OR IGNORE INTO knowledge_catalog_aliases(
        product_id, alias, normalized_alias, alias_type, created_at
      ) VALUES (?, ?, ?, 'model', ?)
    `)
    .bind(productId, text, normalized, createdAt);
}

function nameAliasStatement(
  db: QueryableDatabase,
  productId: number,
  alias: string,
  createdAt: string,
): D1PreparedStatement | null {
  const text = alias.normalize("NFKC").trim();
  if (!text) return null;
  return db
    .prepare(`
      INSERT OR IGNORE INTO knowledge_catalog_aliases(
        product_id, alias, normalized_alias, alias_type, created_at
      ) VALUES (?, ?, ?, 'name', ?)
    `)
    .bind(productId, text, normalizeSearchText(text), createdAt);
}

async function recordManualSource(
  db: QueryableDatabase,
  productId: number,
  sourceUrl: string,
  verifiedAt: string,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO knowledge_catalog_sources(
        product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
      ) VALUES (?, 'manual_verified', ?, ?, '', 'active', ?, ?)
      ON CONFLICT(product_id, source_type, source_url) DO UPDATE SET
        retrieved_at = excluded.retrieved_at,
        status = 'active',
        updated_at = excluded.updated_at
    `)
    .bind(productId, sourceUrl, verifiedAt, verifiedAt, verifiedAt)
    .run();
}

async function replayManualCatalogProduct(
  db: QueryableDatabase,
  productId: number,
  evaluatedAt: string,
): Promise<{ processedCount: number; matchedCount: number; complete: boolean }> {
  let afterId = 0;
  let processedCount = 0;
  let matchedCount = 0;
  let complete = false;
  for (let page = 0; page < MANUAL_REPLAY_MAX_PAGES; page += 1) {
    const result = await reprocessVerifiedCatalogProduct(db, productId, {
      afterId,
      limit: MANUAL_REPLAY_PAGE_SIZE,
      evaluatedAt,
    });
    if (!result.target || !result.replay) break;
    processedCount += result.replay.processedCount;
    matchedCount += result.replay.matchedCount;
    if (!result.replay.hasMore || result.replay.nextAfterId === null) {
      complete = true;
      break;
    }
    afterId = result.replay.nextAfterId;
  }
  if (complete) {
    await db
      .prepare(`
        UPDATE knowledge_catalog_products
        SET last_remediated_at = ?, remediation_after_listing_id = 0, updated_at = ?
        WHERE id = ? AND verification_status = 'verified'
      `)
      .bind(evaluatedAt, evaluatedAt, productId)
      .run();
  }
  return { processedCount, matchedCount, complete };
}

async function insertNewCatalogProduct(
  db: QueryableDatabase,
  input: KnowledgeCatalogAdminCreateInput,
  normalizedModel: string,
  verifiedAt: string,
): Promise<number> {
  const result = await db
    .prepare(`
      INSERT INTO knowledge_catalog_products(
        manufacturer_id, canonical_model, normalized_model, canonical_name, lifecycle_status,
        verification_status, review_status, first_verified_at, last_verified_at, last_reviewed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'verified', 'current', ?, ?, ?, ?, ?)
    `)
    .bind(
      input.manufacturerId,
      input.canonicalModel,
      normalizedModel,
      input.canonicalName,
      input.lifecycleStatus,
      verifiedAt,
      verifiedAt,
      verifiedAt,
      verifiedAt,
      verifiedAt,
    )
    .run();
  const productId = Number(result?.meta?.last_row_id || 0);
  if (!productId) throw new Error("catalog_admin_product_insert_failed");
  return productId;
}

async function reviveRejectedCatalogProduct(
  db: QueryableDatabase,
  productId: number,
  input: KnowledgeCatalogAdminCreateInput,
  verifiedAt: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE knowledge_catalog_products
      SET canonical_model = ?, canonical_name = ?, lifecycle_status = ?, verification_status = 'verified',
          review_status = 'current', first_verified_at = COALESCE(first_verified_at, ?),
          last_verified_at = ?, last_reviewed_at = ?, remediation_after_listing_id = 0, updated_at = ?
      WHERE id = ? AND verification_status = 'rejected'
    `)
    .bind(
      input.canonicalModel,
      input.canonicalName,
      input.lifecycleStatus,
      verifiedAt,
      verifiedAt,
      verifiedAt,
      verifiedAt,
      productId,
    )
    .run();
}

async function linkCandidateToManualProduct(
  db: QueryableDatabase,
  candidate: CandidateRow,
  productId: number,
  input: KnowledgeCatalogAdminCreateInput,
  normalizedModel: string,
  verifiedAt: string,
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`
        UPDATE knowledge_catalog_candidates
        SET review_status = 'matched', catalog_product_id = ?, verification_status = 'verified',
            last_verification_at = ?, verification_message = 'manual_admin_verification',
            source_url = ?, updated_at = ?
        WHERE id = ? AND review_status = 'pending'
      `)
      .bind(productId, verifiedAt, input.sourceUrl, verifiedAt, candidate.id),
    db
      .prepare(`
        INSERT INTO knowledge_catalog_verification_attempts(
          candidate_id, product_id, manufacturer_id, normalized_model, source_type, source_url,
          attempted_at, status, http_status, content_hash, message
        ) VALUES (?, ?, ?, ?, 'manual_verified', ?, ?, 'verified', NULL, '', 'manual_admin_verification')
      `)
      .bind(
        candidate.id,
        productId,
        candidate.manufacturer_id,
        candidate.normalized_model || normalizedModel,
        input.sourceUrl,
        verifiedAt,
      ),
  ];
  for (const alias of [candidate.observed_model, input.canonicalModel]) {
    const statement = modelAliasStatement(db, productId, alias, verifiedAt);
    if (statement) statements.push(statement);
  }
  await db.batch(statements);
}

async function completeManualWrite(
  db: QueryableDatabase,
  productId: number,
  updateInput: Pick<
    KnowledgeCatalogAdminCreateInput,
    "canonicalName" | "lifecycleStatus" | "primaryCategoryId"
  >,
  verifiedAt: string,
): Promise<{
  product: KnowledgeCatalogAdminProduct;
  refreshedListings: number;
  replayedListings: number;
  newlyMatchedListings: number;
  replayComplete: boolean;
}> {
  const before = await updateKnowledgeCatalogAdminProduct(db, productId, updateInput, verifiedAt);
  if (!before) throw new Error("catalog_admin_product_missing_after_manual_write");
  const replay = await replayManualCatalogProduct(db, productId, verifiedAt);
  const after = await updateKnowledgeCatalogAdminProduct(db, productId, updateInput, verifiedAt);
  if (!after) throw new Error("catalog_admin_product_missing_after_manual_replay");
  if (replay.complete) {
    await db
      .prepare(`
        UPDATE knowledge_catalog_products
        SET last_remediated_at = ?, remediation_after_listing_id = 0
        WHERE id = ? AND last_verified_at = ?
      `)
      .bind(verifiedAt, productId, verifiedAt)
      .run();
  }
  return {
    product: after.product,
    refreshedListings: after.refreshedListings,
    replayedListings: replay.processedCount,
    newlyMatchedListings: replay.matchedCount,
    replayComplete: replay.complete,
  };
}

export async function createKnowledgeCatalogAdminProduct(
  db: QueryableDatabase,
  input: KnowledgeCatalogAdminCreateInput,
  verifiedAt = new Date().toISOString(),
): Promise<KnowledgeCatalogAdminManualWriteResult> {
  const normalizedModel = normalizeCatalogModel(input.canonicalModel);
  const categoryIds = catalogAdminCategoryIds(input.primaryCategoryId);
  if (!normalizedModel) throw new Error("catalog_admin_model_invalid");
  if (!categoryIds.length || categoryIds[0] !== input.primaryCategoryId) {
    throw new Error("catalog_admin_category_invalid");
  }
  const existing = await findCatalogStateByIdentity(db, input.manufacturerId, normalizedModel);
  if (existing?.verification_status === "verified") {
    throw new Error(`catalog_admin_product_already_exists:${existing.id}`);
  }

  const productId = existing
    ? Number(existing.id)
    : await insertNewCatalogProduct(db, input, normalizedModel, verifiedAt);
  if (existing) await reviveRejectedCatalogProduct(db, productId, input, verifiedAt);

  const canonicalAlias = modelAliasStatement(db, productId, input.canonicalModel, verifiedAt);
  if (canonicalAlias) await db.batch([canonicalAlias]);
  await recordManualSource(db, productId, input.sourceUrl, verifiedAt);
  const completed = await completeManualWrite(db, productId, input, verifiedAt);
  return {
    ...completed,
    created: !existing,
    matchedExisting: false,
  };
}

export async function verifyKnowledgeCatalogAdminCandidate(
  db: QueryableDatabase,
  candidateId: number,
  input: KnowledgeCatalogAdminCreateInput,
  verifiedAt = new Date().toISOString(),
): Promise<KnowledgeCatalogAdminManualWriteResult | null> {
  const candidate = await loadCandidate(db, candidateId);
  if (!candidate) return null;
  const normalizedModel = normalizeCatalogModel(input.canonicalModel);
  if (!normalizedModel) throw new Error("catalog_admin_model_invalid");
  const existing = await findCatalogStateByIdentity(db, input.manufacturerId, normalizedModel);

  let productId: number;
  let created = false;
  let matchedExisting = false;
  let effectiveInput = input;
  if (existing?.verification_status === "verified") {
    productId = Number(existing.id);
    matchedExisting = true;
    effectiveInput = {
      ...input,
      canonicalName: existing.canonical_name,
      lifecycleStatus: existing.lifecycle_status,
      primaryCategoryId: existing.primary_category_id || input.primaryCategoryId,
    };
  } else if (existing) {
    productId = Number(existing.id);
    await reviveRejectedCatalogProduct(db, productId, input, verifiedAt);
  } else {
    productId = await insertNewCatalogProduct(db, input, normalizedModel, verifiedAt);
    created = true;
  }

  await linkCandidateToManualProduct(db, candidate, productId, input, normalizedModel, verifiedAt);
  await recordManualSource(db, productId, input.sourceUrl, verifiedAt);
  const completed = await completeManualWrite(db, productId, effectiveInput, verifiedAt);
  return { ...completed, created, matchedExisting };
}

function sameManufacturer(left: string, right: string): boolean {
  const leftIds = new Set(manufacturerFilterIds(left));
  const rightIds = manufacturerFilterIds(right);
  return left === right || rightIds.some((id) => leftIds.has(id));
}

export async function mergeKnowledgeCatalogAdminProducts(
  db: QueryableDatabase,
  targetProductId: number,
  sourceProductId: number,
  mergedAt = new Date().toISOString(),
): Promise<KnowledgeCatalogAdminMergeResult | null> {
  if (targetProductId === sourceProductId) throw new Error("catalog_admin_merge_same_product");
  const [target, source] = await Promise.all([
    loadCatalogState(db, targetProductId),
    loadCatalogState(db, sourceProductId),
  ]);
  if (!target || !source || target.verification_status !== "verified" || source.verification_status !== "verified") {
    return null;
  }
  if (!target.primary_category_id) throw new Error("catalog_admin_merge_target_category_missing");
  if (!sameManufacturer(target.manufacturer_id, source.manufacturer_id)) {
    throw new Error("catalog_admin_merge_manufacturer_mismatch");
  }

  const moved = await db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM product_identity_resolutions pir
      JOIN products p ON p.id = pir.listing_product_id
      WHERE p.is_active = 1 AND pir.status = 'matched' AND pir.catalog_product_id = ?
    `)
    .bind(sourceProductId)
    .first<{ count: number }>();

  const statements: D1PreparedStatement[] = [];
  const canonicalModelAlias = modelAliasStatement(db, targetProductId, source.canonical_model, mergedAt);
  if (canonicalModelAlias) statements.push(canonicalModelAlias);
  const canonicalNameAlias = nameAliasStatement(db, targetProductId, source.canonical_name, mergedAt);
  if (canonicalNameAlias) statements.push(canonicalNameAlias);
  statements.push(
    db
      .prepare(`
        INSERT OR IGNORE INTO knowledge_catalog_aliases(product_id, alias, normalized_alias, alias_type, created_at)
        SELECT ?, alias, normalized_alias, alias_type, created_at
        FROM knowledge_catalog_aliases
        WHERE product_id = ?
      `)
      .bind(targetProductId, sourceProductId),
    db
      .prepare(`
        INSERT OR IGNORE INTO knowledge_catalog_sources(
          product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
        )
        SELECT ?, source_type, source_url, retrieved_at, content_hash, status, created_at, ?
        FROM knowledge_catalog_sources
        WHERE product_id = ?
      `)
      .bind(targetProductId, mergedAt, sourceProductId),
    db
      .prepare(`
        UPDATE knowledge_catalog_candidates
        SET catalog_product_id = ?, updated_at = ?
        WHERE catalog_product_id = ?
      `)
      .bind(targetProductId, mergedAt, sourceProductId),
    db
      .prepare(`
        UPDATE knowledge_catalog_verification_attempts
        SET product_id = ?
        WHERE product_id = ?
      `)
      .bind(targetProductId, sourceProductId),
    db
      .prepare(`
        UPDATE product_identity_resolutions
        SET catalog_product_id = CASE WHEN catalog_product_id = ? THEN ? ELSE catalog_product_id END,
            candidate_catalog_product_id = CASE
              WHEN candidate_catalog_product_id = ? THEN ? ELSE candidate_catalog_product_id END,
            evaluated_at = ?
        WHERE catalog_product_id = ? OR candidate_catalog_product_id = ?
      `)
      .bind(
        sourceProductId,
        targetProductId,
        sourceProductId,
        targetProductId,
        mergedAt,
        sourceProductId,
        sourceProductId,
      ),
    db.prepare("DELETE FROM knowledge_catalog_products WHERE id = ?").bind(sourceProductId),
  );
  await db.batch(statements);

  await recordManualSource(db, targetProductId, "", mergedAt);
  const completed = await completeManualWrite(
    db,
    targetProductId,
    {
      canonicalName: target.canonical_name,
      lifecycleStatus: target.lifecycle_status,
      primaryCategoryId: target.primary_category_id,
    },
    mergedAt,
  );
  return {
    product: completed.product,
    targetProductId,
    removedProductId: sourceProductId,
    movedMatchedListings: Number(moved?.count || 0),
    refreshedListings: completed.refreshedListings,
    replayedListings: completed.replayedListings,
    replayComplete: completed.replayComplete,
  };
}
