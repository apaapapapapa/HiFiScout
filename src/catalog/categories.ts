import type {
  CategoryDefinition,
  CategoryFacet,
  CategoryId,
  CategoryMapping,
  CategoryNormalizationSource,
  ClassifiableCategoryId,
  NormalizeCategoryOptions,
  NormalizeCategoryResult,
} from "./types.js";
import { inferExplicitCategoryIds } from "./category-rules.js";

/** Taxonomy rows as authored; `selectable` is derived from `filterable` below. */
const AUTHORED_CATEGORIES: readonly Omit<CategoryDefinition, "selectable">[] = [
  {
    id: "amplifier",
    name: "アンプ",
    parentId: null,
    order: 1,
    classifiable: false,
    filterable: true,
    aliases: ["amplifier", "アンプ"],
  },
  {
    id: "integrated_amp",
    name: "プリメインアンプ",
    parentId: "amplifier",
    order: 1,
    classifiable: true,
    filterable: true,
    aliases: ["integrated amp", "integrated amplifier", "プリメインアンプ"],
  },
  {
    id: "pre_amp",
    name: "プリアンプ",
    parentId: "amplifier",
    order: 2,
    classifiable: true,
    filterable: true,
    aliases: [
      "preamp",
      "pre amplifier",
      "control amplifier",
      "control amp",
      "linestage preamplifier",
      "プリアンプ",
      "コントロールアンプ",
    ],
  },
  {
    id: "power_amp",
    name: "パワーアンプ",
    parentId: "amplifier",
    order: 3,
    classifiable: true,
    filterable: true,
    aliases: ["power amp", "power amplifier", "パワーアンプ"],
  },
  {
    id: "headphone_amp",
    name: "ヘッドホンアンプ",
    parentId: "amplifier",
    order: 4,
    classifiable: true,
    filterable: true,
    aliases: ["headphone amp", "headphone amplifier", "ヘッドホンアンプ"],
  },

  {
    id: "av_amp",
    name: "AVアンプ",
    parentId: "amplifier",
    order: 5,
    classifiable: true,
    filterable: true,
    aliases: [
      "av amp",
      "av amplifier",
      "av receiver",
      "audio video receiver",
      "AVアンプ",
      "AVレシーバー",
      "AVレシーバ",
    ],
  },

  {
    id: "digital",
    name: "デジタル",
    parentId: null,
    order: 2,
    classifiable: false,
    filterable: true,
    aliases: ["digital audio", "デジタル"],
  },
  {
    id: "dac",
    name: "DAC",
    parentId: "digital",
    order: 1,
    classifiable: true,
    filterable: true,
    aliases: [
      "dac",
      "d/a converter",
      "d-a converter",
      "da converter",
      "d/aコンバーター",
      "daコンバーター",
      "d/aコンバータ",
      "daコンバータ",
    ],
  },
  {
    id: "network_player",
    name: "ネットワークプレーヤー",
    parentId: "digital",
    order: 2,
    classifiable: true,
    filterable: true,
    aliases: [
      "network player",
      "network transport",
      "network cd receiver",
      "streamer",
      "streaming player",
      "streaming transport",
      "ネットワークプレーヤー",
      "ネットワークプレイヤー",
      "ネットワークトランスポート",
      "ネットワーク",
    ],
  },
  {
    id: "cd_sacd_player",
    name: "CD/SACDプレーヤー",
    parentId: "digital",
    order: 3,
    classifiable: true,
    filterable: true,
    aliases: [
      "cd player",
      "cd transport",
      "sacd player",
      "sacd transport",
      "super audio cd transport",
      "sacd/cd player",
      "cdプレーヤー",
      "cdトランスポート",
      "sacdプレーヤー",
      "sacdトランスポート",
      "sacd/cdプレーヤー",
      "cd/sacdプレーヤー",
    ],
  },
  {
    id: "dap",
    name: "DAP",
    parentId: "digital",
    order: 4,
    classifiable: true,
    filterable: true,
    aliases: [
      "dap",
      "digital audio player",
      "デジタルオーディオプレーヤー",
      "ポータブルプレーヤー",
      "ポータブルプレイヤー",
    ],
  },

  {
    id: "network_switch",
    name: "スイッチングハブ",
    parentId: "digital",
    order: 5,
    classifiable: true,
    filterable: true,
    aliases: [
      "network switch",
      "ethernet switch",
      "switching hub",
      "スイッチングハブ",
      "ネットワークスイッチ",
    ],
  },
  {
    id: "optical_isolator",
    name: "光アイソレーター",
    parentId: "digital",
    order: 6,
    classifiable: true,
    filterable: true,
    aliases: [
      "optical isolator",
      "fiber isolator",
      "fibre isolator",
      "光アイソレーター",
      "光アイソレータ",
      "光絶縁",
    ],
  },
  {
    id: "router",
    name: "ルーター",
    parentId: "digital",
    order: 7,
    classifiable: true,
    filterable: true,
    aliases: ["router", "audio router", "オーディオルーター", "ルーター", "ルータ"],
  },
  {
    id: "music_server",
    name: "ミュージックサーバー",
    parentId: "digital",
    order: 8,
    classifiable: true,
    filterable: true,
    aliases: [
      "music server",
      "audio server",
      "music library server",
      "ミュージックサーバー",
      "ミュージックサーバ",
      "オーディオサーバー",
      "オーディオサーバ",
    ],
  },
  {
    id: "master_clock",
    name: "マスタークロックジェネレーター",
    parentId: "digital",
    order: 9,
    classifiable: true,
    filterable: true,
    aliases: [
      "master clock",
      "master clock generator",
      "clock generator",
      "マスタークロック",
      "マスタークロックジェネレーター",
      "マスタークロックジェネレータ",
      "クロックジェネレーター",
      "クロックジェネレータ",
    ],
  },

  {
    id: "analog",
    name: "アナログ",
    parentId: null,
    order: 3,
    classifiable: false,
    filterable: true,
    aliases: ["analog", "analogue", "アナログ"],
  },
  {
    id: "turntable",
    name: "レコードプレーヤー",
    parentId: "analog",
    order: 1,
    classifiable: true,
    filterable: true,
    aliases: [
      "turntable",
      "record player",
      "レコードプレーヤー",
      "レコードプレイヤー",
      "ターンテーブル",
    ],
  },
  {
    id: "tonearm",
    name: "トーンアーム",
    parentId: "analog",
    order: 2,
    classifiable: true,
    filterable: true,
    aliases: ["tonearm", "tone arm", "トーンアーム"],
  },
  {
    id: "cartridge",
    name: "カートリッジ",
    parentId: "analog",
    order: 3,
    classifiable: true,
    filterable: true,
    aliases: ["cartridge", "カートリッジ"],
  },
  {
    id: "phono_eq",
    name: "フォノイコライザー",
    parentId: "analog",
    order: 4,
    classifiable: true,
    filterable: true,
    aliases: ["phono equalizer", "phono eq", "phono stage", "フォノイコライザー", "フォノアンプ"],
  },

  {
    id: "speaker",
    name: "スピーカー",
    parentId: null,
    order: 4,
    classifiable: false,
    filterable: true,
    aliases: ["speaker", "speakers", "スピーカー"],
  },
  {
    id: "speaker_bookshelf",
    name: "ブックシェルフ",
    parentId: "speaker",
    order: 1,
    classifiable: true,
    filterable: true,
    aliases: [
      "bookshelf",
      "bookshelf speaker",
      "standmount",
      "stand-mount",
      "ブックシェルフ",
      "ブックシェルフ型",
    ],
  },
  {
    id: "speaker_floorstanding",
    name: "フロア型・トールボーイ",
    parentId: "speaker",
    order: 2,
    classifiable: true,
    filterable: true,
    aliases: [
      "floorstanding",
      "floor-standing",
      "tower speaker",
      "トールボーイ",
      "フロア型・トールボーイ",
      "フロア型",
      "フロアスタンディング",
    ],
  },
  {
    id: "center_speaker",
    name: "センタースピーカー",
    parentId: "speaker",
    order: 3,
    classifiable: true,
    filterable: true,
    aliases: [
      "center speaker",
      "centre speaker",
      "center channel speaker",
      "centre channel speaker",
      "センタースピーカー",
      "センター・スピーカー",
    ],
  },
  {
    id: "subwoofer",
    name: "サブウーファー",
    parentId: "speaker",
    order: 4,
    classifiable: true,
    filterable: true,
    aliases: ["subwoofer", "sub-woofer", "サブウーファー"],
  },
  {
    id: "active_speaker",
    name: "アクティブスピーカー",
    parentId: "speaker",
    order: 5,
    classifiable: true,
    filterable: true,
    aliases: [
      "active speaker",
      "active speakers",
      "powered speaker",
      "powered speakers",
      "powered monitor",
      "powered monitors",
      "アクティブスピーカー",
      "パワードスピーカー",
    ],
  },

  {
    id: "headphone_group",
    name: "ヘッドホン",
    parentId: null,
    order: 5,
    classifiable: false,
    filterable: true,
    aliases: ["headphone group", "ヘッドホン・イヤホン"],
  },
  {
    id: "headphone",
    name: "ヘッドホン",
    parentId: "headphone_group",
    order: 1,
    classifiable: true,
    filterable: true,
    aliases: ["headphone", "headphones", "ヘッドホン"],
  },
  {
    id: "earphone",
    name: "イヤホン",
    parentId: "headphone_group",
    order: 2,
    classifiable: true,
    filterable: true,
    aliases: ["earphone", "earphones", "earbud", "earbuds", "iem", "イヤホン"],
  },

  {
    id: "accessories",
    name: "アクセサリー",
    parentId: null,
    order: 6,
    classifiable: false,
    filterable: true,
    aliases: ["accessories", "アクセサリー"],
  },
  {
    id: "cable",
    name: "ケーブル",
    parentId: "accessories",
    order: 1,
    classifiable: false,
    filterable: true,
    aliases: ["cable", "cables", "ケーブル"],
  },
  {
    id: "cable_xlr",
    name: "XLRケーブル",
    parentId: "cable",
    order: 1,
    classifiable: true,
    filterable: true,
    aliases: ["xlr cable", "xlr cables", "xlr interconnect", "XLRケーブル", "XLRインターコネクト"],
  },
  {
    id: "cable_rca",
    name: "RCAケーブル",
    parentId: "cable",
    order: 2,
    classifiable: true,
    filterable: true,
    aliases: ["rca cable", "rca cables", "rca interconnect", "RCAケーブル", "RCAインターコネクト"],
  },
  {
    id: "cable_phono",
    name: "フォノケーブル",
    parentId: "cable",
    order: 3,
    classifiable: true,
    filterable: true,
    aliases: [
      "phono cable",
      "phono interconnect",
      "tonearm cable",
      "フォノケーブル",
      "トーンアームケーブル",
    ],
  },
  {
    id: "cable_usb",
    name: "USBケーブル",
    parentId: "cable",
    order: 4,
    classifiable: true,
    filterable: true,
    aliases: ["usb cable", "usb cables", "USBケーブル", "オーディオUSBケーブル"],
  },
  {
    id: "cable_lan",
    name: "LANケーブル",
    parentId: "cable",
    order: 5,
    classifiable: true,
    filterable: true,
    aliases: [
      "lan cable",
      "ethernet cable",
      "network cable",
      "LANケーブル",
      "オーディオLANケーブル",
      "イーサネットケーブル",
    ],
  },
  {
    id: "cable_digital",
    name: "デジタルケーブル",
    parentId: "cable",
    order: 6,
    classifiable: true,
    filterable: true,
    aliases: [
      "digital cable",
      "digital interconnect",
      "spdif cable",
      "s/pdif cable",
      "aes/ebu cable",
      "toslink cable",
      "optical cable",
      "coaxial digital cable",
      "hdmi cable",
      "デジタルケーブル",
      "デジタル同軸ケーブル",
      "光デジタルケーブル",
      "HDMIケーブル",
    ],
  },
  {
    id: "cable_power",
    name: "電源ケーブル",
    parentId: "cable",
    order: 7,
    classifiable: true,
    filterable: true,
    aliases: [
      "power cable",
      "power cord",
      "mains cable",
      "ac cable",
      "電源ケーブル",
      "電源コード",
      "ACケーブル",
    ],
  },
  {
    id: "cable_other",
    name: "その他ケーブル",
    parentId: "cable",
    order: 8,
    classifiable: true,
    filterable: true,
    aliases: [
      "other cable",
      "speaker cable",
      "headphone cable",
      "その他ケーブル",
      "スピーカーケーブル",
      "ヘッドホンケーブル",
    ],
  },
  {
    id: "rack",
    name: "オーディオラック",
    parentId: "accessories",
    order: 2,
    classifiable: true,
    filterable: true,
    aliases: ["audio rack", "rack", "オーディオラック", "ラック"],
  },
  {
    id: "power_accessory",
    name: "電源関連",
    parentId: "accessories",
    order: 3,
    classifiable: true,
    filterable: true,
    aliases: [
      "power accessory",
      "power conditioner",
      "power strip",
      "電源タップ",
      "電源コンディショナー",
      "電源コンディショナ",
    ],
  },
  {
    id: "vacuum_tube",
    name: "真空管",
    parentId: "accessories",
    order: 4,
    classifiable: true,
    filterable: true,
    aliases: ["vacuum tube", "tube", "真空管"],
  },
  {
    id: "other_accessory",
    name: "その他アクセサリー",
    parentId: "accessories",
    order: 5,
    classifiable: true,
    filterable: true,
    aliases: [
      "accessory",
      "other accessory",
      "insulator",
      "hdmi switcher",
      "dust cover",
      "インシュレーター",
      "インシュレータ",
      "HDMIスイッチャー",
      "ダストカバー",
      "その他アクセサリー",
    ],
  },

  {
    id: "dj_dtm",
    name: "DJ機器・DTM",
    parentId: null,
    order: 7,
    classifiable: true,
    filterable: true,
    aliases: ["dj", "ddj", "dtm", "rekordbox", "serato", "midi", "オーディオインターフェース"],
  },
  {
    id: "other",
    name: "その他",
    parentId: null,
    order: 8,
    classifiable: true,
    filterable: true,
    aliases: [
      "その他",
      "others",
      "other",
      "tuner",
      "equalizer",
      "channel divider",
      "frequency dividing network",
      "チューナー",
      "イコライザー",
      "チャンネルデバイダー",
    ],
  },
];

