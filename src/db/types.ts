/**
 * Persistence-layer types.
 *
 * Two distinct families live here and must not be merged:
 * - `*Row` types mirror the SQL schema in `migrations/` exactly: snake_case, JSON columns are
 *   `string`, SQLite booleans are `0 | 1`, and `SUM(...)` aggregates are `number | null`.
 * - Domain result types are the camelCase values repositories return to callers.
 *
 * Conversion happens in the repository mapping layer, never in a row type.
 *
 * Imports are type-only and one-directional (`db -> catalog`) to keep `^src` acyclic.
 */

import type {
  CategoryId,
  ClassificationStatus,
  FeatureId,
  FeatureState,
  IdentityConfidence,
  IdentityMatchMethod,
  IdentityStatus,
  KnowledgeCatalogMatchType,
  ManufacturerResolutionMethod,
  ManufacturerResolutionStatus,
  ManufacturerVerificationStatus,
  ModelResolutionMethod,
  ProductIdentityResolution,
  ResolutionConfidence,
  ResolutionStatus,
  StockStatus,
} from "../catalog/types.js";
import type {
  KnowledgeSourceCandidate,
  KnowledgeSourceStatus,
  KnowledgeSourceType,
} from "../catalog/knowledge-verification/types.js";

// ---------------------------------------------------------------------------
// D1 access surface
// ---------------------------------------------------------------------------

/**
 * The only two `D1Database` members any repository uses.
 *
 * Repositories must take this rather than `D1Database`: the real binding satisfies it, and so
 * do the structural test doubles (which implement neither `exec`, `withSession` nor `dump`).
 */
export type QueryableDatabase = Pick<D1Database, "prepare" | "batch">;

/** Read-only surface: everything a caller needs when it only ever runs `SELECT`s. */
export type ReadableDatabase = Pick<QueryableDatabase, "prepare">;

/** SQLite has no boolean type; `CHECK (x IN (0, 1))` columns arrive as numbers. */
export type SqliteBool = 0 | 1;

/**
 * `SUM(CASE ... END)` returns NULL over zero rows even for NOT NULL columns.
 * `COUNT(*)` and `COALESCE(SUM(x), 0)` do not — use plain `number` for those.
 */
export type AggregateCount = number | null;

// ---------------------------------------------------------------------------
// products (migrations 0001, 0002, 0004-0008, 0014)
// ---------------------------------------------------------------------------

/** Full `products` row, as returned by `SELECT p.*`. */
export interface ProductRow {
  id: number;
  shop_key: string;
  source_id: string;
  manufacturer: string;
  model: string;
  title: string;
  /** Free Japanese display label, not a category id. */
  category: string;
  condition_text: string;
  price_yen: number | null;
  stock_status: StockStatus;
  source_url: string;
  first_seen_at: string;
  last_seen_at: string;
  last_changed_at: string;
  is_active: SqliteBool;
  previous_price_yen: number | null;
  /** JSON object; parse to `unknown` then narrow. */
  metadata_json: string;
  raw_manufacturer: string;
  manufacturer_id: string;
  normalized_raw_manufacturer: string;
  canonical_manufacturer_id: string;
  manufacturer_resolution_status: ManufacturerResolutionStatus;
  manufacturer_resolution_method: ManufacturerResolutionMethod;
  manufacturer_resolution_confidence: ResolutionConfidence;
  manufacturer_resolver_version: number;
  raw_model: string;
  normalized_model: string;
  /** Canonical finish label, or `""`. Never part of `normalized_model`; see the 0050 migration. */
  presentation_color: string;
  model_resolution_status: ResolutionStatus;
  model_resolution_method: ModelResolutionMethod;
  model_resolution_confidence: ResolutionConfidence;
  model_resolver_version: number;
  /** A remediation replay has derived fields that still need projection/identity/entity refresh. */
  remediation_projection_required: SqliteBool;
  /** Compare-and-clear token preventing an older concurrent replay from clearing newer work. */
  remediation_projection_token: string;
  raw_category: string;
  primary_category_id: string;
  /** JSON `string[]`; parse to `unknown` then narrow. */
  category_ids: string;
  classification_status: ClassificationStatus;
  search_aliases: string;
  last_inventory_checked_at: string | null;
  inventory_check_failures: number;
  last_inventory_check_attempt_at: string | null;
  /** Nullable in the schema even though the 0008 backfill populated every existing row. */
  last_activity_at: string | null;
  source_published_at: string | null;
}

