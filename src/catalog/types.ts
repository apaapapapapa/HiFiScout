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

/** Non-classifiable grouping categories. */
export type CategoryGroupId =
  | "PER"
  | "SPK"
  | "AMP"
  | "SRC"
  | "ANA"
  | "PRC"
  | "SIG"
  | "CAB"
  | "PWR"
  | "ACC"
  | "SYS"
  | "REC";

/** Categories a product can actually be classified into. Some may also parent a more specific category. */
export type ClassifiableCategoryId =
  | "PER.HEADPHONE"
  | "PER.EARPHONE"
  | "SPK.LOUDSPEAKER"
  | "SPK.SUBWOOFER"
  | "SPK.SOUNDBAR"
  | "AMP.INTEGRATED"
  | "AMP.PRE"
  | "AMP.POWER"
  | "AMP.HEADPHONE"
  | "AMP.RECEIVER"
  | "AMP.PHONO"
  | "AMP.STEPUP"
  | "SRC.STREAMER"
  | "SRC.DAP"
  | "SRC.DISC"
  | "SRC.SERVER"
  | "SRC.TUNER"
  | "ANA.TURNTABLE"
  | "ANA.TONEARM"
  | "ANA.CARTRIDGE"
  | "ANA.STYLUS"
  | "ANA.HEADSHELL"
  | "ANA.TAPE"
  | "PRC.DAC"
  | "PRC.ADC"
  | "PRC.DDC"
  | "PRC.PROCESSOR"
  | "PRC.CLOCK"
  | "SIG.NETWORK"
  | "SIG.ISOLATOR"
  | "SIG.SELECTOR"
  | "SIG.WIRELESS"
  | "CAB.ANALOG"
  | "CAB.DIGITAL"
  | "CAB.SPEAKER"
  | "CAB.PERSONAL"
  | "CAB.DATA"
  | "CAB.ADAPTER"
  | "PWR.CORD"
  | "PWR.DISTRIBUTION"
  | "PWR.CONDITIONER"
  | "PWR.REGEN"
  | "PWR.SUPPLY"
  | "PWR.BATTERY"
  | "ACC.FURNITURE"
  | "ACC.STAND"
  | "ACC.ISOLATION"
  | "ACC.ACOUSTIC"
  | "ACC.WEAR"
  | "ACC.CASE"
  | "ACC.MAINTENANCE"
  | "ACC.TUBE"
  | "ACC.PART"
  | "SYS.MULTIFUNCTION"
  | "SYS.COMPLETE"
  | "REC.INTERFACE"
  | "REC.MIC"
  | "REC.MIXER"
  | "REC.RECORDER"
  | "REC.MICPRE"
  | "REC.MONITOR"
  | "REC.DJ";

/**
 * The answer "the classifier could not decide", which is not a category a product belongs to.
 *
 * It exists as its own id because `other` is a real, intentional leaf — tuners, equalizers,
 * channel dividers — and sharing one id made "we don't know" indistinguishable from "genuinely
 * miscellaneous" everywhere downstream, including the public category filter.
 */
export type UnclassifiedCategoryId = "unclassified";

/** Every id present in the taxonomy-v3 registry. */
export type CategoryId = CategoryGroupId | ClassifiableCategoryId | UnclassifiedCategoryId;

/**
 * Pre-taxonomy-v2 ids still accepted on input and rewritten by `LEGACY_ALIASES`.
 * They are NOT `CategoryId`s and must never be produced.
 */
