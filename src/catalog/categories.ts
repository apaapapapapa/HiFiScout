import { inferExplicitCategoryIds } from "./category-rules.js";
import type {
  CategoryDefinition,
  CategoryFacet,
  CategoryGroupId,
  CategoryId,
  CategoryMapping,
  CategoryNormalizationSource,
  ClassifiableCategoryId,
  FacetSelection,
  LegacyCategoryAlias,
  LegacyCategoryMigrationRule,
  NormalizeCategoryOptions,
  NormalizeCategoryResult,
  TaxonomyVersion,
} from "./types.js";

export const TAXONOMY_VERSION: TaxonomyVersion = "v3";
export const UNCLASSIFIED_CATEGORY_ID = "unclassified" as const;

export function isUnclassifiedCategoryId(value: string): boolean {
  return value === UNCLASSIFIED_CATEGORY_ID;
}

type AuthoredCategory = Omit<CategoryDefinition, "selectable">;

function root(id: CategoryGroupId, name: string, order: number): AuthoredCategory {
  return { id, name, parentId: null, order, classifiable: false, filterable: true, aliases: [] };
}

function leaf(
  id: ClassifiableCategoryId,
  name: string,
  parentId: CategoryGroupId,
  order: number,
  aliases: readonly string[] = [],
): AuthoredCategory {
  return { id, name, parentId, order, classifiable: true, filterable: true, aliases };
}

