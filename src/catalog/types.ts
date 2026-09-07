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
 * It is an internal sentinel, never a public catch-all category. Legacy `other` is accepted only
 * as an evidence-dependent compatibility input; tuners and processors have their own leaves.
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
  /** Shop-local extractor semantics used for the detail decision; absent means version 1. */
  detailExtractorVersion?: number;
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
 * The caller-facing patch of `applyCategoryClassification`: only the keys the enrichment
 * passes actually add, so a typo or a wrong value type is rejected instead of persisted.
 */
export type CategoryClassificationMetadataOverrides = Partial<
  Pick<
    CategoryClassificationMetadata,
    | "detailCheckedAt"
    | "detailExtractorVersion"
    | "catalogProductId"
    | "catalogMatchType"
    | "catalogMatchedAt"
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
  | "portability"
  | "acoustic_design"
  | "cartridge_type"
  | "phono_support"
  | "supported_media"
  | "cable_length"
  | "part_type"
  | "target_equipment";

export interface FacetValueDefinition {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  /** Optional UI scope, using registry ancestry rather than ID prefixes. */
  readonly categoryIds?: readonly CategoryId[];
}

export interface FacetDefinition {
  readonly id: FacetId;
  readonly name: string;
  readonly order: number;
  /** Empty means globally applicable; otherwise the UI reveals it for these category roots. */
  readonly categoryRootIds: readonly CategoryGroupId[];
  /** When present, replaces the broad root scope with specific roots/leaves for the UI. */
  readonly categoryIds?: readonly CategoryId[];
  readonly values: readonly FacetValueDefinition[];
}

function facetValues(
  ...values: readonly (readonly [string, string, (readonly CategoryId[])?])[]
): readonly FacetValueDefinition[] {
  return Object.freeze(
    values.map(([id, name, categoryIds], index) =>
      Object.freeze({ id, name, order: index + 1, ...(categoryIds ? { categoryIds } : {}) }),
    ),
  );
}

function facetGroups(...groups: readonly CategoryGroupId[]): readonly CategoryGroupId[] {
  return Object.freeze(groups);
}

function facetCategories(...categories: readonly CategoryId[]): readonly CategoryId[] {
  return Object.freeze(categories);
}