/**
 * The API item shape is NOT derived from this row. `product-row-mapper.ts` maps `ProductRow`
 * onto `ProductListItem` in `api/contracts.ts` field by field, so adding a column here cannot
 * change a public payload.
 */

/** Explicit column list read by `selectExistingProducts()` during upsert. */
export type ExistingProductRow = Pick<
  ProductRow,
  | "id"
  | "source_id"
  | "manufacturer"
  | "raw_manufacturer"
  | "manufacturer_id"
  | "normalized_raw_manufacturer"
  | "canonical_manufacturer_id"
  | "manufacturer_resolution_status"
  | "manufacturer_resolution_method"
  | "manufacturer_resolution_confidence"
  | "manufacturer_resolver_version"
  | "model"
  | "raw_model"
  | "normalized_model"
  | "presentation_color"
  | "model_resolution_status"
  | "model_resolution_method"
  | "model_resolution_confidence"
  | "model_resolver_version"
  | "title"
  | "category"
  | "raw_category"
  | "primary_category_id"
  | "category_ids"
  | "classification_status"
  | "search_aliases"
  | "condition_text"
  | "price_yen"
  | "stock_status"
  | "source_url"
  | "source_published_at"
  | "metadata_json"
  | "first_seen_at"
  | "last_seen_at"
  | "last_activity_at"
  | "is_active"
>;

export type ProductLookupRow = Pick<ProductRow, "id" | "source_id">;

export type ProductPriceLookupRow = Pick<ProductRow, "id" | "source_id" | "price_yen">;

export type ProductMetadataLookupRow = Pick<ProductRow, "id" | "source_id" | "metadata_json">;

/** Subset of `products` read by the crawler's category enricher. */
export type CategoryEnrichmentProductRow = Pick<
  ProductRow,
  | "source_id"
  | "title"
  | "model"
  | "manufacturer_id"
  | "category"
  | "primary_category_id"
  | "category_ids"
  | "classification_status"
  | "search_aliases"
  | "metadata_json"
>;

// ---------------------------------------------------------------------------
// price_history / product_categories / product_feature_facts
// ---------------------------------------------------------------------------

export interface PriceHistoryRow {
  id: number;
  product_id: number;
  price_yen: number;
  observed_at: string;
}

/** Projection actually selected by `productHistory()`. */
export type PriceHistoryPoint = Pick<PriceHistoryRow, "price_yen" | "observed_at">;

export interface ProductCategoryRow {
  product_id: number;
  category_id: string;
}

export interface ProductFeatureFactRow {
  product_id: number;
  feature_id: FeatureId;
  state: FeatureState;
  /** No SQL CHECK; only `source = 'title'` rows are written or deleted by the sync pass. */
  source: string;
  confidence: number;
  verified_at: string | null;
}

// ---------------------------------------------------------------------------
// shop_sync_state / crawl_runs
// ---------------------------------------------------------------------------

export interface ShopSyncStateRow {
  shop_key: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  backoff_until: string | null;
  last_error: string | null;
  last_item_count: number;
  queued_at: string | null;
  /** Generation whose derived work is fully complete; trails `last_success_at` while work is owed. */
  last_projection_at: string | null;
}

export type CrawlRunStatus = "running" | "success" | "failed" | "skipped";

export interface CrawlRunRow {
  id: number;
  shop_key: string;
  started_at: string;
  finished_at: string | null;
  status: CrawlRunStatus;
  item_count: number;
  page_count: number;
  message: string | null;
}

// ---------------------------------------------------------------------------
// inventory recheck
// ---------------------------------------------------------------------------