/** Product types only; orthogonal properties live in the facet registry. */
const AUTHORED_CATEGORIES: readonly AuthoredCategory[] = [
  root("PER", "パーソナルオーディオ", 1),
  leaf("PER.HEADPHONE", "ヘッドホン", "PER", 1, ["headphone", "headphones", "ヘッドホン"]),
  leaf("PER.EARPHONE", "イヤホン / IEM", "PER", 2, [
    "earphone",
    "earphones",
    "earbud",
    "iem",
    "イヤホン",
  ]),
  root("SPK", "スピーカー", 2),
  leaf("SPK.LOUDSPEAKER", "スピーカー", "SPK", 1, [
    "speaker",
    "loudspeaker",
    "speaker system",
    "スピーカー",
  ]),
  leaf("SPK.SUBWOOFER", "サブウーファー", "SPK", 2, ["subwoofer", "サブウーファー"]),
  leaf("SPK.SOUNDBAR", "サウンドバー", "SPK", 3, ["soundbar", "sound bar", "サウンドバー"]),
  root("AMP", "アンプ", 3),
  leaf("AMP.INTEGRATED", "プリメインアンプ", "AMP", 1, [
    "integrated amp",
    "integrated amplifier",
    "プリメインアンプ",
  ]),
  leaf("AMP.PRE", "プリアンプ", "AMP", 2, [
    "preamp",
    "pre amplifier",
    "control amplifier",
    "プリアンプ",
    "コントロールアンプ",
  ]),
  leaf("AMP.POWER", "パワーアンプ", "AMP", 3, ["power amp", "power amplifier", "パワーアンプ"]),
  leaf("AMP.HEADPHONE", "ヘッドホンアンプ / エナジャイザー", "AMP", 4, [
    "headphone amp",
    "headphone amplifier",
    "energizer",
    "ヘッドホンアンプ",
  ]),
  leaf("AMP.RECEIVER", "Stereo / AV Receiver", "AMP", 5, [
    "stereo receiver",
    "av receiver",
    "AVレシーバー",
  ]),
  leaf("AMP.PHONO", "フォノアンプ / フォノイコライザー", "AMP", 6, [
    "phono amp",
    "phono stage",
    "phono equalizer",
    "フォノアンプ",
    "フォノイコライザー",
  ]),
  leaf("AMP.STEPUP", "MC昇圧機器", "AMP", 7, [
    "step-up transformer",
    "head amp",
    "昇圧トランス",
    "ヘッドアンプ",
  ]),
  root("SRC", "ソース機器", 4),
  leaf("SRC.STREAMER", "ネットワークストリーマー / Network Transport", "SRC", 1, [
    "network player",
    "network audio player",
    "streamer",
    "network transport",
    "ネットワークプレーヤー",
    "ネットワークトランスポート",
  ]),
  leaf("SRC.DAP", "DAP", "SRC", 2, ["dap", "digital audio player", "デジタルオーディオプレーヤー"]),
  leaf("SRC.DISC", "Disc Player / Disc Transport", "SRC", 3, [
    "disc player",
    "disc transport",
    "cd player",
    "sacd player",
    "cd transport",
    "sacd transport",
    "CDプレーヤー",
    "SACDプレーヤー",
    "CDトランスポート",
  ]),
  leaf("SRC.SERVER", "Music Server / Ripper", "SRC", 4, [
    "music server",
    "music ripper",
    "ミュージックサーバー",
  ]),
  leaf("SRC.TUNER", "チューナー / Radio", "SRC", 5, ["tuner", "radio tuner", "チューナー"]),
  root("ANA", "アナログ", 5),
  leaf("ANA.TURNTABLE", "ターンテーブル", "ANA", 1, [
    "turntable",
    "record player",
    "ターンテーブル",
    "レコードプレーヤー",
  ]),
  leaf("ANA.TONEARM", "トーンアーム", "ANA", 2, ["tonearm", "tone arm", "トーンアーム"]),
  leaf("ANA.CARTRIDGE", "カートリッジ", "ANA", 3, ["cartridge", "カートリッジ"]),
  leaf("ANA.STYLUS", "交換針", "ANA", 4, ["replacement stylus", "stylus", "交換針", "レコード針"]),
  leaf("ANA.HEADSHELL", "ヘッドシェル", "ANA", 5, ["headshell", "head shell", "ヘッドシェル"]),
  leaf("ANA.TAPE", "テープデッキ", "ANA", 6, ["tape deck", "cassette deck", "テープデッキ"]),
  root("PRC", "プロセッシング / 変換", 6),
  leaf("PRC.DAC", "D/A Converter", "PRC", 1, [
    "dac",
    "d/a converter",
    "da converter",
    "D/Aコンバーター",
  ]),
  leaf("PRC.ADC", "A/D Converter", "PRC", 2, ["adc", "a/d converter", "ADコンバーター"]),
  leaf("PRC.DDC", "DDC / Digital Bridge", "PRC", 3, [
    "ddc",
    "digital bridge",
    "usb bridge",
    "reclocker",
    "リクロッカー",
  ]),
  leaf("PRC.PROCESSOR", "Audio Processor", "PRC", 4, [
    "audio processor",
    "equalizer",
    "room correction",
    "channel divider",
    "オーディオプロセッサー",
    "イコライザー",
  ]),
  leaf("PRC.CLOCK", "Master Clock", "PRC", 5, [
    "master clock",
    "clock generator",
    "マスタークロック",
  ]),
  root("SIG", "信号 / ネットワーク機器", 7),
  leaf("SIG.NETWORK", "Audio Network Equipment", "SIG", 1, [
    "network switch",
    "switching hub",
    "audio router",
    "ネットワークスイッチ",
    "スイッチングハブ",
  ]),
  leaf("SIG.ISOLATOR", "Signal Isolator", "SIG", 2, [
    "signal isolator",
    "optical isolator",
    "アイソレーター",
    "光絶縁",
  ]),
  leaf("SIG.SELECTOR", "Selector / Distributor", "SIG", 3, [
    "selector",
    "distributor",
    "matrix",
    "セレクター",
    "分配器",
  ]),
  leaf("SIG.WIRELESS", "Wireless Transmitter / Receiver", "SIG", 4, [
    "wireless transmitter",
    "wireless receiver",
    "bluetooth adapter",
    "ワイヤレス送信機",
  ]),
  root("CAB", "ケーブル", 8),
  leaf("CAB.ANALOG", "Analog Interconnect", "CAB", 1, [
    "analog interconnect",
    "analog cable",
    "rca cable",
    "phono cable",
    "アナログケーブル",
  ]),
  leaf("CAB.DIGITAL", "Digital Audio / AV Cable", "CAB", 2, [
    "digital cable",
    "aes/ebu cable",
    "spdif cable",
    "hdmi cable",
    "デジタルケーブル",
  ]),
  leaf("CAB.SPEAKER", "Speaker Cable", "CAB", 3, ["speaker cable", "スピーカーケーブル"]),
  leaf("CAB.PERSONAL", "Headphone / IEM Cable", "CAB", 4, [
    "headphone cable",
    "earphone cable",
    "iem cable",
    "リケーブル",
  ]),
  leaf("CAB.DATA", "USB / LAN Data Cable", "CAB", 5, [
    "usb cable",
    "lan cable",
    "ethernet cable",
    "USBケーブル",
    "LANケーブル",
  ]),
  leaf("CAB.ADAPTER", "Passive Adapter", "CAB", 6, ["passive adapter", "splitter", "変換プラグ"]),
  root("PWR", "電源", 9),
  leaf("PWR.CORD", "電源ケーブル", "PWR", 1, [
    "power cable",
    "power cord",
    "ac cable",
    "電源ケーブル",
  ]),
  leaf("PWR.DISTRIBUTION", "電源タップ / PDU", "PWR", 2, [
    "power strip",
    "pdu",
    "電源タップ",
    "電源ボックス",
  ]),
  leaf("PWR.CONDITIONER", "電源コンディショナー / Isolation", "PWR", 3, [
    "power conditioner",
    "clean power",
    "isolation transformer",
    "クリーン電源",
  ]),
  leaf("PWR.REGEN", "AC Regenerator", "PWR", 4, [
    "ac regenerator",
    "power regenerator",
    "電源リジェネレーター",
  ]),
  leaf("PWR.SUPPLY", "外部電源 / Linear PSU", "PWR", 5, [
    "external power supply",
    "linear power supply",
    "外部電源",
    "リニア電源",
  ]),
  leaf("PWR.BATTERY", "Battery / UPS", "PWR", 6, ["battery supply", "ups", "バッテリー電源"]),
  root("ACC", "アクセサリー", 10),
  leaf("ACC.FURNITURE", "ラック / オーディオ家具", "ACC", 1, ["audio rack", "オーディオラック"]),
  leaf("ACC.STAND", "スタンド / マウント", "ACC", 2, [
    "speaker stand",
    "headphone stand",
    "スピーカースタンド",
  ]),
  leaf("ACC.ISOLATION", "インシュレーター / 振動対策", "ACC", 3, [
    "insulator",
    "isolation board",
    "spike",
    "インシュレーター",
    "オーディオボード",
  ]),
  leaf("ACC.ACOUSTIC", "ルームアコースティック", "ACC", 4, [
    "acoustic panel",
    "absorber",
    "diffuser",
    "吸音",
    "拡散パネル",
  ]),
  leaf("ACC.WEAR", "消耗・装着部品", "ACC", 5, [
    "ear pad",
    "ear tip",
    "headband",
    "イヤーパッド",
    "イヤーピース",
  ]),
  leaf("ACC.CASE", "ケース / カバー / バッグ", "ACC", 6, [
    "equipment case",
    "headphone case",
    "cover",
    "ケース",
    "カバー",
  ]),
  leaf("ACC.MAINTENANCE", "クリーニング / メンテナンス", "ACC", 7, [
    "cleaner",
    "maintenance",
    "クリーニング",
    "メンテナンス",
  ]),
  leaf("ACC.TUBE", "真空管", "ACC", 8, ["vacuum tube", "replacement tube", "真空管"]),
  leaf("ACC.PART", "交換部品 / DIY Part", "ACC", 9, [
    "replacement part",
    "diy part",
    "交換部品",
    "補修部品",
  ]),
  root("SYS", "システム", 11),
  leaf("SYS.MULTIFUNCTION", "複合オーディオ機器", "SYS", 1, [
    "co-equal multifunction",
    "複合オーディオ機器",
  ]),
  leaf("SYS.COMPLETE", "Complete Audio System", "SYS", 2, [
    "complete audio system",
    "packaged audio system",
    "一体型オーディオシステム",
  ]),
  root("REC", "Pro Audio Extension", 12),
  leaf("REC.INTERFACE", "Audio Interface", "REC", 1, [
    "audio interface",
    "オーディオインターフェース",
  ]),
  leaf("REC.MIC", "Microphone", "REC", 2, ["microphone", "マイクロフォン"]),
  leaf("REC.MIXER", "Mixer / Console", "REC", 3, ["audio mixer", "mixing console", "ミキサー"]),
  leaf("REC.RECORDER", "Recorder", "REC", 4, ["field recorder", "digital recorder", "レコーダー"]),
  leaf("REC.MICPRE", "Mic Pre / Channel Strip", "REC", 5, [
    "mic pre",
    "channel strip",
    "マイクプリ",
  ]),
  leaf("REC.MONITOR", "Monitor Controller", "REC", 6, [
    "monitor controller",
    "モニターコントローラー",
  ]),
  leaf("REC.DJ", "DJ Controller / Digital DJ Gear", "REC", 7, [
    "dj controller",
    "digital dj",
    "DJコントローラー",
  ]),
  {
    id: UNCLASSIFIED_CATEGORY_ID,
    name: "未分類",
    parentId: null,
    order: 99,
    classifiable: false,
    filterable: false,
    aliases: [],
  },
];