const CONNECTOR_VALUES = facetValues(
  ["xlr", "XLR"],
  ["rca", "RCA"],
  ["2_5mm", "2.5mm"],
  ["3_5mm", "3.5mm"],
  ["4_4mm", "4.4mm"],
  ["6_3mm", "6.3mm"],
  ["usb", "USB（形状不明）"],
  ["usb_a", "USB Type-A"],
  ["usb_b", "USB Type-B"],
  ["usb_c", "USB Type-C"],
  ["ethernet", "Ethernet / RJ45"],
  ["hdmi", "HDMI"],
  ["optical", "光"],
  ["coaxial", "同軸（形状不明）"],
  ["bnc", "BNC"],
  ["mmcx", "MMCX"],
  ["two_pin", "2ピン"],
  ["banana", "バナナ"],
  ["spade", "Yラグ"],
);

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
    categoryRootIds: facetGroups("PER", "SPK", "SYS"),
    values: facetValues(
      ["bookshelf", "ブックシェルフ", ["SPK.LOUDSPEAKER"]],
      ["floorstanding", "フロア型", ["SPK.LOUDSPEAKER"]],
      ["desktop", "デスクトップ", ["SPK.LOUDSPEAKER", "SYS"]],
      ["one_box", "一体型", ["SPK.LOUDSPEAKER", "SYS"]],
      ["true_wireless", "完全ワイヤレス", ["PER.EARPHONE"]],
      ["over_ear", "オーバーイヤー", ["PER.HEADPHONE"]],
      ["on_ear", "オンイヤー", ["PER.HEADPHONE"]],
      ["in_ear", "カナル型", ["PER.EARPHONE"]],
      ["open_ear", "オープンイヤー", ["PER"]],
    ),
  }),
  Object.freeze({
    id: "channel_role",
    name: "チャンネル用途",
    order: 4,
    categoryRootIds: facetGroups("SPK"),
    categoryIds: facetCategories("SPK.LOUDSPEAKER"),
    values: facetValues(["center", "センター"], ["surround", "サラウンド"]),
  }),
  Object.freeze({
    id: "amplification_mode",
    name: "増幅方式",
    order: 5,
    categoryRootIds: facetGroups("SPK"),
    categoryIds: facetCategories("SPK.LOUDSPEAKER", "SPK.SUBWOOFER"),
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
    values: CONNECTOR_VALUES,
  }),
  Object.freeze({
    id: "connector_b",
    name: "端子B",
    order: 8,
    categoryRootIds: facetGroups("CAB"),
    values: CONNECTOR_VALUES,
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
    categoryIds: facetCategories("SIG.NETWORK"),
    values: facetValues(["switch", "スイッチ"], ["router", "ルーター"], ["bridge", "ブリッジ"]),
  }),
  Object.freeze({
    id: "technology",
    name: "技術方式",
    order: 11,
    categoryRootIds: facetGroups("AMP", "PWR", "ACC"),
    values: facetValues(
      ["tube", "真空管", ["AMP", "ACC.TUBE"]],
      ["solid_state", "ソリッドステート", ["AMP"]],
      ["class_d", "Class-D", ["AMP.INTEGRATED", "AMP.POWER", "AMP.HEADPHONE", "AMP.RECEIVER"]],
      ["transformer", "トランス", ["AMP.STEPUP", "PWR"]],
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
    categoryIds: facetCategories("PRC.PROCESSOR"),
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
    categoryIds: facetCategories("PER", "SRC", "SPK", "AMP.HEADPHONE"),
    values: facetValues(
      ["portable", "ポータブル"],
      ["stationary", "据置型"],
      ["battery_powered", "バッテリー駆動"],
    ),
  }),
  Object.freeze({
    id: "acoustic_design",
    name: "音響構造",
    order: 15,
    categoryRootIds: facetGroups("PER"),
    values: facetValues(
      ["open_back", "開放型"],
      ["closed_back", "密閉型"],
      ["semi_open", "半開放型"],
    ),
  }),
  Object.freeze({
    id: "cartridge_type",
    name: "カートリッジ方式",
    order: 16,
    categoryRootIds: facetGroups("ANA"),
    categoryIds: facetCategories("ANA.CARTRIDGE", "ANA.STYLUS"),
    values: facetValues(["mm", "MM"], ["mc", "MC"], ["mi", "MI"]),
  }),
  Object.freeze({
    id: "phono_support",
    name: "フォノ入力対応",
    order: 17,
    categoryRootIds: facetGroups("AMP"),
    categoryIds: facetCategories(
      "AMP.INTEGRATED",
      "AMP.PRE",
      "AMP.RECEIVER",
      "AMP.PHONO",
      "AMP.STEPUP",
    ),
    values: facetValues(["mm", "MM対応"], ["mc", "MC対応"]),
  }),
  Object.freeze({
    id: "supported_media",
    name: "対応メディア",
    order: 18,
    categoryRootIds: facetGroups("SRC", "REC"),
    categoryIds: facetCategories("SRC.DISC", "SRC.SERVER", "ANA.TAPE", "REC.RECORDER"),
    values: facetValues(
      ["cd", "CD", ["SRC.DISC", "SRC.SERVER", "REC.RECORDER"]],
      ["sacd", "SACD", ["SRC.DISC", "REC.RECORDER"]],
      ["dvd", "DVD", ["SRC.DISC", "REC.RECORDER"]],
      ["blu_ray", "Blu-ray", ["SRC.DISC", "REC.RECORDER"]],
      ["md", "MD", ["SRC.DISC", "REC.RECORDER"]],
      ["ld", "LD", ["SRC.DISC", "REC.RECORDER"]],
      ["cassette", "カセット", ["ANA.TAPE", "REC.RECORDER"]],
      ["open_reel", "オープンリール", ["ANA.TAPE", "REC.RECORDER"]],
      ["dat", "DAT", ["ANA.TAPE", "REC.RECORDER"]],
      ["dcc", "DCC", ["ANA.TAPE", "REC.RECORDER"]],
    ),
  }),
  Object.freeze({
    id: "cable_length",
    name: "ケーブル長",
    order: 19,
    categoryRootIds: facetGroups("CAB", "PWR"),
    categoryIds: facetCategories("CAB", "PWR.CORD"),
    values: facetValues(
      ["under_1m", "1m未満"],
      ["1_to_2m", "1m以上・2m未満"],
      ["2_to_3m", "2m以上・3m未満"],
      ["3_to_5m", "3m以上・5m未満"],
      ["5m_plus", "5m以上"],
    ),
  }),
  Object.freeze({
    id: "part_type",
    name: "部品種別",
    order: 20,
    categoryRootIds: facetGroups("ACC"),
    categoryIds: facetCategories("ACC.PART"),
    values: facetValues(
      ["driver", "スピーカーユニット"],
      ["tweeter", "ツイーター"],
      ["horn", "ホーン"],
      ["enclosure", "エンクロージャー"],
      ["terminal", "端子"],
      ["knob", "ノブ"],
      ["board", "基板"],
      ["remote", "リモコン"],
    ),
  }),
  Object.freeze({
    id: "target_equipment",
    name: "対象機器",
    order: 21,
    categoryRootIds: facetGroups("ACC"),
    values: facetValues(
      ["speaker", "スピーカー"],
      ["headphone", "ヘッドホン"],
      ["earphone", "イヤホン"],
      ["amplifier", "アンプ"],
      ["disc_player", "ディスク機器"],
      ["turntable", "レコードプレーヤー"],
      ["tape_deck", "テープデッキ"],
    ),
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

export type FeatureId =
  | "dac"
  | "network_playback"
  | "headphone_output"
  | "phono_input"
  | "recording";

export type FeatureState = "present" | "absent";
/** Unknown means no evidence or contradictory evidence; it is never inferred as absent. */
export type ResolvedFeatureState = FeatureState | "unknown";
export type FeatureFilter = FeatureId | `${FeatureId}:absent` | `${FeatureId}:unknown`;

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
  Object.freeze({ id: "recording", name: "録音機能", order: 5 }),
]);

/** Product capabilities retain the existing feature-fact storage and query contract. */
export type CapabilityId = FeatureId;
export const CAPABILITY_DEFINITIONS = FEATURE_DEFINITIONS;

const FEATURE_IDS = new Set<string>(FEATURE_DEFINITIONS.map((feature) => feature.id));

/** Narrows an untrusted feature id against the vocabulary above. */
export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === "string" && FEATURE_IDS.has(value);
}

