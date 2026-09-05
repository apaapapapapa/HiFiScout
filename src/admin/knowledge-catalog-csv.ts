import type { KnowledgeCatalogExportRow } from "../db/knowledge-catalog-export-repository.js";
import {
  adminCsvEditHeader,
  adminCsvEditRow,
  adminCsvOriginal,
} from "../api/admin-csv-contracts.js";

interface CsvColumn {
  header: string;
  value: (row: KnowledgeCatalogExportRow) => string | number | null;
}

const MAX_CSV_CELL_SOURCE_CHARACTERS = 4_096;
const MAX_CSV_JSON_CELL_SOURCE_CHARACTERS = 16_384;
const MAX_CSV_ROW_SOURCE_CHARACTERS = 32_768;
const CSV_TRUNCATION_MARKER = " [truncated]";
const TRUNCATED_FIELDS_HEADER = "csv_fields_truncated";

const COLUMNS: readonly CsvColumn[] = [
  { header: "catalog_product_id", value: (row) => row.catalogProductId },
  { header: "manufacturer_id", value: (row) => row.manufacturerId },
  { header: "manufacturer_canonical_name", value: (row) => row.manufacturerCanonicalName },
  {
    header: "manufacturer_verification_status",
    value: (row) => row.manufacturerVerificationStatus,
  },
  { header: "manufacturer_source", value: (row) => row.manufacturerSource },
  { header: "manufacturer_provenance_json", value: (row) => row.manufacturerProvenanceJson },
  { header: "canonical_model", value: (row) => row.canonicalModel },
  { header: "normalized_model", value: (row) => row.normalizedModel },
  { header: "canonical_name", value: (row) => row.canonicalName },
  { header: "lifecycle_status", value: (row) => row.lifecycleStatus },
  { header: "verification_status", value: (row) => row.verificationStatus },
  { header: "review_status", value: (row) => row.reviewStatus },
  { header: "primary_category_id", value: (row) => row.primaryCategoryId },
  { header: "categories_json", value: (row) => row.categoriesJson },
  { header: "category_count_capped", value: (row) => row.categoryCount },
  { header: "categories_truncated", value: (row) => row.categoriesTruncated },
  { header: "aliases_json", value: (row) => row.aliasesJson },
  { header: "alias_count_capped", value: (row) => row.aliasCount },
  { header: "aliases_truncated", value: (row) => row.aliasesTruncated },
  { header: "sources_json", value: (row) => row.sourcesJson },
  { header: "source_count_capped", value: (row) => row.sourceCount },
  { header: "sources_truncated", value: (row) => row.sourcesTruncated },
  { header: "candidate_id", value: (row) => row.candidateId },
  {
    header: "candidate_observed_manufacturer",
    value: (row) => row.candidateObservedManufacturer,
  },
  { header: "candidate_observed_model", value: (row) => row.candidateObservedModel },
  { header: "candidate_sample_title", value: (row) => row.candidateSampleTitle },
  { header: "candidate_category_ids_json", value: (row) => row.candidateCategoryIdsJson },
  {
    header: "candidate_active_listing_count",
    value: (row) => row.candidateActiveListingCount,
  },
  { header: "candidate_shop_count", value: (row) => row.candidateShopCount },
  {
    header: "candidate_unclassified_count",
    value: (row) => row.candidateUnclassifiedCount,
  },
  { header: "candidate_other_count", value: (row) => row.candidateOtherCount },
  {
    header: "candidate_unresolved_identity_count",
    value: (row) => row.candidateUnresolvedIdentityCount,
  },
  {
    header: "candidate_raw_model_variants_json",
    value: (row) => row.candidateRawModelVariantsJson,
  },
  {
    header: "candidate_evidence_source_urls_json",
    value: (row) => row.candidateEvidenceSourceUrlsJson,
  },
  {
    header: "candidate_identity_rejection_reason",
    value: (row) => row.candidateIdentityRejectionReason,
  },
  { header: "candidate_priority_score", value: (row) => row.candidatePriorityScore },
  { header: "candidate_review_status", value: (row) => row.candidateReviewStatus },
  {
    header: "candidate_catalog_product_id",
    value: (row) => row.candidateCatalogProductId,
  },
  { header: "candidate_first_seen_at", value: (row) => row.candidateFirstSeenAt },
  { header: "candidate_last_seen_at", value: (row) => row.candidateLastSeenAt },
  { header: "candidate_last_reviewed_at", value: (row) => row.candidateLastReviewedAt },
  {
    header: "candidate_verification_status",
    value: (row) => row.candidateVerificationStatus,
  },
  {
    header: "candidate_last_verification_at",
    value: (row) => row.candidateLastVerificationAt,
  },
  {
    header: "candidate_verification_message",
    value: (row) => row.candidateVerificationMessage,
  },
  { header: "candidate_source_url", value: (row) => row.candidateSourceUrl },
  {
    header: "latest_verification_attempt_id",
    value: (row) => row.latestVerificationAttemptId,
  },
  {
    header: "latest_verification_attempted_at",
    value: (row) => row.latestVerificationAttemptedAt,
  },
  {
    header: "latest_verification_status",
    value: (row) => row.latestVerificationStatus,
  },
  {
    header: "latest_verification_source_type",
    value: (row) => row.latestVerificationSourceType,
  },
  {
    header: "latest_verification_source_url",
    value: (row) => row.latestVerificationSourceUrl,
  },
  {
    header: "latest_verification_http_status",
    value: (row) => row.latestVerificationHttpStatus,
  },
  {
    header: "latest_verification_content_hash",
    value: (row) => row.latestVerificationContentHash,
  },
  {
    header: "latest_verification_message",
    value: (row) => row.latestVerificationMessage,
  },
  { header: "identity_sample_count", value: (row) => row.identitySampleCount },
  {
    header: "matched_identity_count_sampled",
    value: (row) => row.matchedIdentityCount,
  },
  {
    header: "active_matched_identity_count_sampled",
    value: (row) => row.activeMatchedIdentityCount,
  },
  {
    header: "identity_sample_truncated",
    value: (row) => row.identitySampleTruncated,
  },
  { header: "search_entity_id", value: (row) => row.searchEntityId },
  { header: "search_entity_key", value: (row) => row.searchEntityKey },
  { header: "search_entity_kind", value: (row) => row.searchEntityKind },
  {
    header: "search_entity_primary_category_id",
    value: (row) => row.searchEntityPrimaryCategoryId,
  },
  { header: "search_entity_offer_count", value: (row) => row.searchEntityOfferCount },
  {
    header: "search_entity_in_stock_offer_count",
    value: (row) => row.searchEntityInStockOfferCount,
  },
  {
    header: "search_entity_sold_out_offer_count",
    value: (row) => row.searchEntitySoldOutOfferCount,
  },
  { header: "search_entity_shop_count", value: (row) => row.searchEntityShopCount },
  {
    header: "search_entity_lowest_price_yen",
    value: (row) => row.searchEntityLowestPriceYen,
  },
  {
    header: "search_entity_lowest_in_stock_price_yen",
    value: (row) => row.searchEntityLowestInStockPriceYen,
  },
  {
    header: "search_entity_highest_price_yen",
    value: (row) => row.searchEntityHighestPriceYen,
  },
  {
    header: "search_entity_latest_activity_at",
    value: (row) => row.searchEntityLatestActivityAt,
  },
  {
    header: "search_entity_newest_listed_at",
    value: (row) => row.searchEntityNewestListedAt,
  },
  { header: "search_entity_has_price_drop", value: (row) => row.searchEntityHasPriceDrop },
  {
    header: "remediation_after_listing_id",
    value: (row) => row.remediationAfterListingId,
  },
  { header: "last_remediated_at", value: (row) => row.lastRemediatedAt },
  { header: "first_verified_at", value: (row) => row.firstVerifiedAt },
  { header: "last_verified_at", value: (row) => row.lastVerifiedAt },
  { header: "last_reviewed_at", value: (row) => row.lastReviewedAt },
  { header: "created_at", value: (row) => row.createdAt },
  { header: "updated_at", value: (row) => row.updatedAt },
];