const CATEGORY_SOURCE: readonly CategoryDefinition[] = AUTHORED_CATEGORIES.map((category) =>
  Object.freeze({ ...category, selectable: category.filterable }),
);
export const CATEGORIES = Object.freeze(CATEGORY_SOURCE);
const CATEGORY_BY_ID = new Map<string, CategoryDefinition>(
  CATEGORIES.map((category) => [category.id, category]),
);

const NO_FACETS: readonly FacetSelection[] = Object.freeze([]);
const selection = (facetId: FacetSelection["facetId"], value: string): FacetSelection =>
  Object.freeze({ facetId, value });
type RuleData = readonly [
  LegacyCategoryAlias,
  LegacyCategoryMigrationRule["strategy"],
  readonly ClassifiableCategoryId[],
  readonly FacetSelection[],
];

const RULE_DATA: readonly RuleData[] = [
  [
    "amplifier",
    "evidence",
    [
      "AMP.INTEGRATED",
      "AMP.PRE",
      "AMP.POWER",
      "AMP.HEADPHONE",
      "AMP.RECEIVER",
      "AMP.PHONO",
      "AMP.STEPUP",
    ],
    NO_FACETS,
  ],
  [
    "digital",
    "evidence",
    [
      "SRC.STREAMER",
      "SRC.DAP",
      "SRC.DISC",
      "SRC.SERVER",
      "SRC.TUNER",
      "PRC.DAC",
      "PRC.ADC",
      "PRC.DDC",
      "PRC.PROCESSOR",
      "PRC.CLOCK",
      "SIG.NETWORK",
      "SIG.ISOLATOR",
      "SIG.SELECTOR",
      "SIG.WIRELESS",
    ],
    NO_FACETS,
  ],
  [
    "analog",
    "evidence",
    [
      "ANA.TURNTABLE",
      "ANA.TONEARM",
      "ANA.CARTRIDGE",
      "ANA.STYLUS",
      "ANA.HEADSHELL",
      "ANA.TAPE",
      "AMP.PHONO",
      "AMP.STEPUP",
    ],
    NO_FACETS,
  ],
  ["speaker", "deterministic", ["SPK.LOUDSPEAKER"], NO_FACETS],
  ["headphone_group", "evidence", ["PER.HEADPHONE", "PER.EARPHONE", "AMP.HEADPHONE"], NO_FACETS],
  [
    "accessories",
    "evidence",
    [
      "ACC.FURNITURE",
      "ACC.STAND",
      "ACC.ISOLATION",
      "ACC.ACOUSTIC",
      "ACC.WEAR",
      "ACC.CASE",
      "ACC.MAINTENANCE",
      "ACC.TUBE",
      "ACC.PART",
      "CAB.ANALOG",
      "CAB.DIGITAL",
      "CAB.SPEAKER",
      "CAB.PERSONAL",
      "CAB.DATA",
      "CAB.ADAPTER",
      "PWR.CORD",
      "PWR.DISTRIBUTION",
      "PWR.CONDITIONER",
      "PWR.REGEN",
      "PWR.SUPPLY",
      "PWR.BATTERY",
    ],
    NO_FACETS,
  ],
  [
    "cable",
    "evidence",
    [
      "CAB.ANALOG",
      "CAB.DIGITAL",
      "CAB.SPEAKER",
      "CAB.PERSONAL",
      "CAB.DATA",
      "CAB.ADAPTER",
      "PWR.CORD",
    ],
    NO_FACETS,
  ],
  ["integrated_amp", "deterministic", ["AMP.INTEGRATED"], NO_FACETS],
  ["pre_amp", "deterministic", ["AMP.PRE"], NO_FACETS],
  ["power_amp", "deterministic", ["AMP.POWER"], NO_FACETS],
  ["headphone_amp", "deterministic", ["AMP.HEADPHONE"], NO_FACETS],
  ["av_amp", "evidence", ["AMP.RECEIVER", "PRC.PROCESSOR", "AMP.POWER", "AMP.PRE"], NO_FACETS],
  ["dac", "deterministic", ["PRC.DAC"], NO_FACETS],
  ["network_player", "deterministic", ["SRC.STREAMER"], NO_FACETS],
  ["cd_sacd_player", "deterministic", ["SRC.DISC"], NO_FACETS],
  ["transport", "evidence", ["SRC.DISC", "SRC.STREAMER", "PRC.DDC"], NO_FACETS],
  ["dap", "deterministic", ["SRC.DAP"], [selection("portability", "portable")]],
  [
    "network_switch",
    "deterministic",
    ["SIG.NETWORK"],
    [selection("network_device_type", "switch"), selection("protocol", "ethernet")],
  ],
  ["optical_isolator", "deterministic", ["SIG.ISOLATOR"], NO_FACETS],
  ["router", "deterministic", ["SIG.NETWORK"], [selection("network_device_type", "router")]],
  ["music_server", "deterministic", ["SRC.SERVER"], NO_FACETS],
  ["master_clock", "deterministic", ["PRC.CLOCK"], NO_FACETS],
  ["turntable", "deterministic", ["ANA.TURNTABLE"], NO_FACETS],
  ["tonearm", "deterministic", ["ANA.TONEARM"], NO_FACETS],
  ["cartridge", "deterministic", ["ANA.CARTRIDGE"], NO_FACETS],
  ["headshell", "deterministic", ["ANA.HEADSHELL"], NO_FACETS],
  ["phono_eq", "deterministic", ["AMP.PHONO"], NO_FACETS],
  [
    "phono_step_up_transformer",
    "deterministic",
    ["AMP.STEPUP"],
    [selection("technology", "transformer")],
  ],
  [
    "speaker_bookshelf",
    "deterministic",
    ["SPK.LOUDSPEAKER"],
    [selection("form_factor", "bookshelf")],
  ],
  [
    "speaker_floorstanding",
    "deterministic",
    ["SPK.LOUDSPEAKER"],
    [selection("form_factor", "floorstanding")],
  ],
  ["center_speaker", "deterministic", ["SPK.LOUDSPEAKER"], [selection("channel_role", "center")]],
  ["subwoofer", "deterministic", ["SPK.SUBWOOFER"], NO_FACETS],
  [
    "active_speaker",
    "deterministic",
    ["SPK.LOUDSPEAKER"],
    [selection("amplification_mode", "active")],
  ],
  ["wired_headphone", "deterministic", ["PER.HEADPHONE"], [selection("connectivity", "wired")]],
  ["wired_earphone", "deterministic", ["PER.EARPHONE"], [selection("connectivity", "wired")]],
  [
    "btw_headphone",
    "deterministic",
    ["PER.HEADPHONE"],
    [selection("connectivity", "wireless"), selection("protocol", "bluetooth")],
  ],
  [
    "btw_earphone",
    "deterministic",
    ["PER.EARPHONE"],
    [selection("connectivity", "wireless"), selection("protocol", "bluetooth")],
  ],
  [
    "cable_xlr",
    "evidence",
    ["CAB.ANALOG", "CAB.DIGITAL"],
    [selection("connector_a", "xlr"), selection("connector_b", "xlr")],
  ],
  [
    "cable_rca",
    "deterministic",
    ["CAB.ANALOG"],
    [
      selection("connector_a", "rca"),
      selection("connector_b", "rca"),
      selection("signal_type", "analog"),
    ],
  ],
  [
    "cable_phono",
    "deterministic",
    ["CAB.ANALOG"],
    [selection("application", "phono"), selection("signal_type", "analog")],
  ],
  [
    "cable_usb",
    "deterministic",
    ["CAB.DATA"],
    [selection("connector_a", "usb"), selection("signal_type", "data")],
  ],
  [
    "cable_lan",
    "deterministic",
    ["CAB.DATA"],
    [
      selection("connector_a", "ethernet"),
      selection("connector_b", "ethernet"),
      selection("signal_type", "data"),
    ],
  ],
  ["cable_digital", "deterministic", ["CAB.DIGITAL"], [selection("signal_type", "digital")]],
  ["cable_power", "deterministic", ["PWR.CORD"], [selection("signal_type", "power")]],
  [
    "cable_other",
    "evidence",
    [
      "CAB.ANALOG",
      "CAB.DIGITAL",
      "CAB.SPEAKER",
      "CAB.PERSONAL",
      "CAB.DATA",
      "CAB.ADAPTER",
      "PWR.CORD",
    ],
    NO_FACETS,
  ],
  ["rack", "deterministic", ["ACC.FURNITURE"], NO_FACETS],
  ["power_strip", "deterministic", ["PWR.DISTRIBUTION"], NO_FACETS],
  ["clean_power", "evidence", ["PWR.CONDITIONER", "PWR.REGEN"], NO_FACETS],
  ["vacuum_tube", "deterministic", ["ACC.TUBE"], NO_FACETS],
  [
    "other_accessory",
    "evidence",
    [
      "ACC.FURNITURE",
      "ACC.STAND",
      "ACC.ISOLATION",
      "ACC.ACOUSTIC",
      "ACC.WEAR",
      "ACC.CASE",
      "ACC.MAINTENANCE",
      "ACC.TUBE",
      "ACC.PART",
      "CAB.ANALOG",
      "CAB.DIGITAL",
      "CAB.SPEAKER",
      "CAB.PERSONAL",
      "CAB.DATA",
      "CAB.ADAPTER",
      "PWR.CORD",
      "PWR.DISTRIBUTION",
      "PWR.CONDITIONER",
      "PWR.REGEN",
      "PWR.SUPPLY",
      "PWR.BATTERY",
    ],
    NO_FACETS,
  ],
  [
    "dj_dtm",
    "evidence",
    [
      "REC.INTERFACE",
      "REC.MIC",
      "REC.MIXER",
      "REC.RECORDER",
      "REC.MICPRE",
      "REC.MONITOR",
      "REC.DJ",
    ],
    [selection("use_case", "dj")],
  ],
  [
    "other",
    "evidence",
    ["SRC.TUNER", "PRC.PROCESSOR", "SPK.SOUNDBAR", "CAB.SPEAKER", "CAB.PERSONAL", "ACC.ISOLATION"],
    NO_FACETS,
  ],
  ["network_transport", "deterministic", ["SRC.STREAMER"], NO_FACETS],
  ["cd_sacd_transport", "deterministic", ["SRC.DISC"], NO_FACETS],
  [
    "accessory",
    "evidence",
    [
      "ACC.FURNITURE",
      "ACC.STAND",
      "ACC.ISOLATION",
      "ACC.ACOUSTIC",
      "ACC.WEAR",
      "ACC.CASE",
      "ACC.MAINTENANCE",
      "ACC.TUBE",
      "ACC.PART",
    ],
    NO_FACETS,
  ],
  ["speaker_other", "deterministic", ["SPK.LOUDSPEAKER"], NO_FACETS],
  ["headphone", "deterministic", ["PER.HEADPHONE"], NO_FACETS],
  ["earphone", "deterministic", ["PER.EARPHONE"], NO_FACETS],
  ["power_accessory", "deterministic", ["PWR.CONDITIONER"], NO_FACETS],
];