export function parseFeatureFilter(
  value: string,
): { featureId: FeatureId; state: ResolvedFeatureState } | null {
  const [featureId, state = "present", extra] = value.split(":");
  return isFeatureId(featureId) &&
    extra === undefined &&
    ((state === "present" && !value.includes(":")) || state === "absent" || state === "unknown")
    ? { featureId, state }
    : null;
}

export function isFeatureFilter(value: unknown): value is FeatureFilter {
  return typeof value === "string" && parseFeatureFilter(value) !== null;
}

export const FEATURE_FILTER_DEFINITIONS: readonly { id: FeatureFilter; name: string }[] =
  Object.freeze(
    FEATURE_DEFINITIONS.flatMap((feature) => [
      { id: feature.id, name: feature.name },
      { id: `${feature.id}:absent` as const, name: `${feature.name}: 非搭載` },
      { id: `${feature.id}:unknown` as const, name: `${feature.name}: 不明` },
    ]),
  );

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

/** Display groups are shared by public comparison, filters and the listing editor. */
export const OFFER_FACT_GROUPS = [
  { id: "condition", name: "販売区分" },
  { id: "appearance", name: "外観" },
  { id: "operation", name: "動作" },
  { id: "included", name: "付属品" },
  { id: "warranty", name: "保証" },
  { id: "maintenance", name: "整備・修理・改造歴" },
  { id: "sale_unit", name: "販売単位" },
  { id: "voltage", name: "電源電圧" },
  { id: "option", name: "搭載オプション" },
] as const;

/** Seller-observed facts belong to a listing, independently of catalog capabilities. */
export const OFFER_FACT_DEFINITIONS = [
  { id: "unused", name: "未使用品", group: "condition" },
  { id: "display", name: "展示品", group: "condition" },
  { id: "outlet", name: "アウトレット", group: "condition" },
  { id: "used", name: "中古品", group: "condition" },
  { id: "junk", name: "ジャンク", group: "condition" },
  { id: "appearance_clean", name: "目立つ傷なし", group: "appearance" },
  { id: "appearance_wear", name: "傷・汚れあり", group: "appearance" },
  { id: "operation_confirmed", name: "動作確認済み", group: "operation" },
  { id: "operation_unchecked", name: "動作未確認", group: "operation" },
  { id: "operation_fault", name: "動作不良あり", group: "operation" },
  { id: "original_box", name: "元箱", group: "included" },
  { id: "remote_control", name: "リモコン", group: "included" },
  { id: "manual", name: "取扱説明書", group: "included" },
  { id: "shop_warranty", name: "販売店保証", group: "warranty" },
  { id: "manufacturer_warranty", name: "メーカー保証", group: "warranty" },
  { id: "maintenance_serviced", name: "整備済み", group: "maintenance" },
  { id: "maintenance_repaired", name: "修理歴あり", group: "maintenance" },
  { id: "maintenance_modified", name: "改造歴あり", group: "maintenance" },
  { id: "sale_pair", name: "ペア販売", group: "sale_unit" },
  { id: "sale_single", name: "単体販売", group: "sale_unit" },
  { id: "sale_set", name: "セット販売", group: "sale_unit" },
  { id: "voltage_100v", name: "AC 100V", group: "voltage" },
  { id: "voltage_115v", name: "AC 115V", group: "voltage" },
  { id: "voltage_120v", name: "AC 120V", group: "voltage" },
  { id: "voltage_220v", name: "AC 220V", group: "voltage" },
  { id: "voltage_230v", name: "AC 230V", group: "voltage" },
  { id: "voltage_240v", name: "AC 240V", group: "voltage" },
  { id: "voltage_switchable", name: "電源電圧切替式", group: "voltage" },
  { id: "option_dac", name: "DACボード搭載", group: "option" },
  { id: "option_phono", name: "フォノボード搭載", group: "option" },
  { id: "option_network", name: "ネットワークボード搭載", group: "option" },
] as const;

