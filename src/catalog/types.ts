/**
 * Catalog domain vocabulary.
 *
 * Leaf module: it must stay import-free (except type-only imports from `src/types.ts`)
 * so `src/db/types.ts` and `src/crawler/types.ts` can depend on it without creating a cycle.
 *
 * Naming convention used throughout:
 * - `*Input` = loose, caller-supplied shape (fields optional, values still runtime-validated).
 * - no suffix = the normalized/produced shape (fields guaranteed by the producing function).
 */

// ---------------------------------------------------------------------------
// Category taxonomy (src/catalog/categories.ts)
// ---------------------------------------------------------------------------

/** Non-classifiable grouping parents. `CATEGORIES` entries use these as `parentId`. */
export type CategoryGroupId =
  | "amplifier"
  | "digital"
  | "analog"
  | "speaker"
  | "headphone_group"
  | "accessories";

/** Leaf categories a product can actually be classified into. */
export type ClassifiableCategoryId =
  | "integrated_amp"
  | "pre_amp"
  | "power_amp"
  | "headphone_amp"
  | "dac"
  | "network_player"
  | "cd_sacd_player"
  | "dap"
  | "turntable"
  | "tonearm"
  | "cartridge"
  | "phono_eq"
  | "speaker_bookshelf"
  | "speaker_floorstanding"
  | "subwoofer"
  | "speaker_other"
  | "headphone"
  | "earphone"
  | "cable"
  | "rack"
  | "power_accessory"
  | "vacuum_tube"
  | "other_accessory"
  | "dj_dtm"
  | "other";

/** Every id present in `CATEGORIES` (31 entries). */
export type CategoryId = CategoryGroupId | ClassifiableCategoryId;

/**
 * Pre-taxonomy-v2 ids still accepted on input and rewritten by `LEGACY_ALIASES`.
 * They are NOT `CategoryId`s and must never be produced.
 */
export type LegacyCategoryAlias = "network_transport" | "accessory";

export interface CategoryDefinition {
  readonly id: CategoryId;
  readonly name: string;
  readonly parentId: CategoryGroupId | null;
  readonly order: number;
  readonly classifiable: boolean;
  readonly filterable: boolean;
  readonly aliases: readonly string[];
  /** Derived mirror of `filterable`, added when the definition is frozen. */
  readonly selectable: boolean;
}

/** `categoryFacet()` projection: note it replaces `aliases`/`selectable` with `group`. */
export interface CategoryFacet {
  readonly id: CategoryId;
  readonly name: string;
  readonly parentId: CategoryGroupId | null;
  readonly order: number;
  readonly classifiable: boolean;
  readonly filterable: boolean;
  /** Parent display name, or `null` for a top-level category. */
  readonly group: string | null;
}

/**
 * Shop-supplied `rawCategory` -> category id mapping.
 *
 * Values are NOT guaranteed to be canonical `CategoryId`s: adapters map to legacy
 * aliases (`network_transport`, `accessory`) and to group ids, and a value may be an
 * array whose first element wins (`categories.ts` `mappingValue`).
 */
export type CategoryMapping = Readonly<Record<string, string | readonly string[]>>;

/** Closed source enum produced by `normalizeCategory()` only. */
export type CategoryNormalizationSource =
  | "shop_mapping"
  | "global_alias"
  | "raw_inference"
  | "parser_hint"
  | "title_inference"
  | "unclassified";

/**
 * `normalizeCategory()` result. Deliberately NOT the same shape as `CategoryClassification`:
 * it has no `classificationState`, `classificationReason` or `candidateCategoryIds`, and its
 * `classificationSource` is a closed union.
 */
export interface NormalizeCategoryResult {
  primaryCategoryId: CategoryId;
  /** Always exactly one element. */
  categoryIds: CategoryId[];
  displayName: string;
  classificationStatus: ClassificationStatus;
  classificationSource: CategoryNormalizationSource;
  searchAliases: string;
}

export interface NormalizeCategoryOptions {
  rawCategory?: string;
  title?: string;
  hintedCategory?: string;
  categoryMapping?: CategoryMapping;
}

// ---------------------------------------------------------------------------
// Classification state
// ---------------------------------------------------------------------------

export type ClassificationStatus = "classified" | "unclassified";

export type ClassificationState = "classified" | "ambiguous" | "unclassified";

export type ClassificationReason = "" | "conflicting_evidence" | "insufficient_evidence";