export type LegacyCategoryAlias =
  | "amplifier"
  | "digital"
  | "analog"
  | "speaker"
  | "headphone_group"
  | "accessories"
  | "cable"
  | "integrated_amp"
  | "pre_amp"
  | "power_amp"
  | "headphone_amp"
  | "av_amp"
  | "dac"
  | "network_player"
  | "cd_sacd_player"
  | "transport"
  | "dap"
  | "network_switch"
  | "optical_isolator"
  | "router"
  | "music_server"
  | "master_clock"
  | "turntable"
  | "tonearm"
  | "cartridge"
  | "headshell"
  | "phono_eq"
  | "phono_step_up_transformer"
  | "speaker_bookshelf"
  | "speaker_floorstanding"
  | "center_speaker"
  | "subwoofer"
  | "active_speaker"
  | "wired_headphone"
  | "wired_earphone"
  | "btw_headphone"
  | "btw_earphone"
  | "cable_xlr"
  | "cable_rca"
  | "cable_phono"
  | "cable_usb"
  | "cable_lan"
  | "cable_digital"
  | "cable_power"
  | "cable_other"
  | "rack"
  | "power_strip"
  | "clean_power"
  | "vacuum_tube"
  | "other_accessory"
  | "dj_dtm"
  | "other"
  | "network_transport"
  | "cd_sacd_transport"
  | "accessory"
  | "speaker_other"
  | "headphone"
  | "earphone"
  | "power_accessory";

export type TaxonomyVersion = "v3";

export type LegacyCategoryMigrationStrategy = "deterministic" | "evidence" | "unclassified";

export interface LegacyCategoryMigrationRule {
  readonly legacyId: LegacyCategoryAlias;
  readonly strategy: LegacyCategoryMigrationStrategy;
  readonly categoryIds: readonly ClassifiableCategoryId[];
  readonly facetSelections: readonly FacetSelection[];
}

export interface CategoryDefinition {
  readonly id: CategoryId;
  readonly name: string;
  readonly parentId: CategoryId | null;
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
  readonly parentId: CategoryId | null;
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
 * legacy aliases (for compatibility), canonical ids and group ids, and a value may be an
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
  ruleId?: string;
  categoryIds?: readonly string[];
  categoryId?: string;
  source?: string;
  strength?: string;
  value?: string;
}

/** Item produced by the classifier's internal `normalizedEvidence()`, before filtering. */
export interface NormalizedCategoryEvidenceItem {
  ruleId?: string;
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
  ruleId?: string;
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
  /** Numeric certainty used by rollout quality gates. */
  confidence: number;
}

/** `metadata.categoryClassification` block written by `applyCategoryClassification`. */
export interface CategoryClassificationMetadata {
  version: number;
  taxonomyVersion: TaxonomyVersion;
  state: ClassificationState;
  status: ClassificationStatus;
  reason: ClassificationReason;
  source: ClassificationSource;
  categoryIds: CategoryId[];
  candidateCategoryIds: CategoryId[];
  evidence: CategoryEvidenceSummaryItem[];
  confidence: number;
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
  modelNormalization?: ModelNormalizationMetadata;
}

export interface ManufacturerNormalizationMetadata {
  version: number;
  matchedAlias: boolean;
  status?: ManufacturerResolutionStatus;
  method?: ManufacturerResolutionMethod;
  confidence?: ResolutionConfidence;
  normalizedRawManufacturer?: string;
  candidateManufacturerIds?: string[];
}

/** The twelve fields `applyCategoryClassification` writes onto a product. */
export interface CategoryClassificationFields {
  primaryCategoryId: CategoryId;
  /**
   * The single-product classification result — one category, as it has always been.
   *
   * Not the set. A listing that sells several products records that in `directCategoryIds`, so
   * that this field keeps meaning "which category did we classify this product into".
   */
  categoryIds: CategoryId[];
  /**
   * Every category this listing is *directly* in: one per distinct component product.
   *
   * `[primaryCategoryId]` for a listing that sells one product, which is nearly all of them.
   * Ordered by the canonical taxonomy so the card renders the same way on every replay.
   */
  directCategoryIds: CategoryId[];
  /** Display name of the resolved category (`classification.displayName`). */
  category: string;
  classificationStatus: ClassificationStatus;
  classificationState: ClassificationState;
  classificationReason: ClassificationReason;
  classificationSource: ClassificationSource;
  candidateCategoryIds: CategoryId[];
  searchAliases: string;
  classificationConfidence: number;
  categoryEvidence: CategoryEvidenceInput[];
  metadata: ProductMetadata & {
    categoryClassification: CategoryClassificationMetadata & Record<string, unknown>;
  };
}