export const LEGACY_CATEGORY_MIGRATION_RULES: readonly LegacyCategoryMigrationRule[] =
  Object.freeze(
    RULE_DATA.map(([legacyId, strategy, categoryIds, facetSelections]) =>
      Object.freeze({
        legacyId,
        strategy,
        categoryIds: Object.freeze(categoryIds),
        facetSelections: Object.freeze(facetSelections),
      }),
    ),
  );
const LEGACY_RULE_BY_ID = new Map(
  LEGACY_CATEGORY_MIGRATION_RULES.map((rule) => [rule.legacyId, rule]),
);
export const LEGACY_CATEGORY_ALIASES: Readonly<
  Partial<Record<LegacyCategoryAlias, ClassifiableCategoryId>>
> = Object.freeze(
  Object.fromEntries(
    LEGACY_CATEGORY_MIGRATION_RULES.filter(
      (rule) => rule.strategy === "deterministic" && rule.categoryIds.length === 1,
    ).map((rule) => [rule.legacyId, rule.categoryIds[0]]),
  ),
);

function normalizeLookup(value: string = ""): string {
  return String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s・･_\-/()（）]+/g, "");
}

function canonicalFromVocabulary(value: string, classifiableOnly = false): CategoryId | null {
  const needle = normalizeLookup(value);
  if (!needle) return null;
  for (const category of CATEGORIES) {
    if (classifiableOnly && !category.classifiable) continue;
    if (normalizeLookup(category.id) === needle || normalizeLookup(category.name) === needle)
      return category.id;
    if (category.aliases.some((alias) => normalizeLookup(alias) === needle)) return category.id;
  }
  return null;
}