/**
 * NOT a literal union. `category-classifier.ts` computes it as `sources.join("+")`, so a
 * listing with seller-category AND title evidence yields `"seller_category+title"`.
 * Standalone values observed: "classified", "ambiguous", "unclassified", "cached_detail".
 */
export type ClassificationSource = string;

// ---------------------------------------------------------------------------
// Category evidence
// ---------------------------------------------------------------------------

export type CategoryEvidenceStrength = "verified" | "authoritative" | "strong" | "supporting";

/** Strength tiers in the order `classifyCategoryEvidence` scans them (weakest last). */
export const CATEGORY_EVIDENCE_STRENGTHS: readonly CategoryEvidenceStrength[] = [
  "verified",
  "authoritative",
  "strong",
  "supporting",
];

/**
 * Narrows an untrusted `strength` field. Behaviourally identical to the `STRENGTHS` set
 * membership test in `category-classifier.ts`, but it narrows the type as well.
 */
export function isCategoryEvidenceStrength(value: unknown): value is CategoryEvidenceStrength {
  return (
    value === "verified" ||
    value === "authoritative" ||
    value === "strong" ||
    value === "supporting"
  );
}

/** Evidence sources emitted by first-party producers. Consumers must accept any `string`. */
export type KnownCategoryEvidenceSource =
  | "seller_category"
  | "title"
  | "parser_hint"
  | "knowledge_catalog"
  | "manufacturer_official"
  | "detail_metadata"
  | "detail_product_text"
  | "unknown";

/**
 * Loose evidence item accepted by `classifyCategoryEvidence`/`summarizeCategoryEvidence`.
 *
 * Every field is optional because the classifier reads defensively (`item?.x`), and both the
 * plural `categoryIds` (producers) and singular `categoryId` (tests) spellings are supported.
 * `source` stays `string`: tests feed "detail"/"structured_data" which are not first-party.
 */
export interface CategoryEvidenceInput {
  categoryIds?: readonly string[];
  categoryId?: string;
  source?: string;
  strength?: string;
  value?: string;
}

/** Item produced by the classifier's internal `normalizedEvidence()`, before filtering. */
export interface NormalizedCategoryEvidenceItem {
  categoryId: CategoryId | null;
  /** Zero or one element, mirroring `categoryId`. */
  categoryIds: CategoryId[];
  source: string;
  strength: CategoryEvidenceStrength;
  /** Truncated to 240 characters. */
  value: string;
}

/** Same item after `.filter(item => item.categoryId)`; use a type predicate to reach it. */
export interface ResolvedCategoryEvidenceItem extends NormalizedCategoryEvidenceItem {
  categoryId: CategoryId;
}

/** Element of `metadata.categoryClassification.evidence`; value re-truncated to 160 chars. */
export interface CategoryEvidenceSummaryItem {
  categoryIds: CategoryId[];
  source: string;
  strength: CategoryEvidenceStrength;
  value: string;
}

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------

/** Return value of `classifyCategoryEvidence()`; also hand-built by `category-enricher`. */
export interface CategoryClassification {
  primaryCategoryId: CategoryId;
  /** Empty when unresolved; exactly one element when classified. */
  categoryIds: CategoryId[];
  displayName: string;
  classificationStatus: ClassificationStatus;
  classificationState: ClassificationState;
  classificationReason: ClassificationReason;
  classificationSource: ClassificationSource;
  candidateCategoryIds: CategoryId[];
  searchAliases: string;
}

/** `metadata.categoryClassification` block written by `applyCategoryClassification`. */
export interface CategoryClassificationMetadata {
  version: number;
  state: ClassificationState;
  status: ClassificationStatus;
  reason: ClassificationReason;
  source: ClassificationSource;
  categoryIds: CategoryId[];
  candidateCategoryIds: CategoryId[];
  evidence: CategoryEvidenceSummaryItem[];
  /** Added by the crawler's detail-page enrichment pass. */
  detailCheckedAt?: string;
  /** Added by the knowledge-catalog enrichment pass. */
  catalogProductId?: number;
  catalogMatchType?: KnowledgeCatalogMatchType;
  catalogMatchedAt?: string;
}

/**
 * Extra keys merged under the fixed metadata keys. The previous block is parsed from an
 * arbitrary JSON blob, so unknown keys survive: model it as an open record.
 */
export type CategoryClassificationMetadataPatch = Readonly<Record<string, unknown>>;

