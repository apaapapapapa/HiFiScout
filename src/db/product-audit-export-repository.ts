import type { ReadableDatabase } from "./types.js";
import type { ProductAuditExportScope } from "../product-audit-export/types.js";

export type { ProductAuditExportScope } from "../product-audit-export/types.js";

const MAX_PAGE_SIZE = 250;
const SQL_IDENTIFIER_CHARACTER_LIMIT = 256;
const SQL_TEXT_CHARACTER_LIMIT = 1_024;
const SQL_EVIDENCE_CHARACTER_LIMIT = 2_048;
const SQL_URL_CHARACTER_LIMIT = 2_048;
const SQL_TIMESTAMP_CHARACTER_LIMIT = 128;
const SQL_TRUNCATION_MARKER = " [truncated]";

/** Bounds export-only projections without changing the seller evidence stored in D1. */
function boundedSqlText(expression: string, limit = SQL_TEXT_CHARACTER_LIMIT): string {
  const prefixLimit = Math.max(0, limit - SQL_TRUNCATION_MARKER.length);
  return `CASE
    WHEN instr(${expression}, char(0)) > 0
      THEN substr(${expression}, 1, MIN(instr(${expression}, char(0)) - 1, ${prefixLimit})) || '${SQL_TRUNCATION_MARKER}'
    WHEN length(${expression}) > ${limit}
      THEN substr(${expression}, 1, ${prefixLimit}) || '${SQL_TRUNCATION_MARKER}'
    ELSE ${expression}
  END`;
}

export interface ProductAuditExportOptions {
  scope: ProductAuditExportScope;
  afterId: number;
  /** Inclusive ID horizon captured when an asynchronous export job starts. */
  maxId: number;
  limit: number;
}

export interface ProductAuditExportRow {
  listingId: number;
  shopKey: string;
  sourceId: string;
  sourceUrl: string;
  isActive: number;
  stockStatus: string;
  priceYen: number | null;
  conditionText: string;
  title: string;
  rawManufacturer: string;
  manufacturer: string;
  manufacturerId: string;
  canonicalManufacturerId: string;
  manufacturerResolutionStatus: string;
  manufacturerResolutionMethod: string;
  manufacturerResolutionConfidence: string;
  rawModel: string;
  model: string;
  normalizedModel: string;
  modelResolutionStatus: string;
  modelResolutionMethod: string;
  modelResolutionConfidence: string;
  rawCategory: string;
  category: string;
  primaryCategoryId: string;
  categoryIds: string;
  classificationStatus: string;
  searchEntityKey: string;
  searchEntityKind: string;
  searchEntityPrimaryCategoryId: string;
  searchEntityOfferCount: number | null;
  searchEntityShopCount: number | null;
  identityStatus: string;
  identityMatchMethod: string;
  identityConfidence: string;
  identityCatalogProductId: number | null;
  identityCandidateCatalogProductId: number | null;
  catalogCanonicalName: string;
  catalogCanonicalModel: string;
  catalogPrimaryCategoryId: string;
  candidateCatalogCanonicalName: string;
  candidateCatalogCanonicalModel: string;
  candidateCatalogPrimaryCategoryId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  lastActivityAt: string;
  sourcePublishedAt: string;
}

export interface ProductAuditExportPage {
  items: ProductAuditExportRow[];
  nextAfterId: number | null;
}

interface ProductAuditExportDbRow {
  listing_id: number;
  shop_key: string;
  source_id: string;
  source_url: string;
  is_active: number;
  stock_status: string;
  price_yen: number | null;
  condition_text: string;
  title: string;
  raw_manufacturer: string;
  manufacturer: string;
  manufacturer_id: string;
  canonical_manufacturer_id: string;
  manufacturer_resolution_status: string;
  manufacturer_resolution_method: string;
  manufacturer_resolution_confidence: string;
  raw_model: string;
  model: string;
  normalized_model: string;
  model_resolution_status: string;
  model_resolution_method: string;
  model_resolution_confidence: string;
  raw_category: string;
  category: string;
  primary_category_id: string;
  category_ids: string;
  classification_status: string;
  search_entity_key: string | null;
  search_entity_kind: string | null;
  search_entity_primary_category_id: string | null;
  search_entity_offer_count: number | null;
  search_entity_shop_count: number | null;
  identity_status: string | null;
  identity_match_method: string | null;
  identity_confidence: string | null;
  identity_catalog_product_id: number | null;
  identity_candidate_catalog_product_id: number | null;
  catalog_canonical_name: string | null;
  catalog_canonical_model: string | null;
  catalog_primary_category_id: string | null;
  candidate_catalog_canonical_name: string | null;
  candidate_catalog_canonical_model: string | null;
  candidate_catalog_primary_category_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_changed_at: string;
  last_activity_at: string | null;
  source_published_at: string | null;
}