export type InventoryRecheckCandidateRow = Pick<
  ProductRow,
  | "id"
  | "source_id"
  | "source_url"
  | "last_seen_at"
  | "last_inventory_checked_at"
  | "last_inventory_check_attempt_at"
  | "inventory_check_failures"
>;

// ---------------------------------------------------------------------------
// knowledge catalog (migrations 0009-0012, 0016)
// ---------------------------------------------------------------------------

export type KnowledgeCatalogLifecycleStatus = "unknown" | "active" | "discontinued";

/** `knowledge_catalog_products.verification_status` — only two states, unlike candidates. */
export type KnowledgeCatalogProductVerificationStatus = "verified" | "rejected";

export type KnowledgeCatalogProductReviewStatus = "current" | "due";

export type KnowledgeCatalogAliasType = "model" | "name";

export type KnowledgeCatalogSourceRowStatus = "active" | "missing" | "error";

export type KnowledgeCatalogCandidateReviewStatus = "pending" | "matched" | "ignored";

/** Candidate verification state: the attempt statuses plus the initial `"unverified"`. */
export type KnowledgeCatalogCandidateVerificationStatus = "unverified" | KnowledgeSourceStatus;

/** `knowledge_catalog_verification_attempts.status` — no `"unverified"` member. */
export type KnowledgeCatalogAttemptStatus = KnowledgeSourceStatus;

export type KnowledgeCatalogReviewRunStatus = "running" | "success" | "failed";

export type KnowledgeCatalogVerifierStatus = "running" | "success" | "failed";

export type KnowledgeCatalogJobType = "candidate" | "product_recheck" | "finalize";

export type KnowledgeCatalogJobStatus =
  | "queued"
  | "processing"
  | "retrying"
  | "completed"
  | "dead_letter";

/** Note the empty string and `"skipped"`, neither of which is a verification status. */
export type KnowledgeCatalogJobOutcome = "" | KnowledgeSourceStatus | "skipped";