/**
 * The caller-facing patch of `applyCategoryClassification`: only the four keys the enrichment
 * passes actually add, so a typo or a wrong value type is rejected instead of persisted.
 */
export type CategoryClassificationMetadataOverrides = Partial<
  Pick<
    CategoryClassificationMetadata,
    "detailCheckedAt" | "catalogProductId" | "catalogMatchType" | "catalogMatchedAt"
  >
>;

/** Product metadata after normalization. Open by design (adapters add their own keys). */
export interface ProductMetadata extends Record<string, unknown> {
  categoryClassification?: CategoryClassificationMetadata & Record<string, unknown>;
  manufacturerNormalization?: ManufacturerNormalizationMetadata;
}

export interface ManufacturerNormalizationMetadata {
  version: number;
  matchedAlias: boolean;
}

/** The eleven fields `applyCategoryClassification` writes onto a product. */
export interface CategoryClassificationFields {
  primaryCategoryId: CategoryId;
  categoryIds: CategoryId[];
  /** Display name of the resolved category (`classification.displayName`). */
  category: string;
  classificationStatus: ClassificationStatus;
  classificationState: ClassificationState;
  classificationReason: ClassificationReason;
  classificationSource: ClassificationSource;
  candidateCategoryIds: CategoryId[];
  searchAliases: string;
  categoryEvidence: CategoryEvidenceInput[];
  metadata: ProductMetadata;
}

/** Result of spreading `CategoryClassificationFields` over an arbitrary product shape. */
export type WithCategoryClassification<T> = Omit<T, keyof CategoryClassificationFields> &
  CategoryClassificationFields;

/** Minimum a value must satisfy to be passed through `applyCategoryClassification`. */
export interface CategoryClassifiableProduct {
  categoryEvidence?: CategoryEvidenceInput[];
  metadata?: unknown;
}

// ---------------------------------------------------------------------------
// Category policy (shop-declared, then resolved)
// ---------------------------------------------------------------------------

export type CategoryPolicyMode = "authoritative" | "corroborative" | "ignore";

/**
 * Adapter-declared policy. Deeply partial: `shimamusen` supplies only
 * `sellerCategory.default` and `parserHint`. Values are runtime-validated by `mode()`,
 * so a stale/unknown mode simply falls back rather than throwing.
 */
export interface CategoryPolicyInput {
  readonly sellerCategory?: {
    readonly default?: CategoryPolicyMode;
    /** Keys stay `string`: shop configs may name a category id that no longer exists. */
    readonly categories?: Readonly<Record<string, CategoryPolicyMode>>;
  };
  readonly parserHint?: CategoryPolicyMode;
  /** Legacy compatibility flag; only the exact value `"prefer"` has an effect. */
  readonly titleInference?: string;
  readonly enrichment?: {
    readonly maxRequestsPerCrawl?: number;
    readonly cacheHours?: number;
  };
}

/** Fully-populated policy returned by `resolveCategoryPolicy()`. */
export interface ResolvedCategoryPolicy {
  sellerCategory: {
    default: CategoryPolicyMode;
    categories: Record<string, CategoryPolicyMode>;
  };
  parserHint: CategoryPolicyMode;
  enrichment: {
    maxRequestsPerCrawl: number;
    cacheHours: number;
  };
}

/**
 * The slice of a shop adapter the catalog layer reads. Declared here (rather than importing
 * `ShopAdapter` from the crawler) so this module stays a leaf.
 */
export interface CatalogAdapterLike {
  readonly key?: string;
  readonly categoryMapping?: CategoryMapping;
  readonly categoryPolicy?: CategoryPolicyInput;
}

export interface CollectListingCategoryEvidenceOptions {
  title?: string;
  rawCategory?: string;
  hintedCategory?: string;
  categoryMapping?: CategoryMapping;
  adapter?: CatalogAdapterLike;
}

export interface ListingCategoryEvidence {
  evidence: CategoryEvidenceInput[];
  policy: ResolvedCategoryPolicy;
}

// ---------------------------------------------------------------------------
// Feature facts (src/catalog/product-features.ts)
// ---------------------------------------------------------------------------

export type FeatureId = "dac" | "network_playback" | "headphone_output" | "phono_input";

export type FeatureState = "present" | "absent";

export interface FeatureDefinition {
  readonly id: FeatureId;
  readonly name: string;
  readonly order: number;
}

