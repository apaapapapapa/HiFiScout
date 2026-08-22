import type { ReadableDatabase } from "./types.js";

const MAX_PAGE_SIZE = 100;
const CATEGORY_JSON_LIMIT = 20;
const ALIAS_JSON_LIMIT = 50;
const SOURCE_JSON_LIMIT = 20;
export const KNOWLEDGE_CATALOG_EXPORT_IDENTITY_COUNT_LIMIT = 100;
const SQL_TEXT_CHARACTER_LIMIT = 2_048;
const SQL_JSON_CHARACTER_LIMIT = 8_192;
const SQL_AGGREGATE_JSON_CHARACTER_LIMIT = 16_384;
const SQL_ALIAS_CHARACTER_LIMIT = 128;
const SQL_URL_CHARACTER_LIMIT = 512;
const SQL_TRUNCATION_MARKER = " [truncated]";

/** SQLite length(TEXT) stops at NUL, so embedded NULs take the truncation path explicitly. */
function boundedSqlText(expression: string, limit = SQL_TEXT_CHARACTER_LIMIT): string {
  const prefixLimit = Math.max(0, limit - SQL_TRUNCATION_MARKER.length);
  return `CASE
    WHEN ${expression} IS NULL THEN NULL
    WHEN instr(${expression}, char(0)) > 0
      THEN substr(
        ${expression},
        1,
        min(instr(${expression}, char(0)) - 1, ${prefixLimit})
      ) || '${SQL_TRUNCATION_MARKER}'
    WHEN length(${expression}) > ${limit}
      THEN substr(${expression}, 1, ${prefixLimit}) || '${SQL_TRUNCATION_MARKER}'
    ELSE ${expression} END`;
}

/** Keeps oversized/NUL-bearing JSON valid without re-escaping a large untrusted prefix. */
function boundedSqlJson(expression: string, limit = SQL_JSON_CHARACTER_LIMIT): string {
  return `CASE WHEN instr(${expression}, char(0)) > 0 OR length(${expression}) > ${limit}
    THEN json_object(
      '_truncated', 1,
      'originalCharacters', CASE
        WHEN instr(${expression}, char(0)) > 0 THEN NULL
        ELSE length(${expression})
      END,
      'originalBytes', length(CAST(${expression} AS BLOB))
    )
    ELSE ${expression} END`;
}

export interface KnowledgeCatalogExportPageOptions {
  afterId: number;
  maxId: number;
  limit: number;
}

