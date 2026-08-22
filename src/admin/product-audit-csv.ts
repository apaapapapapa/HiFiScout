import type { CatalogAdminProductExportRow } from "./contracts.js";

interface CsvColumn {
  header: string;
  value: (row: CatalogAdminProductExportRow) => string | number | null;
}

const COLUMNS: readonly CsvColumn[] = [
  { header: "listing_id", value: (row) => row.listingId },
  { header: "shop_key", value: (row) => row.shopKey },
  { header: "source_id", value: (row) => row.sourceId },
  { header: "source_url", value: (row) => row.sourceUrl },
  { header: "is_active", value: (row) => row.isActive },
  { header: "stock_status", value: (row) => row.stockStatus },
  { header: "price_yen", value: (row) => row.priceYen },
  { header: "condition_text", value: (row) => row.conditionText },
  { header: "title", value: (row) => row.title },
  { header: "raw_manufacturer", value: (row) => row.rawManufacturer },
  { header: "manufacturer", value: (row) => row.manufacturer },
  { header: "manufacturer_id", value: (row) => row.manufacturerId },
  { header: "canonical_manufacturer_id", value: (row) => row.canonicalManufacturerId },
  {
    header: "manufacturer_resolution_status",
    value: (row) => row.manufacturerResolutionStatus,
  },
  {
    header: "manufacturer_resolution_method",
    value: (row) => row.manufacturerResolutionMethod,
  },
  {
    header: "manufacturer_resolution_confidence",
    value: (row) => row.manufacturerResolutionConfidence,
  },
  { header: "raw_model", value: (row) => row.rawModel },
  { header: "model", value: (row) => row.model },
  { header: "normalized_model", value: (row) => row.normalizedModel },
  { header: "model_resolution_status", value: (row) => row.modelResolutionStatus },
  { header: "model_resolution_method", value: (row) => row.modelResolutionMethod },
  {
    header: "model_resolution_confidence",
    value: (row) => row.modelResolutionConfidence,
  },
  { header: "raw_category", value: (row) => row.rawCategory },
  { header: "category", value: (row) => row.category },
  { header: "primary_category_id", value: (row) => row.primaryCategoryId },
  { header: "category_ids", value: (row) => row.categoryIds },
  { header: "classification_status", value: (row) => row.classificationStatus },
  { header: "search_entity_key", value: (row) => row.searchEntityKey },
  { header: "search_entity_kind", value: (row) => row.searchEntityKind },
  {
    header: "search_entity_primary_category_id",
    value: (row) => row.searchEntityPrimaryCategoryId,
  },
  { header: "search_entity_offer_count", value: (row) => row.searchEntityOfferCount },
  { header: "search_entity_shop_count", value: (row) => row.searchEntityShopCount },
  { header: "identity_status", value: (row) => row.identityStatus },
  { header: "identity_match_method", value: (row) => row.identityMatchMethod },
  { header: "identity_confidence", value: (row) => row.identityConfidence },
  { header: "identity_catalog_product_id", value: (row) => row.identityCatalogProductId },
  {
    header: "identity_candidate_catalog_product_id",
    value: (row) => row.identityCandidateCatalogProductId,
  },
  { header: "catalog_canonical_name", value: (row) => row.catalogCanonicalName },
  { header: "catalog_canonical_model", value: (row) => row.catalogCanonicalModel },
  { header: "catalog_primary_category_id", value: (row) => row.catalogPrimaryCategoryId },
  {
    header: "candidate_catalog_canonical_name",
    value: (row) => row.candidateCatalogCanonicalName,
  },
  {
    header: "candidate_catalog_canonical_model",
    value: (row) => row.candidateCatalogCanonicalModel,
  },
  {
    header: "candidate_catalog_primary_category_id",
    value: (row) => row.candidateCatalogPrimaryCategoryId,
  },
  { header: "first_seen_at", value: (row) => row.firstSeenAt },
  { header: "last_seen_at", value: (row) => row.lastSeenAt },
  { header: "last_changed_at", value: (row) => row.lastChangedAt },
  { header: "last_activity_at", value: (row) => row.lastActivityAt },
  { header: "source_published_at", value: (row) => row.sourcePublishedAt },
];

/**
 * Neutralise spreadsheet formula prefixes while preserving the seller text for human/AI review.
 * CSV quoting alone does not stop Excel-compatible applications from evaluating formula cells.
 */
function spreadsheetSafe(value: string): string {
  return /^[=+\-@]/u.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const safe = spreadsheetSafe(value);
  return `"${safe.replaceAll('"', '""')}"`;
}

export function productAuditCsvHeader(): string {
  return COLUMNS.map((column) => column.header).join(",");
}

export function productAuditCsvRow(row: CatalogAdminProductExportRow): string {
  return COLUMNS.map((column) => csvCell(column.value(row))).join(",");
}

/** UTF-8 BOM keeps Japanese seller titles readable when the CSV is opened directly in Excel. */
export const PRODUCT_AUDIT_CSV_BOM = "\uFEFF";