function text(value: string | null | undefined): string {
  return value || "";
}

function toExportRow(row: ProductAuditExportDbRow): ProductAuditExportRow {
  return {
    listingId: Number(row.listing_id),
    shopKey: row.shop_key,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    isActive: Number(row.is_active),
    stockStatus: row.stock_status,
    priceYen: row.price_yen == null ? null : Number(row.price_yen),
    conditionText: row.condition_text,
    title: row.title,
    rawManufacturer: row.raw_manufacturer,
    manufacturer: row.manufacturer,
    manufacturerId: row.manufacturer_id,
    canonicalManufacturerId: row.canonical_manufacturer_id,
    manufacturerResolutionStatus: row.manufacturer_resolution_status,
    manufacturerResolutionMethod: row.manufacturer_resolution_method,
    manufacturerResolutionConfidence: row.manufacturer_resolution_confidence,
    rawModel: row.raw_model,
    model: row.model,
    normalizedModel: row.normalized_model,
    modelResolutionStatus: row.model_resolution_status,
    modelResolutionMethod: row.model_resolution_method,
    modelResolutionConfidence: row.model_resolution_confidence,
    rawCategory: row.raw_category,
    category: row.category,
    primaryCategoryId: row.primary_category_id,
    categoryIds: row.category_ids,
    classificationStatus: row.classification_status,
    searchEntityKey: text(row.search_entity_key),
    searchEntityKind: text(row.search_entity_kind),
    searchEntityPrimaryCategoryId: text(row.search_entity_primary_category_id),
    searchEntityOfferCount:
      row.search_entity_offer_count == null ? null : Number(row.search_entity_offer_count),
    searchEntityShopCount:
      row.search_entity_shop_count == null ? null : Number(row.search_entity_shop_count),
    identityStatus: text(row.identity_status),
    identityMatchMethod: text(row.identity_match_method),
    identityConfidence: text(row.identity_confidence),
    identityCatalogProductId:
      row.identity_catalog_product_id == null ? null : Number(row.identity_catalog_product_id),
    identityCandidateCatalogProductId:
      row.identity_candidate_catalog_product_id == null
        ? null
        : Number(row.identity_candidate_catalog_product_id),
    catalogCanonicalName: text(row.catalog_canonical_name),
    catalogCanonicalModel: text(row.catalog_canonical_model),
    catalogPrimaryCategoryId: text(row.catalog_primary_category_id),
    candidateCatalogCanonicalName: text(row.candidate_catalog_canonical_name),
    candidateCatalogCanonicalModel: text(row.candidate_catalog_canonical_model),
    candidateCatalogPrimaryCategoryId: text(row.candidate_catalog_primary_category_id),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastChangedAt: row.last_changed_at,
    lastActivityAt: text(row.last_activity_at),
    sourcePublishedAt: text(row.source_published_at),
  };
}

/**
 * Returns a bounded page of listing-level facts for an external/AI data-quality review.
 *
 * The export intentionally includes both seller evidence and derived/canonical fields. That lets a
 * reviewer spot cases such as two spellings of one product landing in separate search entities, or
 * a seller title disagreeing with the assigned category, without exposing the much larger internal
 * metadata/evidence blobs.
 */