export interface KnowledgeCatalogProductRow {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  normalized_model: string;
  canonical_name: string;
  lifecycle_status: KnowledgeCatalogLifecycleStatus;
  verification_status: KnowledgeCatalogProductVerificationStatus;
  review_status: KnowledgeCatalogProductReviewStatus;
  first_verified_at: string | null;
  last_verified_at: string | null;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeCatalogProductCategoryRow {
  product_id: number;
  category_id: string;
  is_primary: SqliteBool;
}

/**
 * `knowledge_catalog_products LEFT JOIN knowledge_catalog_product_categories`.
 * The joined columns are NOT NULL in their own table but nullable in this projection.
 */
export interface KnowledgeCatalogProductCategoryJoinRow {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  normalized_model: string;
  canonical_name?: string;
  category_id: string | null;
  is_primary: SqliteBool | null;
}

export interface KnowledgeCatalogAliasRow {
  id: number;
  product_id: number;
  alias: string;
  normalized_alias: string;
  alias_type: KnowledgeCatalogAliasType;
  created_at: string;
}

export interface KnowledgeCatalogManufacturerRow {
  id: string;
  canonical_name: string;
  verification_status: ManufacturerVerificationStatus;
  source: string;
  provenance_json: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeCatalogManufacturerAliasRow {
  id: number;
  manufacturer_id: string;
  canonical_name: string;
  alias: string;
  normalized_alias: string;
  verification_status: ManufacturerVerificationStatus;
  source: string;
  provenance_json: string;
  rule_version: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeCatalogSourceRow {
  id: number;
  product_id: number;
  source_type: KnowledgeSourceType;
  source_url: string;
  retrieved_at: string | null;
  content_hash: string;
  status: KnowledgeCatalogSourceRowStatus;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeCatalogCandidateRow {
  id: number;
  manufacturer_id: string;
  normalized_model: string;
  observed_manufacturer: string;
  observed_model: string;
  sample_title: string;
  /** JSON `string[]`. */
  candidate_category_ids: string;
  active_listing_count: number;
  shop_count: number;
  unclassified_count: number;
  priority_score: number;
  review_status: KnowledgeCatalogCandidateReviewStatus;
  catalog_product_id: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_reviewed_at: string;
  created_at: string;
  updated_at: string;
  verification_status: KnowledgeCatalogCandidateVerificationStatus;
  last_verification_at: string | null;
  verification_message: string;
  source_url: string;
}

export interface KnowledgeCatalogVerificationAttemptRow {
  id: number;
  candidate_id: number | null;
  product_id: number | null;
  manufacturer_id: string;
  normalized_model: string;
  /** No CHECK on this table, unlike `knowledge_catalog_sources.source_type`. */
  source_type: string;
  source_url: string;
  attempted_at: string;
  status: KnowledgeCatalogAttemptStatus;
  http_status: number | null;
  content_hash: string;
  message: string;
}

export interface KnowledgeCatalogReviewRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: KnowledgeCatalogReviewRunStatus;
  catalog_products: number;
  due_products: number;
  candidates: number;
  pending_candidates: number;
  matched_candidates: number;
  reclassified_products: number;
  message: string;
  verification_attempts: number;
  verified_promotions: number;
  verified_rechecks: number;
  verification_failures: number;
  active_products_before: number;
  active_products_after: number;
  unclassified_before: number;
  unclassified_after: number;
  other_before: number;
  other_after: number;
  verification_verified: number;
  verification_not_found: number;
  verification_ambiguous: number;
  verification_unsupported: number;
  verification_error: number;
}

export interface KnowledgeCatalogVerifierStateRow {
  version: number;
  status: KnowledgeCatalogVerifierStatus;
  started_at: string;
  finished_at: string | null;
  message: string;
}

export interface KnowledgeCatalogVerificationJobRow {
  id: number;
  run_id: number;
  job_key: string;
  job_type: KnowledgeCatalogJobType;
  target_id: number | null;
  manufacturer_id: string;
  hostname: string;
  status: KnowledgeCatalogJobStatus;
  outcome: KnowledgeCatalogJobOutcome;
  delivery_attempts: number;
  source_attempts: number;
  promoted: SqliteBool;
  rechecked: SqliteBool;
  enqueued_at: string;
  available_at: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  finished_at: string | null;
  last_message: string;
  created_at: string;
  updated_at: string;
}

/** Camel-cased queue job returned by the verification queue repository. */
export interface KnowledgeCatalogVerificationJob {
  id: number;
  runId: number;
  jobKey: string;
  jobType: KnowledgeCatalogJobType;
  targetId: number | null;
  manufacturerId: string;
  hostname: string;
  status: KnowledgeCatalogJobStatus;
  outcome: KnowledgeCatalogJobOutcome;
  deliveryAttempts: number;
  sourceAttempts: number;
  promoted: number;
  rechecked: number;
  enqueuedAt: string;
  availableAt: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  finishedAt: string | null;
  lastMessage: string;
}

export interface KnowledgeCatalogVerificationJobSpec {
  jobKey: string;
  jobType: KnowledgeCatalogJobType;
  targetId: number | null;
  manufacturerId: string;
  hostname: string;
}

export interface CompleteKnowledgeCatalogVerificationJobInput {
  outcome?: KnowledgeCatalogJobOutcome;
  promoted?: number;
  rechecked?: number;
  message?: string;
}

export interface ProductClassificationStats {
  activeProducts: number;
  unclassifiedProducts: number;
  otherProducts: number;
}

export interface KnowledgeCatalogVerificationOutcomes {
  verified: number;
  notFound: number;
  ambiguous: number;
  unsupported: number;
  error: number;
}

export interface KnowledgeCatalogVerificationRunStats {
  targetJobs: number;
  candidateJobs: number;
  productRecheckJobs: number;
  queued: number;
  processing: number;
  retrying: number;
  completed: number;
  deadLetter: number;
  outstanding: number;
  sourceAttempts: number;
  promoted: number;
  rechecked: number;
  outcomes: KnowledgeCatalogVerificationOutcomes;
}

export interface KnowledgeCatalogVerificationQueueStatus {
  queued: number;
  processing: number;
  retrying: number;
  deadLetter: number;
  oldestPendingAt: string | null;
  latestRun: KnowledgeCatalogVerificationRunStats | null;
  latestRunId: number | null;
}

export interface KnowledgeCatalogVerificationDomainLeaseRow {
  hostname: string;
  job_id: number;
  leased_until: string;
  updated_at: string;
}

/**
 * `listDueKnowledgeCatalogProducts()` projection.
 *
 * Beware: `category_ids` here is a COMMA-separated `GROUP_CONCAT`, not JSON, and
 * `primary_category_id` comes from `MAX(CASE ...)` over a LEFT JOIN so it can be null.
 */
export interface DueKnowledgeCatalogProductRow {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  normalized_model: string;
  canonical_name: string;
  primary_category_id: string | null;
  category_ids: string | null;
  source_id: number;
  source_type: KnowledgeSourceType;
  source_url: string;
}

// ---------------------------------------------------------------------------
// search projection + identity resolution (migration 0017)
// ---------------------------------------------------------------------------

export interface ProductSearchProjectionRow {
  product_id: number;
  manufacturer_id: string;
  source_model: string;
  normalized_model: string;
  manufacturer_terms: string;
  model_terms: string;
  title: string;
  category_terms: string;
}

/** Camel-cased projection value built by `buildProductSearchProjection()`. */
export interface ProductSearchProjection {
  productId: number;
  manufacturerId: string;
  sourceModel: string;
  normalizedModel: string;
  manufacturerTerms: string;
  modelTerms: string;
  title: string;
  categoryTerms: string;
}

/**
 * `buildProductSearchProjection()` accepts either a raw row or a camelCase domain product,
 * so both spellings must stay optional here.
 */
export interface ProductSearchProjectionInput {
  id?: number;
  product_id?: number;
  productId?: number;
  manufacturer_id?: string;
  manufacturerId?: string;
  model?: string;
  title?: string;
  manufacturer?: string;
  raw_manufacturer?: string;
  rawManufacturer?: string;
  category?: string;
  raw_category?: string;
  rawCategory?: string;
  search_aliases?: string;
  searchAliases?: string;
}

/** The three `*_json` columns are compared as raw strings for change detection; never parsed. */
export interface ProductIdentityResolutionRow {
  listing_product_id: number;
  catalog_product_id: number | null;
  candidate_catalog_product_id: number | null;
  status: IdentityStatus;
  /** NOT NULL but un-CHECKed; see `IdentityMatchMethod` for the produced values. */
  match_method: IdentityMatchMethod;
  confidence: IdentityConfidence;
  normalized_model: string;
  model_stem: string;
  variants_json: string;
  matched_fields_json: string;
  rejected_by_json: string;
  evaluated_at: string;
}

/** Snake-cased metrics payload emitted as a JSON log line by the identity sync pass. */
export interface IdentitySyncMetrics {
  identity_exact_match_count: number;
  identity_alias_match_count: number;
  identity_fuzzy_match_count: number;
  identity_unresolved_count: number;
  identity_veto_count: number;
  identity_resolution_write_count: number;
}

export interface ProjectionSyncResult {
  checkedCount: number;
  changedCount: number;
}

// ---------------------------------------------------------------------------
// product search entities (migration 0021)
// ---------------------------------------------------------------------------

export type ProductSearchEntityKind = "catalog" | "unresolved_listing";

/**
 * One row of the product-level search read model.
 *
 * The aggregate columns describe *all* currently active offers. When an offer-level filter is in
 * play the response recomputes them over the matching subset instead, so a card can never
 * contradict the filter that produced it.
 */
export interface ProductSearchEntityRow {
  id: number;
  entity_key: string;
  entity_kind: ProductSearchEntityKind;
  catalog_product_id: number | null;
  fallback_listing_id: number | null;
  manufacturer_id: string;
  manufacturer: string;
  model: string;
  normalized_model: string;
  /** Comma-joined canonical finishes of the member offers, in no particular order. */
  presentation_colors: string;
  primary_category_id: string;
  offer_count: number;
  in_stock_offer_count: number;
  sold_out_offer_count: number;
  shop_count: number;
  lowest_price_yen: number | null;
  /** Lowest price among in-stock offers only, so "cheapest first" can stay indexable under the
   * default in-stock filter instead of ordering by a price nobody can buy. */
  lowest_in_stock_price_yen: number | null;
  highest_price_yen: number | null;
  latest_activity_at: string | null;
  newest_listed_at: string | null;
  has_price_drop: 0 | 1;
}

/** Per-entity aggregates recomputed over the offers that satisfy the active offer filters. */
export interface ProductSearchOfferAggregateRow {
  entity_id: number;
  /** Null when no matching offer named a finish; `""` is not distinguished from it. */
  presentation_colors: string | null;
  offer_count: number;
  in_stock_offer_count: number;
  sold_out_offer_count: number;
  shop_count: number;
  lowest_price_yen: number | null;
  highest_price_yen: number | null;
  latest_activity_at: string | null;
  newest_listed_at: string | null;
  has_price_drop: number;
}

/** A seller listing as it is exposed under a product. `entity_id` is absent on detail reads. */
export interface ProductSearchOfferRow {
  entity_id?: number;
  listing_product_id: number;
  shop_key: string;
  source_url: string;
  title: string;
  condition_text: string;
  presentation_color: string;
  price_yen: number | null;
  previous_price_yen: number | null;
  stock_status: StockStatus;
  first_seen_at: string;
  last_seen_at: string;
  last_activity_at: string | null;
  source_published_at: string | null;
}

export interface ProductSearchEntitySyncResult {
  listing_count: number;
  entity_count: number;
  removed_entity_count: number;
}

export interface ProductSearchEntityRebuildResult {
  event: "product_search_entity_rebuild";
  entity_count: number;
  offer_count: number;
  membership_write_count: number;
  removed_entity_count: number;
}

/** Every count is an invariant violation; `ok` is the single signal for a health surface. */
export interface ProductSearchEntityConsistency {
  unmembered_active_listings: number;
  inactive_offer_memberships: number;
  entities_without_offers: number;
  stale_fallback_entities: number;
  ineligible_catalog_entities: number;
  offer_count_mismatches: number;
  fts_integrity_ok: boolean;
  ok: boolean;
}

/** Product-level keyset pagination. Only `id` and `sort` are runtime-validated. */
export interface ProductSearchCursor {
  id: number;
  sort: string;
  value?: string | number | null;
  isNull?: boolean;
}

/**
 * A product-level ordering.
 *
 * `key` is what a cursor is stamped with, and differs from the `sort` query value whenever the
 * column depends on the request (the price sorts switch to the in-stock aggregate when the caller
 * asked for in-stock offers), so a cursor can never be replayed against a different ordering.
 */
export interface ProductSearchSortDefinition {
  key: string;
  column:
    | "newest_listed_at"
    | "latest_activity_at"
    | "lowest_price_yen"
    | "lowest_in_stock_price_yen";
  direction: "ASC" | "DESC";
  idDirection: "ASC" | "DESC";
}

// ---------------------------------------------------------------------------
// evidence archive (migrations 0017, 0018)
// ---------------------------------------------------------------------------

/** The column has no SQL CHECK; `REASON_RETENTION` is the authoritative key set. */
export type EvidenceReason =
  | "parser_failure"
  | "temporary_debug_snapshot"
  | "unexpected_item_count"
  | "crawl_validation_failure"
  | "unknown_manufacturer"
  | "unknown_category"
  | "html_structure_change"
  | "product_content_changed"
  | "classification_unresolved"
  | "knowledge_catalog_verification";

export type EvidenceRetentionClass = "short" | "medium" | "long";

export interface EvidenceArchiveRow {
  id: number;
  shop_key: string;
  product_id: number | null;
  crawl_run_id: number | null;
  reason: string;
  content_hash: string;
  r2_object_key: string;
  content_type: string;
  captured_at: string;
  expires_at: string | null;
  content_bytes: number;
}

export interface EvidenceUsage {
  dailyObjects: number;
  dailyBytes: number;
  shopDailyObjects: number;
  burstObjects: number;
  estimatedStoredBytes: number;
}

export type EvidenceSuppressionReason =
  | "daily_object_cap"
  | "daily_byte_cap"
  | "shop_daily_object_cap"
  | "burst_sampled";

/** Discriminated on `status`; the caller only reads `status` and `reason`. */
export type EvidenceArchiveResult =
  | { status: "skipped"; reason: "not_archiveable" }
  /** No `error`: the binding check fails before any error is produced. */
  | { status: "failed"; reason: "binding_missing" }
  | { status: "failed"; reason: "archive_error"; error: string }
  | { status: "suppressed"; reason: EvidenceSuppressionReason; usage: EvidenceUsage }
  | { status: "deduplicated"; contentHash: string; objectKey: string }
  | {
      status: "archived";
      contentHash: string;
      objectKey: string;
      contentBytes: number;
      expiresAt: string | null;
    };

// ---------------------------------------------------------------------------
// data quality (migration 0019)
// ---------------------------------------------------------------------------

export type QualityStatus = "healthy" | "warning" | "critical" | "unknown";

export interface QualityMetric {
  count: number;
  denominator: number;
  rate: number | null;
  status: QualityStatus;
}

export interface ItemCountMetric {
  previous: number | null;
  current: number;
  absoluteDifference: number | null;
  changeRate: number | null;
  status: QualityStatus;
}

export interface QualityThreshold {
  warning: number;
  critical: number;
  direction?: "low" | "high";
  inclusive?: boolean;
}

export interface QualitySnapshotMetrics {
  manufacturerUnknown: QualityMetric;
  categoryUnclassified: QualityMetric;
  identityUnresolved: QualityMetric;
  inventoryUnknown: QualityMetric;
  modelMissing: QualityMetric;
}

export interface QualityRunMetrics {
  parserFailure: QualityMetric;
  evidenceCoverage: QualityMetric;
  itemCount: ItemCountMetric;
}

export interface QualityCounts {
  totalItems: number;
  manufacturerMissingCount: number;
  manufacturerUnresolvedCount: number;
  categoryUnclassifiedCount: number;
  otherCategoryCount: number;
  identityMatchedCount: number;
  identityUnresolvedCount: number;
  identityVetoCount: number;
  identityCandidateCount: number;
  inventoryKnownCount: number;
  inventoryUnknownCount: number;
  modelExpectedCount: number;
  modelExtractedCount: number;
  modelMissingCount: number;
  parseAttemptCount: number;
  parseSuccessCount: number;
  parseFailureCount: number;
  evidenceExpectedEventCount: number;
  evidenceArchivedEventCount: number;
  evidenceArchiveFailureCount: number;
  previousItemCount: number | null;
  currentItemCount: number;
  itemCountAbsoluteDifference: number | null;
  itemCountChangeRate: number | null;
}

/** `evaluateQuality()` output; `dataQualityRow()` reproduces the same shape from a stored row. */
export interface QualityEvaluation {
  shopKey: string;
  status: QualityStatus;
  snapshot: { status: QualityStatus; metrics: QualitySnapshotMetrics };
  run: { status: QualityStatus; metrics: QualityRunMetrics };
  metrics: QualitySnapshotMetrics & QualityRunMetrics;
  counts: QualityCounts;
}

/** The eleven `*_status` columns all share `QualityStatus`. */
export interface DataQualityRunRow {
  id: number;
  shop_key: string;
  crawl_run_id: number | null;
  evaluated_at: string;
  total_items: number;
  manufacturer_missing_count: number;
  manufacturer_unresolved_count: number;
  category_unclassified_count: number;
  other_category_count: number;
  identity_matched_count: number;
  identity_unresolved_count: number;
  identity_veto_count: number;
  identity_candidate_count: number;
  inventory_known_count: number;
  inventory_unknown_count: number;
  model_expected_count: number;
  model_extracted_count: number;
  model_missing_count: number;
  parse_attempt_count: number;
  parse_success_count: number;
  parse_failure_count: number;
  evidence_expected_event_count: number;
  evidence_archived_event_count: number;
  evidence_archive_failure_count: number;
  previous_item_count: number | null;
  current_item_count: number;
  item_count_absolute_difference: number | null;
  item_count_change_rate: number | null;
  manufacturer_status: QualityStatus;
  category_status: QualityStatus;
  identity_status: QualityStatus;
  inventory_status: QualityStatus;
  model_status: QualityStatus;
  parser_status: QualityStatus;
  item_count_status: QualityStatus;
  evidence_status: QualityStatus;
  snapshot_status: QualityStatus;
  run_status: QualityStatus;
  quality_status: QualityStatus;
}

/**
 * Single-row aggregate over `products LEFT JOIN product_identity_resolutions`.
 * `total_items` is a `COUNT(*)`; every other field is a nullable `SUM(CASE ...)`.
 */
export interface DataQualitySnapshotAggregateRow {
  total_items: number;
  manufacturer_missing_count: AggregateCount;
  manufacturer_unresolved_count: AggregateCount;
  category_unclassified_count: AggregateCount;
  other_category_count: AggregateCount;
  identity_matched_count: AggregateCount;
  identity_unresolved_count: AggregateCount;
  identity_veto_count: AggregateCount;
  identity_candidate_count: AggregateCount;
  inventory_known_count: AggregateCount;
  inventory_unknown_count: AggregateCount;
  model_expected_count: AggregateCount;
  model_extracted_count: AggregateCount;
  model_missing_count: AggregateCount;
}

// ---------------------------------------------------------------------------
// Repository domain results
// ---------------------------------------------------------------------------

export interface UpsertProductsResult {
  changedCount: number;
  activityCount: number;
  touchedCount: number;
  deactivatedCount: number;
  /** Title-derived feature facts rewritten, which only the changed listings needed. */
  featureFactCount: number;
  /**
   * Listings whose canonical, availability or identity inputs actually moved.
   *
   * A routine crawl re-reports an inventory that is mostly unchanged, and a listing nobody touched
   * projects to exactly what is already stored. Naming the delta here is what lets the derived
   * stages read the listings that changed instead of every listing the shop reported; the peers a
   * changed listing regroups are expanded by the entity stage itself, and stale resolver versions
   * stay the remediation queue's work rather than being hidden inside a normal crawl.
   */
  derivedSourceIds: string[];
}

/** `findVerifiedCatalogMatches()` value; `null` marks an ambiguous key. */
export interface CatalogMatchIndexEntry {
  id: number;
  manufacturerId: string;
  canonicalModel: string;
  normalizedModel: string;
  canonicalName: string;
  categoryIds: string[];
  matchType: KnowledgeCatalogMatchType;
}

export type KnowledgeCatalogPromotionReason =
  | "rejected_catalog_identity"
  | "already_exists"
  | "identity_changed"
  | "verified";

export interface KnowledgeCatalogPromotionResult {
  promoted: boolean;
  productId: number | null;
  reason: KnowledgeCatalogPromotionReason;
}

export interface PendingKnowledgeCatalogCandidate extends KnowledgeSourceCandidate {
  id: number;
  manufacturerId: string;
  normalizedModel: string;
  observedManufacturer: string;
  observedModel: string;
  sampleTitle: string;
  priorityScore: number;
  verificationStatus: KnowledgeCatalogCandidateVerificationStatus;
  lastVerificationAt: string | null;
}

export interface DueKnowledgeCatalogProduct extends KnowledgeSourceCandidate {
  id: number;
  manufacturerId: string;
  canonicalModel: string;
  normalizedModel: string;
  canonicalName: string;
  primaryCategoryId: string | null;
  categoryIds: string[];
  sourceId: number;
  sourceType: KnowledgeSourceType;
  sourceUrl: string;
}

/**
 * Re-exported so downstream repository modules can import row and domain types from one
 * place. `ProductIdentityResolution` itself is owned by the catalog domain.
 */
export type { CategoryId, ProductIdentityResolution };