function spreadsheetSafe(value: string): string {
  return /^[=+\-@]/u.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const safe = spreadsheetSafe(value);
  return `"${safe.replaceAll('"', '""')}"`;
}

function truncatedJsonValue(original: string, allowedCharacters: number): string {
  const metadata = { _truncated: 1, originalCharacters: original.length };
  const minimum = JSON.stringify(metadata);
  if (allowedCharacters <= minimum.length) return minimum;

  let prefixLength = Math.min(original.length, allowedCharacters - minimum.length);
  for (;;) {
    const value = JSON.stringify({ ...metadata, prefix: original.slice(0, prefixLength) });
    if (value.length <= allowedCharacters) return value;
    if (prefixLength === 0) return minimum;
    prefixLength = Math.max(0, prefixLength - Math.max(1, value.length - allowedCharacters));
  }
}

export function knowledgeCatalogCsvHeader(): string {
  return [
    ...COLUMNS.map((column) => column.header),
    adminCsvEditHeader("catalog"),
    TRUNCATED_FIELDS_HEADER,
  ].join(",");
}

export function knowledgeCatalogCsvRow(row: KnowledgeCatalogExportRow): string {
  const editing = adminCsvEditRow(
    adminCsvOriginal("catalog", row.catalogProductId, {
      manufacturer_id: row.manufacturerId,
      canonical_model: row.canonicalModel,
      canonical_name: row.canonicalName,
      primary_category_id: row.primaryCategoryId,
      lifecycle_status: row.lifecycleStatus,
    }),
  );
  let remainingCharacters = MAX_CSV_ROW_SOURCE_CHARACTERS - editing.length;
  const truncatedFields: string[] = [];
  const cells = COLUMNS.map((column) => {
    const original = column.value(row);
    if (typeof original !== "string") return csvCell(original);

    const cellCharacterLimit = column.header.endsWith("_json")
      ? MAX_CSV_JSON_CELL_SOURCE_CHARACTERS
      : MAX_CSV_CELL_SOURCE_CHARACTERS;
    const allowedCharacters = Math.min(cellCharacterLimit, remainingCharacters);
    let bounded = original;
    if (original.length > allowedCharacters) {
      if (column.header.endsWith("_json")) {
        bounded = truncatedJsonValue(original, allowedCharacters);
      } else {
        const prefixLength = Math.max(0, allowedCharacters - CSV_TRUNCATION_MARKER.length);
        bounded = `${original.slice(0, prefixLength)}${CSV_TRUNCATION_MARKER}`;
      }
      truncatedFields.push(column.header);
    }
    remainingCharacters = Math.max(0, remainingCharacters - bounded.length);
    return csvCell(bounded);
  });
  return cells.join(",") + "," + editing + "," + csvCell(truncatedFields.join("|"));
}

/** UTF-8 BOM keeps Japanese catalog evidence readable in spreadsheet applications. */
export const KNOWLEDGE_CATALOG_CSV_BOM = "\uFEFF";