function legacyRule(value: string): LegacyCategoryMigrationRule | null {
  return LEGACY_RULE_BY_ID.get(value as LegacyCategoryAlias) || null;
}

export function legacyCategoryFacetSelections(value: string): readonly FacetSelection[] {
  return legacyRule(value)?.facetSelections || NO_FACETS;
}

export function categoryMappingValue(
  mapping: CategoryMapping | undefined,
  rawCategory: string,
): string | null {
  if (!mapping || !rawCategory) return null;
  const needle = normalizeLookup(rawCategory);
  for (const [raw, mapped] of Object.entries(mapping)) {
    if (normalizeLookup(raw) === needle)
      return typeof mapped === "string" ? mapped : (mapped[0] ?? null);
  }
  return null;
}

export function categoryIdForClassification(
  value: string = "",
  evidenceText: string = "",
): CategoryId | null {
  if (CATEGORY_BY_ID.get(value)?.classifiable) return value as CategoryId;
  const rule = legacyRule(value);
  if (rule?.strategy === "deterministic") return rule.categoryIds[0] || null;
  if (rule) {
    const inferred = inferExplicitCategoryIds(evidenceText, { context: "legacy_migration" })[0];
    return inferred && rule.categoryIds.includes(inferred) ? inferred : null;
  }
  const vocabulary = canonicalFromVocabulary(value, true);
  return vocabulary?.includes(".") ? vocabulary : null;
}

