import { inferExplicitCategoryIds } from './category-rules.js';

const CATEGORY_DEFINITIONS = [
  { id: 'amplifier', name: 'アンプ', parentId: null, order: 1, classifiable: false, filterable: true, aliases: ['amplifier', 'アンプ'] },
  { id: 'integrated_amp', name: 'プリメインアンプ', parentId: 'amplifier', order: 1, classifiable: true, filterable: true, aliases: ['integrated amp', 'integrated amplifier', 'プリメインアンプ'] },
  { id: 'pre_amp', name: 'プリアンプ', parentId: 'amplifier', order: 2, classifiable: true, filterable: true, aliases: ['preamp', 'pre amplifier', 'control amplifier', 'control amp', 'linestage preamplifier', 'プリアンプ', 'コントロールアンプ'] },
  { id: 'power_amp', name: 'パワーアンプ', parentId: 'amplifier', order: 3, classifiable: true, filterable: true, aliases: ['power amp', 'power amplifier', 'パワーアンプ'] },
  { id: 'headphone_amp', name: 'ヘッドホンアンプ', parentId: 'amplifier', order: 4, classifiable: true, filterable: true, aliases: ['headphone amp', 'headphone amplifier', 'ヘッドホンアンプ'] },

  { id: 'digital', name: 'デジタル', parentId: null, order: 2, classifiable: false, filterable: true, aliases: ['digital audio', 'デジタル'] },
  { id: 'dac', name: 'DAC', parentId: 'digital', order: 1, classifiable: true, filterable: true, aliases: ['dac', 'd/a converter', 'd-a converter', 'da converter', 'd/aコンバーター', 'daコンバーター', 'd/aコンバータ', 'daコンバータ'] },
  { id: 'network_player', name: 'ネットワークプレーヤー', parentId: 'digital', order: 2, classifiable: true, filterable: true, aliases: ['network player', 'network transport', 'network cd receiver', 'streamer', 'streaming player', 'streaming transport', 'ネットワークプレーヤー', 'ネットワークプレイヤー', 'ネットワークトランスポート', 'ネットワーク'] },
  { id: 'cd_sacd_player', name: 'CD/SACDプレーヤー', parentId: 'digital', order: 3, classifiable: true, filterable: true, aliases: ['cd player', 'cd transport', 'sacd player', 'sacd transport', 'super audio cd transport', 'sacd/cd player', 'cdプレーヤー', 'cdトランスポート', 'sacdプレーヤー', 'sacdトランスポート', 'sacd/cdプレーヤー', 'cd/sacdプレーヤー'] },
  { id: 'dap', name: 'DAP', parentId: 'digital', order: 4, classifiable: true, filterable: true, aliases: ['dap', 'digital audio player', 'デジタルオーディオプレーヤー', 'ポータブルプレーヤー', 'ポータブルプレイヤー'] },

  { id: 'analog', name: 'アナログ', parentId: null, order: 3, classifiable: false, filterable: true, aliases: ['analog', 'analogue', 'アナログ'] },
  { id: 'turntable', name: 'レコードプレーヤー', parentId: 'analog', order: 1, classifiable: true, filterable: true, aliases: ['turntable', 'record player', 'レコードプレーヤー', 'レコードプレイヤー', 'ターンテーブル'] },
  { id: 'tonearm', name: 'トーンアーム', parentId: 'analog', order: 2, classifiable: true, filterable: true, aliases: ['tonearm', 'tone arm', 'トーンアーム'] },
  { id: 'cartridge', name: 'カートリッジ', parentId: 'analog', order: 3, classifiable: true, filterable: true, aliases: ['cartridge', 'カートリッジ'] },
  { id: 'phono_eq', name: 'フォノイコライザー', parentId: 'analog', order: 4, classifiable: true, filterable: true, aliases: ['phono equalizer', 'phono eq', 'phono stage', 'フォノイコライザー', 'フォノアンプ'] },

  { id: 'speaker', name: 'スピーカー', parentId: null, order: 4, classifiable: false, filterable: true, aliases: ['speaker', 'speakers', 'スピーカー'] },
  { id: 'speaker_bookshelf', name: 'ブックシェルフ', parentId: 'speaker', order: 1, classifiable: true, filterable: true, aliases: ['bookshelf', 'bookshelf speaker', 'standmount', 'stand-mount', 'ブックシェルフ', 'ブックシェルフ型'] },
  { id: 'speaker_floorstanding', name: 'フロア型', parentId: 'speaker', order: 2, classifiable: true, filterable: true, aliases: ['floorstanding', 'floor-standing', 'tower speaker', 'トールボーイ', 'フロア型', 'フロアスタンディング'] },
  { id: 'subwoofer', name: 'サブウーファー', parentId: 'speaker', order: 3, classifiable: true, filterable: true, aliases: ['subwoofer', 'sub-woofer', 'サブウーファー'] },
  { id: 'speaker_other', name: 'その他スピーカー', parentId: 'speaker', order: 4, classifiable: true, filterable: true, aliases: ['speaker system', 'speaker-system', 'soundbar', 'sound bar', 'サウンドバー', 'その他スピーカー'] },

  { id: 'headphone_group', name: 'ヘッドホン', parentId: null, order: 5, classifiable: false, filterable: true, aliases: ['headphone group', 'ヘッドホン・イヤホン'] },
  { id: 'headphone', name: 'ヘッドホン', parentId: 'headphone_group', order: 1, classifiable: true, filterable: true, aliases: ['headphone', 'headphones', 'ヘッドホン'] },
  { id: 'earphone', name: 'イヤホン', parentId: 'headphone_group', order: 2, classifiable: true, filterable: true, aliases: ['earphone', 'earphones', 'earbud', 'earbuds', 'iem', 'イヤホン'] },

  { id: 'accessories', name: 'アクセサリー', parentId: null, order: 6, classifiable: false, filterable: true, aliases: ['accessories', 'アクセサリー'] },
  { id: 'cable', name: 'ケーブル', parentId: 'accessories', order: 1, classifiable: true, filterable: true, aliases: ['cable', 'cables', 'ケーブル'] },
  { id: 'rack', name: 'オーディオラック', parentId: 'accessories', order: 2, classifiable: true, filterable: true, aliases: ['audio rack', 'rack', 'オーディオラック', 'ラック'] },
  { id: 'power_accessory', name: '電源関連', parentId: 'accessories', order: 3, classifiable: true, filterable: true, aliases: ['power accessory', 'power conditioner', 'power strip', '電源タップ', '電源コンディショナー', '電源コンディショナ'] },
  { id: 'vacuum_tube', name: '真空管', parentId: 'accessories', order: 4, classifiable: true, filterable: true, aliases: ['vacuum tube', 'tube', '真空管'] },
  { id: 'other_accessory', name: 'その他アクセサリー', parentId: 'accessories', order: 5, classifiable: true, filterable: true, aliases: ['accessory', 'other accessory', 'insulator', 'hdmi switcher', 'dust cover', 'master clock', 'clock generator', 'インシュレーター', 'インシュレータ', 'HDMIスイッチャー', 'ダストカバー', 'マスタークロック', 'クロックジェネレーター', 'その他アクセサリー'] },

  { id: 'dj_dtm', name: 'DJ機器・DTM', parentId: null, order: 7, classifiable: true, filterable: true, aliases: ['dj', 'ddj', 'dtm', 'rekordbox', 'serato', 'midi', 'オーディオインターフェース'] },
  { id: 'other', name: 'その他', parentId: null, order: 8, classifiable: true, filterable: true, aliases: ['その他', 'others', 'other', 'av receiver', 'av amplifier', 'av amp', 'tuner', 'equalizer', 'channel divider', 'frequency dividing network', 'AVアンプ', 'AVレシーバー', 'チューナー', 'イコライザー', 'チャンネルデバイダー'] }
].map(category => Object.freeze({ ...category, selectable: category.filterable }));