const CATEGORY_SOURCE: readonly CategoryDefinition[] = AUTHORED_CATEGORIES.map((category) =>
  Object.freeze({ ...category, selectable: category.filterable }),
);

export const CATEGORIES = Object.freeze(CATEGORY_SOURCE);
const CATEGORY_BY_ID: ReadonlyMap<string, CategoryDefinition> = new Map(
  CATEGORIES.map((category) => [category.id, category]),
);
const LEGACY_ALIASES: Readonly<Record<string, ClassifiableCategoryId>> = Object.freeze({
  network_transport: "network_player",
  accessory: "other_accessory",
  speaker_other: "other",
});
const LEGACY_FILTER_ALIASES: Readonly<Record<string, CategoryId>> = Object.freeze({
  speaker_other: "speaker",
});
const CLASSIFICATION_ALIASES: Readonly<Record<string, ClassifiableCategoryId>> = Object.freeze({
  ...LEGACY_ALIASES,
  cable: "cable_other",
});

function normalizeLookup(value: string = ""): string {
  return String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s・･_\-/()（）]+/g, "");
}

function categoryIdFromAlias(
  value: string = "",
  { classifiableOnly = false }: { classifiableOnly?: boolean } = {},
): CategoryId | null {
  const legacy = classifiableOnly ? CLASSIFICATION_ALIASES[value] : LEGACY_ALIASES[value];
  if (legacy) return legacy;
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

function mappingValue(mapping: CategoryMapping | undefined, rawCategory: string): string | null {
  if (!mapping || !rawCategory) return null;
  const needle = normalizeLookup(rawCategory);
  for (const [raw, mapped] of Object.entries(mapping)) {
    if (normalizeLookup(raw) === needle)
      return typeof mapped === "string" ? mapped : (mapped[0] ?? null);
  }
  return null;
}

function inferLeaf(value: string = ""): ClassifiableCategoryId | null {
  return inferExplicitCategoryIds(value)[0] || null;
}

export function getCategory(categoryId: string): CategoryDefinition | null {
  const canonical = LEGACY_FILTER_ALIASES[categoryId] || LEGACY_ALIASES[categoryId] || categoryId;
  return CATEGORY_BY_ID.get(canonical) || null;
}

export function categoryIdForFilter(value: string = ""): CategoryId | null {
  const canonical = LEGACY_FILTER_ALIASES[value] || LEGACY_ALIASES[value] || value;
  if (CATEGORY_BY_ID.get(canonical)?.filterable) return canonical;
  return categoryIdFromAlias(value);
}

export function categoryIdForClassification(value: string = ""): CategoryId | null {
  const canonical = CLASSIFICATION_ALIASES[value] || value;
  if (CATEGORY_BY_ID.get(canonical)?.classifiable) return canonical;
  return categoryIdFromAlias(value, { classifiableOnly: true });
}

export function categoryClosureIds(categoryId: string): CategoryId[] {
  const category = getCategory(categoryId);
  if (!category?.classifiable) return [];
  const closure: CategoryId[] = [];
  const seen = new Set<CategoryId>();
  let current: CategoryDefinition | null = category;
  while (current && !seen.has(current.id)) {
    closure.push(current.id);
    seen.add(current.id);
    current = current.parentId ? getCategory(current.parentId) : null;
  }
  return closure;
}

/**
 * Every category id a filter on `value` should accept, including `value` itself.
 *
 * The inverse of {@link categoryClosureIds}: that one answers "which filters match this product",
 * this one answers "which products match this filter". Product search needs the second direction
 * because a product-level result stores one canonical category rather than a materialized closure,
 * so a group category has to expand to its descendants at query time. Accepts ids, display names
 * and legacy aliases, exactly like {@link categoryIdForFilter}.
 */
export function categoryFilterIds(value: string = ""): CategoryId[] {
  const categoryId = categoryIdForFilter(value);
  if (!categoryId) return [];
  return CATEGORIES.filter(
    (candidate) =>
      candidate.id === categoryId || categoryClosureIds(candidate.id).includes(categoryId),
  ).map((candidate) => candidate.id);
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
      return category?.classifiable ? [category.name, ...category.aliases] : [];
    })
    .join(" ");
}