/** Loose input to `normalizeFeatureFacts()`; every field is re-validated/coerced. */
export interface FeatureFactInput {
  featureId?: string;
  state?: string;
  source?: string;
  confidence?: number;
  verifiedAt?: string | null;
}

/** Normalized fact. `source` is open (`"title"` and `"unknown"` are the only producers). */
export interface FeatureFact {
  featureId: FeatureId;
  state: FeatureState;
  source: string;
  /** Clamped to [0, 1]. */
  confidence: number;
  verifiedAt: string | null;
}

export interface InferFeatureFactsOptions {
  source?: string;
  confidence?: number;
  verifiedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Manufacturers (src/catalog/manufacturers.ts)
// ---------------------------------------------------------------------------

export interface ManufacturerDefinition {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
}

/** Source tuple shape of the `MANUFACTURERS` table: `[id, name, aliases]`. */
export type ManufacturerSourceEntry = readonly [
  id: string,
  name: string,
  aliases: readonly string[],
];

export interface PrefixAliasEntry {
  readonly manufacturer: ManufacturerDefinition;
  readonly alias: string;
  readonly key: string;
  readonly pattern: RegExp;
}

/** `id` is NOT a closed union: unknown brands get a synthesised `brand-<hash>` slug. */
export interface ManufacturerNormalizationResult {
  id: string;
  displayName: string;
  matchedAlias: boolean;
}

export interface ManufacturerModelSplit {
  id: string;
  displayName: string;
  rawManufacturer: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Catalog product pipeline
// ---------------------------------------------------------------------------

export type StockStatus = "in_stock" | "sold_out" | "unknown";

/**
 * Stage 1 — what a shop adapter's `parse()` returns, before normalization.
 *
 * `metadata`/`featureFacts`/`categoryEvidence`/`sourcePublishedAt`/`rawManufacturer`/
 * `rawCategory`/`category` are optional because adapters are heterogeneous: `parser.ts`
 * output and `ippinkan` omit several of them, and tests assert the exact key set of a
 * parsed product, so absent must stay absent (never `key: undefined`).
 */
export interface ShopParsedProduct {
  sourceId: string;
  manufacturer: string;
  rawManufacturer?: string;
  model: string;
  title: string;
  rawCategory?: string;
  /** Parser hint (a display label), not a category id. */
  category?: string;
  conditionText: string;
  priceYen: number | null;
  stockStatus: StockStatus;
  sourceUrl: string;
  sourcePublishedAt?: string | null;
  metadata?: Record<string, unknown>;
  featureFacts?: FeatureFactInput[];
  categoryEvidence?: CategoryEvidenceInput[];
}

/**
 * Stage 2 — `normalizeCatalogProduct()` output. This is what the crawler, the category
 * enricher and every repository see; `defineShopPlugin` guarantees `plugin.parse()`
 * returns this, never `ShopParsedProduct`.
 */
export interface NormalizedCatalogProduct extends CategoryClassificationFields {
  sourceId: string;
  /** Replaced by the manufacturer's canonical display name. */
  manufacturer: string;
  rawManufacturer: string;
  manufacturerId: string;
  model: string;
  title: string;
  rawCategory: string;
  conditionText: string;
  priceYen: number | null;
  stockStatus: StockStatus;
  sourceUrl: string;
  sourcePublishedAt?: string | null;
  featureFacts: FeatureFact[];
}

/**
 * Stage 3 — the loose input `upsertProducts()` accepts.
 *
 * Every catalog-derived field is optional because `catalogFields()` re-derives each one with
 * a fallback, and DB tests construct products by hand without
 * `featureFacts`/`metadata`/`categoryEvidence`.
 */
export interface CatalogProductUpsertInput {
  sourceId: string;
  manufacturer: string;
  rawManufacturer?: string;
  manufacturerId?: string;
  model: string;
  title: string;
  category?: string;
  rawCategory?: string;
  primaryCategoryId?: string;
  categoryIds?: readonly string[];
  classificationStatus?: ClassificationStatus;
  searchAliases?: string;
  conditionText: string;
  priceYen: number | null;
  stockStatus: StockStatus;
  sourceUrl: string;
  sourcePublishedAt?: string | null;
  metadata?: Record<string, unknown>;
  featureFacts?: FeatureFact[];
}

// ---------------------------------------------------------------------------
// Product identity (src/catalog/product-identity.ts)
// ---------------------------------------------------------------------------

export type IdentityStatus = "matched" | "unresolved";

export type IdentityConfidence = "high" | "medium" | "low" | "none";

export type IdentityMatchMethod =
  | "manufacturer_model_exact"
  | "catalog_alias"
  | "exact_ambiguous"
  | "alias_ambiguous"
  | "vetoed"
  | "fuzzy_candidate"
  | "fuzzy_ambiguous"
  | "unresolved"
  /** Written only by the 0017 backfill, never by `resolveProductIdentity`. */
  | "backfill_pending";

export type IdentityMatchedField =
  | "manufacturer_id"
  | "normalized_model"
  | "catalog_alias"
  | "model_stem";

export type IdentityRejectionRule =
  | "missing_identity_fields"
  | "ambiguous_candidates"
  | "variant_mismatch";

export interface IdentityModelParts {
  normalizedModel: string;
  modelStem: string;
  variants: string[];
}

export interface IdentityVeto {
  rule: "variant_mismatch";
  leftVariants: string[];
  rightVariants: string[];
}

/**
 * Listing side of `resolveProductIdentity`. Dual-cased on purpose: the repository passes a raw
 * snake_case D1 row while tests pass a camelCase object.
 */
export interface IdentityListingInput {
  manufacturerId?: string;
  manufacturer_id?: string;
  primaryCategoryId?: string;
  primary_category_id?: string;
  model?: string;
}

/** Catalog side of `resolveProductIdentity`. `id` must be numeric (candidates are sorted by it). */
export interface IdentityCandidateInput {
  id: number;
  manufacturerId?: string;
  manufacturer_id?: string;
  canonicalModel?: string;
  canonical_model?: string;
  model?: string;
  aliases?: readonly string[];
  categoryIds?: readonly string[];
  category_ids?: readonly string[];
}

/**
 * All seven branches carry the same keys, so one interface plus the `status` discriminant is
 * enough; narrow on `status === "matched"` when `catalogProductId` must be non-null.
 */
export interface ProductIdentityResolution {
  status: IdentityStatus;
  catalogProductId: number | null;
  candidateCatalogProductId: number | null;
  matchMethod: IdentityMatchMethod;
  confidence: IdentityConfidence;
  normalizedModel: string;
  modelStem: string;
  variants: string[];
  matchedFields: IdentityMatchedField[];
  rejectedBy: IdentityRejectionRule[];
  matchedAlias: string;
}

// ---------------------------------------------------------------------------
// Knowledge catalog (src/catalog/knowledge-catalog.ts)
// ---------------------------------------------------------------------------

export type KnowledgeCatalogMatchType = "exact" | "derived_alias" | "alias";

/** Verified catalog entry matched to a listing; `null` in the index means "ambiguous". */
export interface KnowledgeCatalogMatch {
  id: number;
  manufacturerId: string;
  canonicalModel: string;
  normalizedModel: string;
  canonicalName: string;
  categoryIds: string[];
  matchType: KnowledgeCatalogMatchType;
}

/**
 * Raw `products` listing row aggregated into catalog candidates. Every field is defensively read.
 *
 * Not to be confused with `KnowledgeCatalogCandidateRow` in `src/db/types.ts`, which is the
 * `knowledge_catalog_candidates` table row — a different table with a different shape.
 */
export interface KnowledgeCatalogListingRow {
  manufacturer_id?: string;
  manufacturer?: string;
  model?: string;
  title?: string;
  shop_key?: string;
  /** JSON string or already-parsed array. */
  category_ids?: string | readonly string[];
  classification_status?: string;
  first_seen_at?: string;
  last_seen_at?: string;
}

/** Mutable, Set-backed accumulator kept in the grouping `Map`. */
export interface KnowledgeCatalogCandidateAccumulator {
  manufacturerId: string;
  normalizedModel: string;
  observedManufacturer: string;
  observedModel: string;
  sampleTitle: string;
  listingCount: number;
  shops: Set<string>;
  categories: Set<string>;
  unclassifiedCount: number;
  otherCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Finalized aggregate before `priorityScore` is attached (the exact `candidatePriority` input). */
export interface KnowledgeCatalogCandidateAggregate {
  manufacturerId: string;
  normalizedModel: string;
  observedManufacturer: string;
  observedModel: string;
  sampleTitle: string;
  categoryIds: string[];
  listingCount: number;
  shopCount: number;
  unclassifiedCount: number;
  otherCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ScoredKnowledgeCatalogCandidate extends KnowledgeCatalogCandidateAggregate {
  priorityScore: number;
}

/** All-optional bag `candidatePriority()` accepts (tests call it with a bare object). */
export interface CandidatePriorityInput {
  unclassifiedCount?: number;
  otherCount?: number;
  shopCount?: number;
  listingCount?: number;
}

// ---------------------------------------------------------------------------
// Knowledge source verification (src/catalog/knowledge-source-verifier*.ts)
// ---------------------------------------------------------------------------

export type KnowledgeSourceType =
  | "manufacturer_official"
  | "official_distributor"
  | "manufacturer_archive"
  | "trusted_catalog"
  | "manual_verified";

export type KnowledgeSourceStatus =
  | "verified"
  | "not_found"
  | "ambiguous"
  | "unsupported"
  | "error";

/** Fields present on every verification result, whatever the status. */
export interface KnowledgeSourceVerificationBase {
  sourceUrl: string;
  /**
   * `""` on the "unsupported" branch, otherwise copied from the matching
   * `KnowledgeSourceDefinition`, so it is as unvalidated as that field is.
   */
  sourceType: string;
  httpStatus: number | null;
  /** Template-interpolated (`http_404`, `...:official_family_v5`); never a literal union. */
  message: string;
}

export interface VerifiedKnowledgeSource extends KnowledgeSourceVerificationBase {
  status: "verified";
  canonicalModel: string;
  canonicalName: string;
  categoryIds: CategoryId[];
  primaryCategoryId: CategoryId;
  /** 64 hex chars, or `""` when `crypto.subtle` is unavailable. */
  contentHash: string;
}

export interface FailedKnowledgeSource extends KnowledgeSourceVerificationBase {
  status: Exclude<KnowledgeSourceStatus, "verified">;
}

/** Discriminated on `status`: checking `status === "verified"` narrows to the rich variant. */
export type KnowledgeSourceVerification = VerifiedKnowledgeSource | FailedKnowledgeSource;

/**
 * Permissive candidate accepted by `verifyCandidate` and `verifyStoredSource` across all four
 * verifier versions. Every read is `?.`-guarded or `||`-chained.
 */
export interface KnowledgeSourceCandidate {
  id?: number;
  manufacturerId?: string;
  normalizedModel?: string;
  observedModel?: string;
  observedManufacturer?: string;
  model?: string;
  canonicalModel?: string;
  canonicalName?: string;
  primaryCategoryId?: string | null;
  categoryIds?: readonly string[];
  sampleTitle?: string;
  sourceId?: number;
  sourceUrl?: string;
  sourceType?: KnowledgeSourceType;
}

/** Raw registry entry (bundled defaults or `KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON`). */
export interface KnowledgeSourceDefinitionInput {
  manufacturerId?: string;
  sourceType?: string;
  baseUrl?: string;
  catalogUrls?: readonly string[];
  sitemapUrls?: readonly string[];
  searchUrlTemplate?: string;
  /** `false` removes the manufacturer entirely. */
  enabled?: boolean;
  /** `false` appends to the existing definitions instead of replacing them. */
  replace?: boolean;
}

export interface KnowledgeSourceDefinition {
  manufacturerId: string;
  adapter: "official_site";
  /**
   * Deliberately `string`, not `KnowledgeSourceType`: `normalizedSource()` copies whatever
   * `KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON` supplied without a membership check.
   */
  sourceType: string;
  baseUrl: string;
  catalogUrls: string[];
  sitemapUrls: string[];
  /** `""` when absent; supports `{model}` / `{manufacturer}` placeholders. */
  searchUrlTemplate: string;
}

/** Public surface shared by all four `createKnowledgeSourceVerifier*` factories. */
export interface KnowledgeSourceVerifier {
  verifyCandidate(candidate: KnowledgeSourceCandidate): Promise<KnowledgeSourceVerification>;
  verifyStoredSource(product: KnowledgeSourceCandidate): Promise<KnowledgeSourceVerification>;
  definitions: Map<string, KnowledgeSourceDefinition[]>;
}

export interface KnowledgeSourceVerifierOptions {
  fetchImpl?: typeof fetch;
  /** v3/v4 only. */
  fallbackEnabled?: boolean;
}

/** Internal HTTP helper result, duplicated in the v1/v2/v3 verifiers. */
export interface FetchTextResult {
  ok: boolean;
  /** `0` when the request threw. */
  status: number;
  url: string;
  text: string;
  /** Present only on the catch branch (`"timeout"` for an abort). */
  error?: string;
}