export const CATEGORIES = Object.freeze(CATEGORY_DEFINITIONS);
const CATEGORY_BY_ID = new Map(CATEGORIES.map(category => [category.id, category]));
const LEGACY_ALIASES = Object.freeze({ network_transport: 'network_player', accessory: 'other_accessory' });

function normalizeLookup(value = '') {
  return String(value).normalize('NFKC').trim().toLowerCase().replace(/[\s・･_\-/()（）]+/g, '');
}

function categoryIdFromAlias(value = '', { classifiableOnly = false } = {}) {
  const legacy = LEGACY_ALIASES[value];
  if (legacy) return legacy;
  const needle = normalizeLookup(value);
  if (!needle) return null;
  for (const category of CATEGORIES) {
    if (classifiableOnly && !category.classifiable) continue;
    if (normalizeLookup(category.id) === needle || normalizeLookup(category.name) === needle) return category.id;
    if (category.aliases.some(alias => normalizeLookup(alias) === needle)) return category.id;
  }
  return null;
}

function mappingValue(mapping, rawCategory) {
  if (!mapping || !rawCategory) return null;
  const needle = normalizeLookup(rawCategory);
  for (const [raw, mapped] of Object.entries(mapping)) {
    if (normalizeLookup(raw) === needle) return Array.isArray(mapped) ? mapped[0] : mapped;
  }
  return null;
}