export function normalizeCategory({
  rawCategory = "",
  title = "",
  hintedCategory = "",
  categoryMapping = {},
}: NormalizeCategoryOptions = {}): NormalizeCategoryResult {
  const mappedValue = mappingValue(categoryMapping, rawCategory);
  const mapped = mappedValue ? categoryIdForClassification(mappedValue) : null;
  let primaryCategoryId = mapped;
  let source: CategoryNormalizationSource = mapped ? "shop_mapping" : "unclassified";
  if (!primaryCategoryId && rawCategory) {
    primaryCategoryId = categoryIdForClassification(rawCategory) || inferLeaf(rawCategory);
    if (primaryCategoryId)
      source = categoryIdForClassification(rawCategory) ? "global_alias" : "raw_inference";
  }
  if (!primaryCategoryId && hintedCategory) {
    primaryCategoryId = categoryIdForClassification(hintedCategory) || inferLeaf(hintedCategory);
    if (primaryCategoryId) source = "parser_hint";
  }
  if (!primaryCategoryId && title) {
    primaryCategoryId = inferLeaf(title);
    if (primaryCategoryId) source = "title_inference";
  }
  primaryCategoryId ||= "other";
  const primary = getCategory(primaryCategoryId) ?? getCategory("other");
  if (!primary) throw new Error("Missing required fallback category: other");
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