export interface KnowledgeCatalogExportRow {
  catalogProductId: number;
  manufacturerId: string;
  manufacturerCanonicalName: string;
  manufacturerVerificationStatus: string;
  manufacturerSource: string;
  manufacturerProvenanceJson: string;
  canonicalModel: string;
  normalizedModel: string;
  canonicalName: string;
  lifecycleStatus: string;
  verificationStatus: string;
  reviewStatus: string;
  primaryCategoryId: string;
  categoriesJson: string;
  categoryCount: number;
  categoriesTruncated: number;
  aliasesJson: string;
  aliasCount: number;
  aliasesTruncated: number;
  sourcesJson: string;
  sourceCount: number;
  sourcesTruncated: number;
  candidateId: number | null;
  candidateObservedManufacturer: string;
  candidateObservedModel: string;
  candidateSampleTitle: string;
  candidateCategoryIdsJson: string;
  candidateActiveListingCount: number;
  candidateShopCount: number;
  candidateUnclassifiedCount: number;
  candidateOtherCount: number;
  candidateUnresolvedIdentityCount: number;
  candidateRawModelVariantsJson: string;
  candidateEvidenceSourceUrlsJson: string;
  candidateIdentityRejectionReason: string;
  candidatePriorityScore: number;
  candidateReviewStatus: string;
  candidateCatalogProductId: number | null;
  candidateFirstSeenAt: string | null;
  candidateLastSeenAt: string | null;
  candidateLastReviewedAt: string | null;
  candidateVerificationStatus: string;
  candidateLastVerificationAt: string | null;
  candidateVerificationMessage: string;
  candidateSourceUrl: string;
  latestVerificationAttemptId: number | null;
  latestVerificationAttemptedAt: string | null;
  latestVerificationStatus: string;
  latestVerificationSourceType: string;
  latestVerificationSourceUrl: string;
  latestVerificationHttpStatus: number | null;
  latestVerificationContentHash: string;
  latestVerificationMessage: string;
  identitySampleCount: number;
  matchedIdentityCount: number;
  activeMatchedIdentityCount: number;
  identitySampleTruncated: number;
  searchEntityId: number | null;
  searchEntityKey: string;
  searchEntityKind: string;
  searchEntityPrimaryCategoryId: string;
  searchEntityOfferCount: number;
  searchEntityInStockOfferCount: number;
  searchEntitySoldOutOfferCount: number;
  searchEntityShopCount: number;
  searchEntityLowestPriceYen: number | null;
  searchEntityLowestInStockPriceYen: number | null;
  searchEntityHighestPriceYen: number | null;
  searchEntityLatestActivityAt: string | null;
  searchEntityNewestListedAt: string | null;
  searchEntityHasPriceDrop: number;
  remediationAfterListingId: number;
  lastRemediatedAt: string | null;
  firstVerifiedAt: string | null;
  lastVerifiedAt: string | null;
  lastReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeCatalogExportPage {
  items: KnowledgeCatalogExportRow[];
  nextAfterId: number | null;
}

interface KnowledgeCatalogExportSqlRow {
  catalog_product_id: number;
  manufacturer_id: string;
  manufacturer_canonical_name: string | null;
  manufacturer_verification_status: string | null;
  manufacturer_source: string | null;
  manufacturer_provenance_json: string | null;
  canonical_model: string;
  normalized_model: string;
  canonical_name: string;
  lifecycle_status: string;
  verification_status: string;
  review_status: string;
  primary_category_id: string | null;
  categories_json: string;
  category_count: number;
  aliases_json: string;
  alias_count: number;
  sources_json: string;
  source_count: number;
  candidate_id: number | null;
  candidate_observed_manufacturer: string | null;
  candidate_observed_model: string | null;
  candidate_sample_title: string | null;
  candidate_category_ids_json: string | null;
  candidate_active_listing_count: number | null;
  candidate_shop_count: number | null;
  candidate_unclassified_count: number | null;
  candidate_other_count: number | null;
  candidate_unresolved_identity_count: number | null;
  candidate_raw_model_variants_json: string | null;
  candidate_evidence_source_urls_json: string | null;
  candidate_identity_rejection_reason: string | null;
  candidate_priority_score: number | null;
  candidate_review_status: string | null;
  candidate_catalog_product_id: number | null;
  candidate_first_seen_at: string | null;
  candidate_last_seen_at: string | null;
  candidate_last_reviewed_at: string | null;
  candidate_verification_status: string | null;
  candidate_last_verification_at: string | null;
  candidate_verification_message: string | null;
  candidate_source_url: string | null;
  latest_verification_attempt_id: number | null;
  latest_verification_attempted_at: string | null;
  latest_verification_status: string | null;
  latest_verification_source_type: string | null;
  latest_verification_source_url: string | null;
  latest_verification_http_status: number | null;
  latest_verification_content_hash: string | null;
  latest_verification_message: string | null;
  identity_counts_json: string;
  search_entity_id: number | null;
  search_entity_key: string | null;
  search_entity_kind: string | null;
  search_entity_primary_category_id: string | null;
  search_entity_offer_count: number | null;
  search_entity_in_stock_offer_count: number | null;
  search_entity_sold_out_offer_count: number | null;
  search_entity_shop_count: number | null;
  search_entity_lowest_price_yen: number | null;
  search_entity_lowest_in_stock_price_yen: number | null;
  search_entity_highest_price_yen: number | null;
  search_entity_latest_activity_at: string | null;
  search_entity_newest_listed_at: string | null;
  search_entity_has_price_drop: number | null;
  remediation_after_listing_id: number;
  last_remediated_at: string | null;
  first_verified_at: string | null;
  last_verified_at: string | null;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

interface IdentitySampleCounts {
  sampled: number;
  matched: number;
  activeMatched: number;
}

function identitySampleCounts(value: unknown): IdentitySampleCounts {
  try {
    const parsed = JSON.parse(text(value)) as Record<string, unknown>;
    return {
      sampled: Math.max(0, integer(parsed.sampled)),
      matched: Math.max(0, integer(parsed.matched)),
      activeMatched: Math.max(0, integer(parsed.activeMatched)),
    };
  } catch {
    return { sampled: 0, matched: 0, activeMatched: 0 };
  }
}

function rowFromSql(row: KnowledgeCatalogExportSqlRow): KnowledgeCatalogExportRow {
  const categoryCount = Math.max(0, integer(row.category_count));
  const aliasCount = Math.max(0, integer(row.alias_count));
  const sourceCount = Math.max(0, integer(row.source_count));
  const identities = identitySampleCounts(row.identity_counts_json);
  return {
    catalogProductId: Math.max(0, integer(row.catalog_product_id)),
    manufacturerId: text(row.manufacturer_id),
    manufacturerCanonicalName: text(row.manufacturer_canonical_name),
    manufacturerVerificationStatus: text(row.manufacturer_verification_status),
    manufacturerSource: text(row.manufacturer_source),
    manufacturerProvenanceJson: text(row.manufacturer_provenance_json) || "{}",
    canonicalModel: text(row.canonical_model),
    normalizedModel: text(row.normalized_model),
    canonicalName: text(row.canonical_name),
    lifecycleStatus: text(row.lifecycle_status),
    verificationStatus: text(row.verification_status),
    reviewStatus: text(row.review_status),
    primaryCategoryId: text(row.primary_category_id),
    categoriesJson: text(row.categories_json) || "[]",
    categoryCount,
    categoriesTruncated: categoryCount > CATEGORY_JSON_LIMIT ? 1 : 0,
    aliasesJson: text(row.aliases_json) || "[]",
    aliasCount,
    aliasesTruncated: aliasCount > ALIAS_JSON_LIMIT ? 1 : 0,
    sourcesJson: text(row.sources_json) || "[]",
    sourceCount,
    sourcesTruncated: sourceCount > SOURCE_JSON_LIMIT ? 1 : 0,
    candidateId: nullableInteger(row.candidate_id),
    candidateObservedManufacturer: text(row.candidate_observed_manufacturer),
    candidateObservedModel: text(row.candidate_observed_model),
    candidateSampleTitle: text(row.candidate_sample_title),
    candidateCategoryIdsJson: text(row.candidate_category_ids_json) || "[]",
    candidateActiveListingCount: Math.max(0, integer(row.candidate_active_listing_count)),
    candidateShopCount: Math.max(0, integer(row.candidate_shop_count)),
    candidateUnclassifiedCount: Math.max(0, integer(row.candidate_unclassified_count)),
    candidateOtherCount: Math.max(0, integer(row.candidate_other_count)),
    candidateUnresolvedIdentityCount: Math.max(0, integer(row.candidate_unresolved_identity_count)),
    candidateRawModelVariantsJson: text(row.candidate_raw_model_variants_json) || "[]",
    candidateEvidenceSourceUrlsJson: text(row.candidate_evidence_source_urls_json) || "[]",
    candidateIdentityRejectionReason: text(row.candidate_identity_rejection_reason),
    candidatePriorityScore: integer(row.candidate_priority_score),
    candidateReviewStatus: text(row.candidate_review_status),
    candidateCatalogProductId: nullableInteger(row.candidate_catalog_product_id),
    candidateFirstSeenAt: nullableText(row.candidate_first_seen_at),
    candidateLastSeenAt: nullableText(row.candidate_last_seen_at),
    candidateLastReviewedAt: nullableText(row.candidate_last_reviewed_at),
    candidateVerificationStatus: text(row.candidate_verification_status),
    candidateLastVerificationAt: nullableText(row.candidate_last_verification_at),
    candidateVerificationMessage: text(row.candidate_verification_message),
    candidateSourceUrl: text(row.candidate_source_url),
    latestVerificationAttemptId: nullableInteger(row.latest_verification_attempt_id),
    latestVerificationAttemptedAt: nullableText(row.latest_verification_attempted_at),
    latestVerificationStatus: text(row.latest_verification_status),
    latestVerificationSourceType: text(row.latest_verification_source_type),
    latestVerificationSourceUrl: text(row.latest_verification_source_url),
    latestVerificationHttpStatus: nullableInteger(row.latest_verification_http_status),
    latestVerificationContentHash: text(row.latest_verification_content_hash),
    latestVerificationMessage: text(row.latest_verification_message),
    identitySampleCount: identities.sampled,
    matchedIdentityCount: identities.matched,
    activeMatchedIdentityCount: identities.activeMatched,
    identitySampleTruncated:
      identities.sampled > KNOWLEDGE_CATALOG_EXPORT_IDENTITY_COUNT_LIMIT ? 1 : 0,
    searchEntityId: nullableInteger(row.search_entity_id),
    searchEntityKey: text(row.search_entity_key),
    searchEntityKind: text(row.search_entity_kind),
    searchEntityPrimaryCategoryId: text(row.search_entity_primary_category_id),
    searchEntityOfferCount: Math.max(0, integer(row.search_entity_offer_count)),
    searchEntityInStockOfferCount: Math.max(0, integer(row.search_entity_in_stock_offer_count)),
    searchEntitySoldOutOfferCount: Math.max(0, integer(row.search_entity_sold_out_offer_count)),
    searchEntityShopCount: Math.max(0, integer(row.search_entity_shop_count)),
    searchEntityLowestPriceYen: nullableInteger(row.search_entity_lowest_price_yen),
    searchEntityLowestInStockPriceYen: nullableInteger(row.search_entity_lowest_in_stock_price_yen),
    searchEntityHighestPriceYen: nullableInteger(row.search_entity_highest_price_yen),
    searchEntityLatestActivityAt: nullableText(row.search_entity_latest_activity_at),
    searchEntityNewestListedAt: nullableText(row.search_entity_newest_listed_at),
    searchEntityHasPriceDrop: Math.max(0, integer(row.search_entity_has_price_drop)),
    remediationAfterListingId: Math.max(0, integer(row.remediation_after_listing_id)),
    lastRemediatedAt: nullableText(row.last_remediated_at),
    firstVerifiedAt: nullableText(row.first_verified_at),
    lastVerifiedAt: nullableText(row.last_verified_at),
    lastReviewedAt: nullableText(row.last_reviewed_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

/**
 * Reads one bounded, horizon-limited keyset page. Every one-to-many relationship is an indexed
 * correlated lookup, so the main rowset can never fan out beyond one row per catalog product.
 */
export async function listKnowledgeCatalogExportPage(
  db: ReadableDatabase,
  options: KnowledgeCatalogExportPageOptions,
): Promise<KnowledgeCatalogExportPage> {
  const afterId = Math.max(0, Number.isSafeInteger(options.afterId) ? options.afterId : 0);
  const maxId = Math.max(0, Number.isSafeInteger(options.maxId) ? options.maxId : 0);
  const limit = Math.max(
    1,
    Math.min(MAX_PAGE_SIZE, Number.isSafeInteger(options.limit) ? options.limit : MAX_PAGE_SIZE),
  );
  const result = await db
    .prepare(`
      SELECT
        kp.id AS catalog_product_id,
        ${boundedSqlText("kp.manufacturer_id")} AS manufacturer_id,
        ${boundedSqlText("km.canonical_name")} AS manufacturer_canonical_name,
        ${boundedSqlText("km.verification_status", 128)} AS manufacturer_verification_status,
        ${boundedSqlText("km.source")} AS manufacturer_source,
        ${boundedSqlJson("km.provenance_json")} AS manufacturer_provenance_json,
        ${boundedSqlText("kp.canonical_model")} AS canonical_model,
        ${boundedSqlText("kp.normalized_model")} AS normalized_model,
        ${boundedSqlText("kp.canonical_name")} AS canonical_name,
        ${boundedSqlText("kp.lifecycle_status", 128)} AS lifecycle_status,
        ${boundedSqlText("kp.verification_status", 128)} AS verification_status,
        ${boundedSqlText("kp.review_status", 128)} AS review_status,
        (
          SELECT ${boundedSqlText("kpc_primary.category_id", 512)}
          FROM knowledge_catalog_product_categories kpc_primary
          WHERE kpc_primary.product_id = kp.id AND kpc_primary.is_primary = 1
          LIMIT 1
        ) AS primary_category_id,
        COALESCE((
          SELECT ${boundedSqlJson("category_aggregate.value", SQL_AGGREGATE_JSON_CHARACTER_LIMIT)}
          FROM (
            SELECT json_group_array(json(category_json)) AS value
            FROM (
              SELECT json_object(
                'categoryId', ${boundedSqlText("kpc.category_id", 128)},
                'isPrimary', kpc.is_primary
              ) AS category_json
              FROM knowledge_catalog_product_categories kpc
              WHERE kpc.product_id = kp.id
              ORDER BY kpc.is_primary DESC, kpc.category_id
              LIMIT ${CATEGORY_JSON_LIMIT}
            )
          ) category_aggregate
        ), '[]') AS categories_json,
        (
          SELECT COUNT(*) FROM (
            SELECT 1 FROM knowledge_catalog_product_categories kpc_count
            WHERE kpc_count.product_id = kp.id
            LIMIT ${CATEGORY_JSON_LIMIT + 1}
          )
        ) AS category_count,
        COALESCE((
          SELECT ${boundedSqlJson("alias_aggregate.value", SQL_AGGREGATE_JSON_CHARACTER_LIMIT)}
          FROM (
            SELECT json_group_array(json(alias_json)) AS value
            FROM (
              SELECT json_object(
                'alias', ${boundedSqlText("ka.alias", SQL_ALIAS_CHARACTER_LIMIT)},
                'normalizedAlias', ${boundedSqlText("ka.normalized_alias", SQL_ALIAS_CHARACTER_LIMIT)},
                'aliasType', ${boundedSqlText("ka.alias_type", 64)},
                'createdAt', ${boundedSqlText("ka.created_at", 128)}
              ) AS alias_json
              FROM knowledge_catalog_aliases ka
              WHERE ka.product_id = kp.id
              ORDER BY ka.alias_type, ka.normalized_alias, ka.id
              LIMIT ${ALIAS_JSON_LIMIT}
            )
          ) alias_aggregate
        ), '[]') AS aliases_json,
        (
          SELECT COUNT(*) FROM (
            SELECT 1 FROM knowledge_catalog_aliases ka_count
            WHERE ka_count.product_id = kp.id
            LIMIT ${ALIAS_JSON_LIMIT + 1}
          )
        ) AS alias_count,
        COALESCE((
          SELECT ${boundedSqlJson("source_aggregate.value", SQL_AGGREGATE_JSON_CHARACTER_LIMIT)}
          FROM (
            SELECT json_group_array(json(source_json)) AS value
            FROM (
              SELECT json_object(
                'sourceType', ${boundedSqlText("ks.source_type", 64)},
                'sourceUrl', ${boundedSqlText("ks.source_url", SQL_URL_CHARACTER_LIMIT)},
                'retrievedAt', ${boundedSqlText("ks.retrieved_at", 128)},
                'contentHash', ${boundedSqlText("ks.content_hash", 256)},
                'status', ${boundedSqlText("ks.status", 64)},
                'createdAt', ${boundedSqlText("ks.created_at", 128)},
                'updatedAt', ${boundedSqlText("ks.updated_at", 128)}
              ) AS source_json
              FROM knowledge_catalog_sources ks
              WHERE ks.product_id = kp.id
              ORDER BY ks.source_type, ks.source_url, ks.id
              LIMIT ${SOURCE_JSON_LIMIT}
            )
          ) source_aggregate
        ), '[]') AS sources_json,
        (
          SELECT COUNT(*) FROM (
            SELECT 1 FROM knowledge_catalog_sources ks_count
            WHERE ks_count.product_id = kp.id
            LIMIT ${SOURCE_JSON_LIMIT + 1}
          )
        ) AS source_count,
        kc.id AS candidate_id,
        ${boundedSqlText("kc.observed_manufacturer")} AS candidate_observed_manufacturer,
        ${boundedSqlText("kc.observed_model")} AS candidate_observed_model,
        ${boundedSqlText("kc.sample_title")} AS candidate_sample_title,
        ${boundedSqlJson("kc.candidate_category_ids")} AS candidate_category_ids_json,
        kc.active_listing_count AS candidate_active_listing_count,
        kc.shop_count AS candidate_shop_count,
        kc.unclassified_count AS candidate_unclassified_count,
        kc.other_count AS candidate_other_count,
        kc.unresolved_identity_count AS candidate_unresolved_identity_count,
        ${boundedSqlJson("kc.raw_model_variants")} AS candidate_raw_model_variants_json,
        ${boundedSqlJson("kc.evidence_source_urls")} AS candidate_evidence_source_urls_json,
        ${boundedSqlText("kc.identity_rejection_reason")} AS candidate_identity_rejection_reason,
        kc.priority_score AS candidate_priority_score,
        ${boundedSqlText("kc.review_status", 128)} AS candidate_review_status,
        kc.catalog_product_id AS candidate_catalog_product_id,
        ${boundedSqlText("kc.first_seen_at", 128)} AS candidate_first_seen_at,
        ${boundedSqlText("kc.last_seen_at", 128)} AS candidate_last_seen_at,
        ${boundedSqlText("kc.last_reviewed_at", 128)} AS candidate_last_reviewed_at,
        ${boundedSqlText("kc.verification_status", 128)} AS candidate_verification_status,
        ${boundedSqlText("kc.last_verification_at", 128)} AS candidate_last_verification_at,
        ${boundedSqlText("kc.verification_message")} AS candidate_verification_message,
        ${boundedSqlText("kc.source_url", SQL_URL_CHARACTER_LIMIT)} AS candidate_source_url,
        kva.id AS latest_verification_attempt_id,
        ${boundedSqlText("kva.attempted_at", 128)} AS latest_verification_attempted_at,
        ${boundedSqlText("kva.status", 128)} AS latest_verification_status,
        ${boundedSqlText("kva.source_type", 128)} AS latest_verification_source_type,
        ${boundedSqlText("kva.source_url", SQL_URL_CHARACTER_LIMIT)} AS latest_verification_source_url,
        kva.http_status AS latest_verification_http_status,
        ${boundedSqlText("kva.content_hash", 512)} AS latest_verification_content_hash,
        ${boundedSqlText("kva.message")} AS latest_verification_message,
        COALESCE((
          SELECT json_object(
            'sampled', COUNT(*),
            'matched', COALESCE(SUM(CASE WHEN identity_sample.status = 'matched' THEN 1 ELSE 0 END), 0),
            'activeMatched', COALESCE(SUM(CASE
              WHEN identity_sample.status = 'matched' AND p_identity.is_active = 1 THEN 1 ELSE 0
            END), 0)
          )
          FROM (
            SELECT pir_sample.listing_product_id, pir_sample.status
            FROM product_identity_resolutions pir_sample
            WHERE pir_sample.catalog_product_id = kp.id
            ORDER BY pir_sample.listing_product_id
            LIMIT ${KNOWLEDGE_CATALOG_EXPORT_IDENTITY_COUNT_LIMIT + 1}
          ) identity_sample
          LEFT JOIN products p_identity ON p_identity.id = identity_sample.listing_product_id
        ), '{"sampled":0,"matched":0,"activeMatched":0}') AS identity_counts_json,
        pse.id AS search_entity_id,
        ${boundedSqlText("pse.entity_key")} AS search_entity_key,
        ${boundedSqlText("pse.entity_kind", 128)} AS search_entity_kind,
        ${boundedSqlText("pse.primary_category_id", 512)} AS search_entity_primary_category_id,
        pse.offer_count AS search_entity_offer_count,
        pse.in_stock_offer_count AS search_entity_in_stock_offer_count,
        pse.sold_out_offer_count AS search_entity_sold_out_offer_count,
        pse.shop_count AS search_entity_shop_count,
        pse.lowest_price_yen AS search_entity_lowest_price_yen,
        pse.lowest_in_stock_price_yen AS search_entity_lowest_in_stock_price_yen,
        pse.highest_price_yen AS search_entity_highest_price_yen,
        ${boundedSqlText("pse.latest_activity_at", 128)} AS search_entity_latest_activity_at,
        ${boundedSqlText("pse.newest_listed_at", 128)} AS search_entity_newest_listed_at,
        pse.has_price_drop AS search_entity_has_price_drop,
        kp.remediation_after_listing_id,
        ${boundedSqlText("kp.last_remediated_at", 128)} AS last_remediated_at,
        ${boundedSqlText("kp.first_verified_at", 128)} AS first_verified_at,
        ${boundedSqlText("kp.last_verified_at", 128)} AS last_verified_at,
        ${boundedSqlText("kp.last_reviewed_at", 128)} AS last_reviewed_at,
        ${boundedSqlText("kp.created_at", 128)} AS created_at,
        ${boundedSqlText("kp.updated_at", 128)} AS updated_at
      FROM knowledge_catalog_products kp
      LEFT JOIN knowledge_catalog_manufacturers km ON km.id = kp.manufacturer_id
      LEFT JOIN knowledge_catalog_candidates kc
        ON kc.manufacturer_id = kp.manufacturer_id
       AND kc.normalized_model = kp.normalized_model
      LEFT JOIN knowledge_catalog_verification_attempts kva ON kva.id = (
        SELECT kva_pick.id
        FROM knowledge_catalog_verification_attempts kva_pick
        WHERE kva_pick.product_id = kp.id
        ORDER BY kva_pick.attempted_at DESC, kva_pick.id DESC
        LIMIT 1
      )
      LEFT JOIN product_search_entities pse ON pse.id = (
        SELECT pse_pick.id
        FROM product_search_entities pse_pick
        WHERE pse_pick.catalog_product_id = kp.id
        ORDER BY pse_pick.id
        LIMIT 1
      )
      WHERE kp.id > ? AND kp.id <= ?
      ORDER BY kp.id
      LIMIT ?
    `)
    .bind(afterId, maxId, limit + 1)
    .all<KnowledgeCatalogExportSqlRow>();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(rowFromSql);
  return {
    items,
    nextAfterId: hasMore && items.length ? items[items.length - 1].catalogProductId : null,
  };
}