function inferLeaf(value = '') {
  return inferExplicitCategoryIds(value)[0] || null;
}

export function getCategory(categoryId) {
  return CATEGORY_BY_ID.get(LEGACY_ALIASES[categoryId] || categoryId) || null;
}

export function categoryIdForFilter(value = '') {
  const canonical = LEGACY_ALIASES[value] || value;
  if (CATEGORY_BY_ID.get(canonical)?.filterable) return canonical;
  return categoryIdFromAlias(value);
}

export function categoryIdForClassification(value = '') {
  const canonical = LEGACY_ALIASES[value] || value;
  if (CATEGORY_BY_ID.get(canonical)?.classifiable) return canonical;
  return categoryIdFromAlias(value, { classifiableOnly: true });
}

export function categoryClosureIds(categoryId) {
  const category = getCategory(categoryId);
  if (!category?.classifiable) return [];
  return category.parentId ? [category.id, category.parentId] : [category.id];
}

export function categoryFacet(categoryId) {
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
    group: parent?.name || null
  };
}

export function categorySearchAliases(categoryIds = []) {
  return [...new Set(categoryIds)].flatMap(id => {
    const category = getCategory(id);
    return category?.classifiable ? [category.name, ...category.aliases] : [];
  }).join(' ');
}

export function normalizeCategory({ rawCategory = '', title = '', hintedCategory = '', categoryMapping = {} } = {}) {
  const mapped = categoryIdForClassification(mappingValue(categoryMapping, rawCategory));
  let primaryCategoryId = mapped;
  let source = mapped ? 'shop_mapping' : 'unclassified';
  if (!primaryCategoryId && rawCategory) {
    primaryCategoryId = categoryIdForClassification(rawCategory) || inferLeaf(rawCategory);
    if (primaryCategoryId) source = categoryIdForClassification(rawCategory) ? 'global_alias' : 'raw_inference';
  }
  if (!primaryCategoryId && hintedCategory) {
    primaryCategoryId = categoryIdForClassification(hintedCategory) || inferLeaf(hintedCategory);
    if (primaryCategoryId) source = 'parser_hint';
  }
  if (!primaryCategoryId && title) {
    primaryCategoryId = inferLeaf(title);
    if (primaryCategoryId) source = 'title_inference';
  }
  primaryCategoryId ||= 'other';
  const primary = getCategory(primaryCategoryId) || getCategory('other');
  return {
    primaryCategoryId: primary.id,
    categoryIds: [primary.id],
    displayName: primary.name,
    classificationStatus: source === 'unclassified' ? 'unclassified' : 'classified',
    classificationSource: source,
    searchAliases: categorySearchAliases([primary.id])
  };
}

export function canonicalCategoryDefinitions() {
  return CATEGORIES;
}