export function getCategory(categoryId: string): CategoryDefinition | null {
  const canonical = CATEGORY_BY_ID.has(categoryId)
    ? categoryId
    : LEGACY_CATEGORY_ALIASES[categoryId as LegacyCategoryAlias];
  return canonical ? CATEGORY_BY_ID.get(canonical) || null : null;
}

export function categoryIdForFilter(value: string = ""): CategoryId | null {
  const canonical = canonicalFromVocabulary(value);
  if (canonical && CATEGORY_BY_ID.get(canonical)?.filterable) return canonical;
  return legacyRule(value)?.categoryIds[0] || null;
}

export function categoryClosureIds(categoryId: string): CategoryId[] {
  const category = getCategory(categoryId);
  if (!category?.classifiable) return [];
  return category.parentId ? [category.id, category.parentId] : [category.id];
}

export function categoryFilterIds(value: string = ""): string[] {
  const directRule = legacyRule(value);
  const categoryId = directRule ? null : categoryIdForFilter(value);
  const canonicalIds = directRule
    ? [...directRule.categoryIds]
    : categoryId
      ? CATEGORIES.filter(
          (candidate) =>
            candidate.filterable &&
            (candidate.id === categoryId || categoryClosureIds(candidate.id).includes(categoryId)),
        ).map((candidate) => candidate.id)
      : [];
  if (!canonicalIds.length) return [];
  const staleAliases = LEGACY_CATEGORY_MIGRATION_RULES.filter((rule) =>
    rule.categoryIds.some((candidate) => canonicalIds.includes(candidate)),
  ).map((rule) => rule.legacyId);
  if (directRule) staleAliases.push(directRule.legacyId);
  return [...new Set([...canonicalIds, ...staleAliases])];
}