export async function listProductAuditExportPage(
  db: ReadableDatabase,
  options: ProductAuditExportOptions,
): Promise<ProductAuditExportPage> {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(options.limit) || 1));
  const afterId = Math.max(0, Number(options.afterId) || 0);
  const maxId = Math.max(0, Number.isSafeInteger(options.maxId) ? Number(options.maxId) : 0);
  const activeClause = options.scope === "active" ? "AND p.is_active = 1" : "";
  const result = await db
    .prepare(`
      SELECT
        p.id AS listing_id,
        ${boundedSqlText("p.shop_key", SQL_IDENTIFIER_CHARACTER_LIMIT)} AS shop_key,
        ${boundedSqlText("p.source_id")} AS source_id,
        ${boundedSqlText("p.source_url", SQL_URL_CHARACTER_LIMIT)} AS source_url,
        p.is_active,
        ${boundedSqlText("p.stock_status", 128)} AS stock_status,
        p.price_yen,
        ${boundedSqlText("p.condition_text", SQL_EVIDENCE_CHARACTER_LIMIT)} AS condition_text,
        ${boundedSqlText("p.title", SQL_EVIDENCE_CHARACTER_LIMIT)} AS title,
        ${boundedSqlText("p.raw_manufacturer")} AS raw_manufacturer,
        ${boundedSqlText("p.manufacturer")} AS manufacturer,
        ${boundedSqlText("p.manufacturer_id", SQL_IDENTIFIER_CHARACTER_LIMIT)} AS manufacturer_id,
        ${boundedSqlText("p.canonical_manufacturer_id", SQL_IDENTIFIER_CHARACTER_LIMIT)} AS canonical_manufacturer_id,
        ${boundedSqlText("p.manufacturer_resolution_status", 128)} AS manufacturer_resolution_status,
        ${boundedSqlText("p.manufacturer_resolution_method", 128)} AS manufacturer_resolution_method,
        ${boundedSqlText("p.manufacturer_resolution_confidence", 128)} AS manufacturer_resolution_confidence,
        ${boundedSqlText("p.raw_model", SQL_EVIDENCE_CHARACTER_LIMIT)} AS raw_model,
        ${boundedSqlText("p.model")} AS model,
        ${boundedSqlText("p.normalized_model")} AS normalized_model,
        ${boundedSqlText("p.model_resolution_status", 128)} AS model_resolution_status,
        ${boundedSqlText("p.model_resolution_method", 128)} AS model_resolution_method,
        ${boundedSqlText("p.model_resolution_confidence", 128)} AS model_resolution_confidence,
        ${boundedSqlText("p.raw_category", SQL_EVIDENCE_CHARACTER_LIMIT)} AS raw_category,
        ${boundedSqlText("p.category")} AS category,
        ${boundedSqlText("p.primary_category_id", SQL_IDENTIFIER_CHARACTER_LIMIT)} AS primary_category_id,
        ${boundedSqlText("p.category_ids", SQL_EVIDENCE_CHARACTER_LIMIT)} AS category_ids,
        ${boundedSqlText("p.classification_status", 128)} AS classification_status,
        ${boundedSqlText("e.entity_key")} AS search_entity_key,
        ${boundedSqlText("e.entity_kind", 128)} AS search_entity_kind,
        ${boundedSqlText("e.primary_category_id", SQL_IDENTIFIER_CHARACTER_LIMIT)} AS search_entity_primary_category_id,
        e.offer_count AS search_entity_offer_count,
        e.shop_count AS search_entity_shop_count,
        ${boundedSqlText("r.status", 128)} AS identity_status,
        ${boundedSqlText("r.match_method", 128)} AS identity_match_method,
        ${boundedSqlText("r.confidence", 128)} AS identity_confidence,
        r.catalog_product_id AS identity_catalog_product_id,
        r.candidate_catalog_product_id AS identity_candidate_catalog_product_id,
        ${boundedSqlText("kp.canonical_name")} AS catalog_canonical_name,
        ${boundedSqlText("kp.canonical_model")} AS catalog_canonical_model,
        (
          SELECT ${boundedSqlText("kpc.category_id", SQL_IDENTIFIER_CHARACTER_LIMIT)}
          FROM knowledge_catalog_product_categories kpc
          WHERE kpc.product_id = kp.id AND kpc.is_primary = 1
          LIMIT 1
        ) AS catalog_primary_category_id,
        ${boundedSqlText("candidate_kp.canonical_name")} AS candidate_catalog_canonical_name,
        ${boundedSqlText("candidate_kp.canonical_model")} AS candidate_catalog_canonical_model,
        (
          SELECT ${boundedSqlText("candidate_kpc.category_id", SQL_IDENTIFIER_CHARACTER_LIMIT)}
          FROM knowledge_catalog_product_categories candidate_kpc
          WHERE candidate_kpc.product_id = candidate_kp.id AND candidate_kpc.is_primary = 1
          LIMIT 1
        ) AS candidate_catalog_primary_category_id,
        ${boundedSqlText("p.first_seen_at", SQL_TIMESTAMP_CHARACTER_LIMIT)} AS first_seen_at,
        ${boundedSqlText("p.last_seen_at", SQL_TIMESTAMP_CHARACTER_LIMIT)} AS last_seen_at,
        ${boundedSqlText("p.last_changed_at", SQL_TIMESTAMP_CHARACTER_LIMIT)} AS last_changed_at,
        ${boundedSqlText("p.last_activity_at", SQL_TIMESTAMP_CHARACTER_LIMIT)} AS last_activity_at,
        ${boundedSqlText("p.source_published_at", SQL_TIMESTAMP_CHARACTER_LIMIT)} AS source_published_at
      FROM products p
      LEFT JOIN product_search_entity_offers membership
        ON membership.listing_product_id = p.id
      LEFT JOIN product_search_entities e ON e.id = membership.entity_id
      LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
      LEFT JOIN knowledge_catalog_products kp ON kp.id = r.catalog_product_id
      LEFT JOIN knowledge_catalog_products candidate_kp
        ON candidate_kp.id = r.candidate_catalog_product_id
      WHERE p.id > ?
        AND p.id <= ?
        ${activeClause}
      ORDER BY p.id
      LIMIT ?
    `)
    .bind(afterId, maxId, limit + 1)
    .all<ProductAuditExportDbRow>();

  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = page.map(toExportRow);
  return {
    items,
    nextAfterId: hasMore && items.length ? items[items.length - 1].listingId : null,
  };
}