export type OfferFactId = (typeof OFFER_FACT_DEFINITIONS)[number]["id"];
export type OfferFactState = "present" | "absent" | "unknown";
export type OfferFactSource = "seller" | "manual";

export interface OfferFact {
  factId: OfferFactId;
  state: OfferFactState;
  source: OfferFactSource;
  sourceField: "title" | "condition_text" | "manual";
  ruleId: string;
  confidence: number;
  observedAt: string;
}

export function isOfferFactId(value: unknown): value is OfferFactId {
  return typeof value === "string" && OFFER_FACT_DEFINITIONS.some((fact) => fact.id === value);
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
  /** Individually scoped identity evidence; never interpreted as a single catalog product. */
  bundleComponents?: {
    segment: string;
    manufacturerId: string;
    manufacturer: string;
    model: string;
    presentationColors: string[];
  }[];
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
  bundleComponents?: ModelResolutionResult["bundleComponents"];
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
export interface ModelFactInput {
  kind: "successor" | "variant" | "family";
  relatedProductId: number | null;
  familyName: string;
  position: number | null;
  state: "candidate" | "verified" | "rejected" | "removed";
  sourceId: number | null;
  manualNote: string;
  manufacturerJustification: string;
}

export interface ModelFactWriteInput {
  id: string | null;
  expectedVersion: number | null;
  reverify: boolean;
  fact: ModelFactInput;
}

export interface AdminModelFact {
  id: string;
  version: number;
  productId: number;
  productName: string;
  relatedProductName: string | null;
  input: ModelFactInput;
  reviewState: ModelFactInput["state"] | "due";
  sourceUrl: string;
  verifiedAt: string | null;
  reviewDueAt: string | null;
}

export interface ModelFactsAdminSnapshot {
  product: { id: number; name: string; manufacturerId: string };
  facts: AdminModelFact[];
  sources: {
    id: number;
    sourceType: string;
    url: string;
    status: string;
    retrievedAt: string | null;
  }[];
  audits: { id: number; actor: string; occurredAt: string; before: unknown; after: unknown }[];
}
export interface CatalogRelationProof {
  kind: "source" | "manual";
  sourceUrl: string | null;
  verifiedAt: string;
}

export interface RelatedCatalogModel {
  key: string;
  manufacturer: string;
  model: string;
  proof: CatalogRelationProof;
}

export interface ProductModelRelations {
  links: (RelatedCatalogModel & { kind: "predecessor" | "successor" | "variant" })[];
  families: {
    name: string;
    position: number | null;
    proof: CatalogRelationProof;
    members: (RelatedCatalogModel & { position: number | null })[];
  }[];
}

/** Bounded, source-backed model specifications shared by HTTP and admin forms. */
export interface SpecificationPort {
  connector: string;
  /** Number of signal systems, not individual RCA sockets. Null means unrecorded. */
  count: number | null;
}

export interface CatalogSpecifications {
  widthMm: number | null;
  heightMm: number | null;
  depthMm: number | null;
  weightKg: number | null;
  /** Null means unrecorded; an empty array explicitly means no ports. */
  inputs: SpecificationPort[] | null;
  outputs: SpecificationPort[] | null;
  main: { name: string; value: string }[];
  sourceUrl: string;
}

export interface CatalogSpecificationRecord extends CatalogSpecifications {
  updatedAt: string;
}