export function categoryFacet(categoryId: string): CategoryFacet | null {
  const category = getCategory(categoryId);
  if (!category?.filterable) return null;
  const parent = category.parentId ? getCategory(category.parentId) : null;
  return {
    id: category.id,
    name: category.name,
    parentId: category.parentId,
    order: category.order,
    classifiable: category.classifiable,
    filterable: category.filterable,
    group: parent?.name || null,
  };
}

export function categorySearchAliases(categoryIds: readonly string[] = []): string {
  return [...new Set(categoryIds)]
    .flatMap((id) => {
      const category = getCategory(id);
      if (!category?.classifiable) return [];
      const legacy = LEGACY_CATEGORY_MIGRATION_RULES.filter(
        (rule) => rule.strategy === "deterministic" && rule.categoryIds[0] === category.id,
      ).map((rule) => rule.legacyId);
      return [category.name, ...category.aliases, ...legacy];
    })
    .join(" ");
}

function inferLeaf(value: string): ClassifiableCategoryId | null {
  return inferExplicitCategoryIds(value)[0] || null;
}

export function normalizeCategory({
  rawCategory = "",
  title = "",
  hintedCategory = "",
  categoryMapping = {},
}: NormalizeCategoryOptions = {}): NormalizeCategoryResult {
  const evidenceText = [title, rawCategory, hintedCategory].filter(Boolean).join(" ");
  const mappedValue = categoryMappingValue(categoryMapping, rawCategory);
  let primaryCategoryId = mappedValue
    ? categoryIdForClassification(mappedValue, evidenceText)
    : null;
  let source: CategoryNormalizationSource = primaryCategoryId ? "shop_mapping" : "unclassified";
  if (!primaryCategoryId && rawCategory) {
    primaryCategoryId =
      categoryIdForClassification(rawCategory, evidenceText) || inferLeaf(rawCategory);
    if (primaryCategoryId)
      source = categoryIdForClassification(rawCategory, evidenceText)
        ? "global_alias"
        : "raw_inference";
  }
  if (!primaryCategoryId && hintedCategory) {
    primaryCategoryId =
      categoryIdForClassification(hintedCategory, evidenceText) || inferLeaf(hintedCategory);
    if (primaryCategoryId) source = "parser_hint";
  }
  if (!primaryCategoryId && title) {
    primaryCategoryId = inferLeaf(title);
    if (primaryCategoryId) source = "title_inference";
  }
  primaryCategoryId ||= UNCLASSIFIED_CATEGORY_ID;
  const primary = getCategory(primaryCategoryId) ?? CATEGORY_BY_ID.get(UNCLASSIFIED_CATEGORY_ID);
  if (!primary) throw new Error("Missing required fallback category: unclassified");
  return {
    primaryCategoryId: primary.id,
    categoryIds: [primary.id],
    displayName: primary.name,
    classificationStatus: source === "unclassified" ? "unclassified" : "classified",
    classificationSource: source,
    searchAliases: categorySearchAliases([primary.id]),
  };
}

export function canonicalCategoryDefinitions(): readonly CategoryDefinition[] {
  return CATEGORIES;
}