/** Result of spreading `CategoryClassificationFields` over an arbitrary product shape. */
export type WithCategoryClassification<T> = Omit<T, keyof CategoryClassificationFields> &
  CategoryClassificationFields;

/** Minimum a value must satisfy to be passed through `applyCategoryClassification`. */
export interface CategoryClassifiableProduct {
  categoryEvidence?: CategoryEvidenceInput[];
  /**
   * One category id per detected component product, `unclassified` where a component named none.
   *
   * Survives re-classification because it describes the seller's text rather than any verdict
   * about it: the crawler's enricher re-applies a classification to an already-normalized product,
   * and the set it belongs to must not change just because a detail page was read.
   */
  componentCategoryIds?: readonly string[];
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

/** Catalog-owned normalization configuration supplied by the shop composition boundary. */
export interface CategoryNormalizationConfig {
  readonly categoryMapping?: CategoryMapping;
  readonly categoryPolicy?: CategoryPolicyInput;
}

export interface CollectListingCategoryEvidenceOptions {
  title?: string;
  rawCategory?: string;
  hintedCategory?: string;
  categoryMapping?: CategoryMapping;
  categoryPolicy?: CategoryPolicyInput;
}

export interface ListingCategoryEvidence {
  evidence: CategoryEvidenceInput[];
  policy: ResolvedCategoryPolicy;
}

// ---------------------------------------------------------------------------
// Product facets (orthogonal to primary category)
// ---------------------------------------------------------------------------

export type FacetId =
  | "connectivity"
  | "protocol"
  | "form_factor"
  | "channel_role"
  | "amplification_mode"
  | "use_case"
  | "connector_a"
  | "connector_b"
  | "signal_type"
  | "network_device_type"
  | "technology"
  | "application"
  | "processor_type"
  | "portability";

export interface FacetValueDefinition {
  readonly id: string;
  readonly name: string;
  readonly order: number;
}

export interface FacetDefinition {
  readonly id: FacetId;
  readonly name: string;
  readonly order: number;
  /** Empty means globally applicable; otherwise the UI reveals it for these category roots. */
  readonly categoryRootIds: readonly CategoryGroupId[];
  readonly values: readonly FacetValueDefinition[];
}

function facetValues(
  ...values: readonly (readonly [string, string])[]
): readonly FacetValueDefinition[] {
  return Object.freeze(
    values.map(([id, name], index) => Object.freeze({ id, name, order: index + 1 })),
  );
}

function facetGroups(...groups: readonly CategoryGroupId[]): readonly CategoryGroupId[] {
  return Object.freeze(groups);
}

export const FACET_DEFINITIONS: readonly FacetDefinition[] = Object.freeze([
  Object.freeze({
    id: "connectivity",
    name: "接続方式",
    order: 1,
    categoryRootIds: facetGroups("PER", "SPK", "SRC", "SIG"),
    values: facetValues(["wired", "有線"], ["wireless", "ワイヤレス"]),
  }),
  Object.freeze({
    id: "protocol",
    name: "通信規格",
    order: 2,
    categoryRootIds: facetGroups("PER", "SRC", "SIG", "CAB"),
    values: facetValues(["bluetooth", "Bluetooth"], ["wifi", "Wi-Fi"], ["ethernet", "Ethernet"]),
  }),
  Object.freeze({
    id: "form_factor",
    name: "形状",
    order: 3,
    categoryRootIds: facetGroups("SPK", "SYS"),
    values: facetValues(
      ["bookshelf", "ブックシェルフ"],
      ["floorstanding", "フロア型"],
      ["desktop", "デスクトップ"],
      ["one_box", "一体型"],
    ),
  }),
  Object.freeze({
    id: "channel_role",
    name: "チャンネル用途",
    order: 4,
    categoryRootIds: facetGroups("SPK"),
    values: facetValues(["center", "センター"], ["surround", "サラウンド"]),
  }),
  Object.freeze({
    id: "amplification_mode",
    name: "増幅方式",
    order: 5,
    categoryRootIds: facetGroups("SPK"),
    values: facetValues(["active", "アクティブ"], ["passive", "パッシブ"]),
  }),
  Object.freeze({
    id: "use_case",
    name: "用途",
    order: 6,
    categoryRootIds: facetGroups(),
    values: facetValues(
      ["home", "ホーム"],
      ["studio", "スタジオ"],
      ["dj", "DJ"],
      ["pa", "PA / SR"],
    ),
  }),
  Object.freeze({
    id: "connector_a",
    name: "端子A",
    order: 7,
    categoryRootIds: facetGroups("CAB"),
    values: facetValues(
      ["xlr", "XLR"],
      ["rca", "RCA"],
      ["usb", "USB"],
      ["ethernet", "Ethernet"],
      ["hdmi", "HDMI"],
      ["optical", "光"],
      ["coaxial", "同軸"],
    ),
  }),
  Object.freeze({
    id: "connector_b",
    name: "端子B",
    order: 8,
    categoryRootIds: facetGroups("CAB"),
    values: facetValues(
      ["xlr", "XLR"],
      ["rca", "RCA"],
      ["usb", "USB"],
      ["ethernet", "Ethernet"],
      ["hdmi", "HDMI"],
      ["optical", "光"],
      ["coaxial", "同軸"],
    ),
  }),
  Object.freeze({
    id: "signal_type",
    name: "信号種別",
    order: 9,
    categoryRootIds: facetGroups("CAB"),
    values: facetValues(
      ["analog", "アナログ"],
      ["digital", "デジタル"],
      ["data", "データ"],
      ["speaker", "スピーカー"],
      ["power", "電源"],
    ),
  }),
  Object.freeze({
    id: "network_device_type",
    name: "ネットワーク機器",
    order: 10,
    categoryRootIds: facetGroups("SIG"),
    values: facetValues(["switch", "スイッチ"], ["router", "ルーター"], ["bridge", "ブリッジ"]),
  }),
  Object.freeze({
    id: "technology",
    name: "技術方式",
    order: 11,
    categoryRootIds: facetGroups("AMP", "PWR", "ACC"),
    values: facetValues(
      ["tube", "真空管"],
      ["solid_state", "ソリッドステート"],
      ["class_d", "Class-D"],
      ["transformer", "トランス"],
    ),
  }),
  Object.freeze({
    id: "application",
    name: "用途領域",
    order: 12,
    categoryRootIds: facetGroups("CAB", "AMP"),
    values: facetValues(["phono", "フォノ"]),
  }),
  Object.freeze({
    id: "processor_type",
    name: "処理種別",
    order: 13,
    categoryRootIds: facetGroups("PRC"),
    values: facetValues(
      ["room_correction", "ルーム補正"],
      ["equalizer", "イコライザー"],
      ["crossover", "クロスオーバー"],
      ["av", "AV処理"],
    ),
  }),
  Object.freeze({
    id: "portability",
    name: "可搬性",
    order: 14,
    categoryRootIds: facetGroups("PER", "SRC", "SPK"),
    values: facetValues(["portable", "ポータブル"], ["battery_powered", "バッテリー駆動"]),
  }),
]);

const FACET_BY_ID = new Map(FACET_DEFINITIONS.map((facet) => [facet.id, facet]));

export function isFacetId(value: unknown): value is FacetId {
  return typeof value === "string" && FACET_BY_ID.has(value as FacetId);
}

export function isFacetValue(facetId: FacetId, value: unknown): boolean {
  return (
    typeof value === "string" &&
    Boolean(FACET_BY_ID.get(facetId)?.values.some((candidate) => candidate.id === value))
  );
}

export interface FacetSelection {
  facetId: FacetId;
  value: string;
}

export interface FacetFactInput {
  facetId?: string;
  value?: string;
  source?: string;
  confidence?: number;
  verifiedAt?: string | null;
}

export interface FacetFact {
  facetId: FacetId;
  value: string;
  source: string;
  confidence: number;
  verifiedAt: string | null;
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

/**
 * The feature vocabulary, in display order.
 *
 * It lives beside {@link FeatureId} rather than with the inference rules because it is the set of
 * accepted `?feature=` values as much as it is a crawl concern: the query validator, the filter UI
 * and the fact writer all have to agree on it, and a list repeated for any of them would let a new
 * feature ship in one place and not another.
 */
export const FEATURE_DEFINITIONS: readonly FeatureDefinition[] = Object.freeze([
  Object.freeze({ id: "dac", name: "DAC搭載", order: 1 }),
  Object.freeze({ id: "network_playback", name: "ネットワーク対応", order: 2 }),
  Object.freeze({ id: "headphone_output", name: "ヘッドホン出力", order: 3 }),
  Object.freeze({ id: "phono_input", name: "フォノ入力", order: 4 }),
]);

/** Product capabilities retain the existing feature-fact storage and query contract. */
export type CapabilityId = FeatureId;
export const CAPABILITY_DEFINITIONS = FEATURE_DEFINITIONS;

const FEATURE_IDS = new Set<string>(FEATURE_DEFINITIONS.map((feature) => feature.id));

/** Narrows an untrusted feature id against the vocabulary above. */
export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === "string" && FEATURE_IDS.has(value);
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
// Presentation colors (src/catalog/model-presentation-color.ts)
// ---------------------------------------------------------------------------

/**
 * One finish and every seller spelling of it. `order` is display order, not precedence.
 *
 * `codes` are the short forms (`BK`, `S`), separated from `aliases` because they are ambiguous
 * enough that the match patterns only accept them behind explicit presentation syntax.
 */
export interface PresentationColorDefinition {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly codes: readonly string[];
  readonly order: number;
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

/** Shared by every resolution stage: canonical, needs review, or no usable evidence. */
export type ResolutionStatus = "resolved" | "candidate" | "unresolved";

export type ManufacturerResolutionStatus = ResolutionStatus;

export type ManufacturerResolutionMethod =
  | "verified_alias"
  | "bootstrap_alias"
  | "title_verified_alias"
  | "title_bootstrap_alias"
  | "ambiguous_alias"
  | "unverified_alias"
  | "none";

export type ResolutionConfidence = "high" | "medium" | "low" | "none";

export type ManufacturerVerificationStatus = "pending" | "verified" | "rejected";

/** D1-backed alias evidence passed into the pure manufacturer resolver. */
export interface ManufacturerAliasEvidence {
  manufacturerId: string;
  canonicalName: string;
  alias: string;
  normalizedAlias: string;
  verificationStatus: ManufacturerVerificationStatus;
  source: string;
  ruleVersion: number;
}

export interface ManufacturerResolutionInput {
  rawManufacturer?: unknown;
  manufacturerCandidate?: unknown;
  title?: unknown;
}

export interface ManufacturerResolutionResult {
  canonicalManufacturerId: string;
  displayName: string;
  normalizedRawManufacturer: string;
  status: ManufacturerResolutionStatus;
  method: ManufacturerResolutionMethod;
  confidence: ResolutionConfidence;
  matchedAlias: boolean;
  candidateManufacturerIds: string[];
}

export interface ManufacturerModelSplit {
  id: string;
  displayName: string;
  rawManufacturer: string;
  model: string;
}

export type ModelResolutionMethod =
  | "seller_model"
  | "seller_model_annotated"
  | "title_after_manufacturer"
  | "unsafe_annotation"
  | "none";

/**
 * Model Resolution runs after Manufacturer Resolution: a resolved manufacturer is what makes
 * presentation-token removal and title extraction safe.
 */
export interface ModelResolutionInput {
  rawModel?: unknown;
  title?: unknown;
  manufacturerId?: unknown;
  /** Seller identity used only by explicitly scoped annotation rules. */
  shopKey?: unknown;
}

export interface ModelResolutionResult {
  /** Immutable seller presentation, never replaced by a normalized or canonical value. */
  rawModel: string;
  /** Display model after conservative annotation removal. */
  model: string;
  /** Deterministic search/identity representation. */
  normalizedModel: string;
  status: ResolutionStatus;
  method: ModelResolutionMethod;
  confidence: ResolutionConfidence;
  /** Rule names that removed something, for audit. */
  removedAnnotations: string[];
  /** Residue that could not be classified as merchandising, so it was kept rather than deleted. */
  unclassifiedTokens: string[];
  /**
   * Canonical finish labels the annotation rules removed, left to right.
   *
   * Deliberately not part of `model`: the finish is what keeps two colors of one product from
   * grouping, so it travels beside the model instead of inside it. Empty when the removal was
   * rolled back by the identity guard — a finish is only reported when it was actually taken out.
   */
  presentationColors: string[];
}

export interface ModelNormalizationMetadata {
  version: number;
  status: ResolutionStatus;
  method: ModelResolutionMethod;
  confidence: ResolutionConfidence;
  normalizedModel: string;
  removedAnnotations: string[];
  unclassifiedTokens: string[];
  /** Canonical finish labels taken out of the model, kept as the evidence behind the stored one. */
  presentationColors?: string[];
}

// ---------------------------------------------------------------------------
// Catalog product pipeline
// ---------------------------------------------------------------------------

export type StockStatus = "in_stock" | "sold_out" | "unknown";

/**
 * Catalog normalization input. Seller adapters use the stricter crawler-owned `SellerProduct`
 * contract; other catalog callers may omit raw evidence that is unavailable to them.
 */
export interface CatalogNormalizationInput {
  sourceId: string;
  manufacturer: string;
  rawManufacturer?: string;
  rawModel?: string;
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
  facetFacts?: FacetFactInput[];
  categoryEvidence?: CategoryEvidenceInput[];
}

/**
 * Stage 2 — `normalizeCatalogProduct()` output. This is what the crawler, the category
 * enricher and every repository see; `defineShopPlugin` guarantees `plugin.parse()`
 * returns this, never an unnormalized seller product.
 */
export interface NormalizedCatalogProduct extends CategoryClassificationFields {
  sourceId: string;
  /** Replaced by the manufacturer's canonical display name. */
  manufacturer: string;
  rawManufacturer: string;
  normalizedRawManufacturer: string;
  manufacturerId: string;
  manufacturerResolutionStatus: ManufacturerResolutionStatus;
  manufacturerResolutionMethod: ManufacturerResolutionMethod;
  manufacturerResolutionConfidence: ResolutionConfidence;
  model: string;
  rawModel: string;
  normalizedModel: string;
  /**
   * Canonical finish label, or `""` when the listing named none.
   *
   * Beside the model rather than inside it: identity must not see it, or two colors of one product
   * stop grouping — but the shopper must, or the finish the seller wrote just disappears.
   */
  presentationColor: string;
  modelResolutionStatus: ResolutionStatus;
  modelResolutionMethod: ModelResolutionMethod;
  modelResolutionConfidence: ResolutionConfidence;
  title: string;
  rawCategory: string;
  /**
   * One category id per detected component product — declared rather than incidental, because the
   * crawler's enricher re-classifies an already-normalized product and `applyCategoryClassification`
   * reads this to rebuild the set. A product that lost it would silently collapse to one category.
   */
  componentCategoryIds: readonly string[];
  conditionText: string;
  priceYen: number | null;
  stockStatus: StockStatus;
  sourceUrl: string;
  sourcePublishedAt?: string | null;
  featureFacts: FeatureFact[];
  facetFacts: FacetFact[];
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
  normalizedRawManufacturer?: string;
  manufacturerId?: string;
  manufacturerResolutionStatus?: ManufacturerResolutionStatus;
  manufacturerResolutionMethod?: ManufacturerResolutionMethod;
  manufacturerResolutionConfidence?: ResolutionConfidence;
  model: string;
  rawModel?: string;
  normalizedModel?: string;
  presentationColor?: string;
  modelResolutionStatus?: ResolutionStatus;
  modelResolutionMethod?: ModelResolutionMethod;
  modelResolutionConfidence?: ResolutionConfidence;
  modelResolverVersion?: number;
  title: string;
  category?: string;
  rawCategory?: string;
  primaryCategoryId?: string;
  categoryIds?: readonly string[];
  /** Absent for hand-built test products and legacy callers; falls back to the primary category. */
  directCategoryIds?: readonly string[];
  classificationStatus?: ClassificationStatus;
  searchAliases?: string;
  conditionText: string;
  priceYen: number | null;
  stockStatus: StockStatus;
  sourceUrl: string;
  sourcePublishedAt?: string | null;
  metadata?: Record<string, unknown>;
  featureFacts?: FeatureFact[];
  facetFacts?: FacetFact[];
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
  | "variant_mismatch"
  | "sale_subject_mismatch"
  | "bundle_identity"
  /** Model Resolution could not fully classify the model, so it may not attach to a product. */
  | "unresolved_model";

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
  title?: string;
  rawModel?: string;
  raw_model?: string;
  manufacturerId?: string;
  manufacturer_id?: string;
  primaryCategoryId?: string;
  primary_category_id?: string;
  model?: string;
  /**
   * Model Resolution's verdict on `model`. Absent means "already resolved" so pre-existing callers
   * and fixtures keep their behavior; `candidate`/`unresolved` blocks automatic attachment.
   */
  modelResolutionStatus?: ResolutionStatus;
  model_resolution_status?: ResolutionStatus;
}

/** Catalog side of `resolveProductIdentity`. `id` must be numeric (candidates are sorted by it). */
export interface IdentityCandidateInput {
  /** Bounded discovery candidates cannot authorize an automatic exact/alias match. */
  fuzzyOnly?: boolean;
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
  raw_model?: string;
  title?: string;
  shop_key?: string;
  source_url?: string;
  /** JSON string or already-parsed array. */
  category_ids?: string | readonly string[];
  classification_status?: string;
  /** Current Product Identity state, so a candidate can explain why it is still unresolved. */
  identity_status?: string;
  identity_match_method?: string;
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
  rawModelVariants: Set<string>;
  sourceUrls: Set<string>;
  identityRejectionReasons: Map<string, number>;
  unclassifiedCount: number;
  otherCount: number;
  unresolvedIdentityCount: number;
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
  /** Bounded, deterministic sample of the seller presentations seen for this key. */
  rawModelVariants: string[];
  /** Bounded, deterministic sample of listing URLs a reviewer can open as evidence. */
  sourceUrls: string[];
  /** The most common reason Product Identity currently refuses to match this group. */
  identityRejectionReason: string;
  listingCount: number;
  shopCount: number;
  unclassifiedCount: number;
  otherCount: number;
  unresolvedIdentityCount: number;
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
  unresolvedIdentityCount?: number;
  shopCount?: number;
  listingCount?: number;
}

// Knowledge source verification types live beside their implementation, in
// `src/catalog/knowledge-verification/types.ts`.
