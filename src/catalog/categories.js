const CATEGORY_DEFINITIONS = [
  { id: 'speaker', name: 'スピーカー', parentId: null, aliases: ['speaker', 'speakers', 'スピーカー', 'speaker system', 'speaker-system'] },

  { id: 'amplifier', name: 'アンプ', parentId: null, selectable: false, aliases: ['amplifier', 'アンプ'] },
  { id: 'pre_amp', name: 'プリアンプ', parentId: 'amplifier', aliases: ['preamp', 'pre amplifier', 'control amplifier', 'control amp', 'プリアンプ', 'コントロールアンプ'] },
  { id: 'power_amp', name: 'パワーアンプ', parentId: 'amplifier', aliases: ['power amp', 'power amplifier', 'パワーアンプ'] },
  { id: 'integrated_amp', name: 'プリメインアンプ', parentId: 'amplifier', aliases: ['integrated amp', 'integrated amplifier', 'プリメインアンプ'] },
  { id: 'headphone_amp', name: 'ヘッドホンアンプ', parentId: 'amplifier', aliases: ['headphone amp', 'headphone amplifier', 'ヘッドホンアンプ'] },

  { id: 'digital', name: 'デジタル', parentId: null, selectable: false, aliases: ['digital audio', 'デジタル'] },
  { id: 'dac', name: 'DAC', parentId: 'digital', aliases: ['dac', 'd/a converter', 'd-a converter', 'da converter', 'd/aコンバーター', 'daコンバーター', 'd/aコンバータ', 'daコンバータ'] },
  { id: 'network_player', name: 'ネットワークプレーヤー', parentId: 'digital', aliases: ['network player', 'streamer', 'streaming player', 'ネットワークプレーヤー', 'ネットワークプレイヤー', 'ネットワーク'] },
  { id: 'network_transport', name: 'ネットワークトランスポート', parentId: 'digital', aliases: ['network transport', 'streaming transport', 'ネットワークトランスポート'] },
  { id: 'cd_sacd_player', name: 'CD/SACDプレーヤー', parentId: 'digital', aliases: ['cd player', 'sacd player', 'sacd/cd player', 'cdプレーヤー', 'cdプレイヤー', 'sacdプレーヤー', 'sacd/cdプレーヤー', 'cd/sacdプレーヤー'] },
  { id: 'dap', name: 'DAP', parentId: 'digital', aliases: ['dap', 'digital audio player', 'デジタルオーディオプレーヤー', 'ポータブルプレーヤー', 'ポータブルプレイヤー'] },

  { id: 'analog', name: 'アナログ', parentId: null, selectable: false, aliases: ['analog', 'analogue', 'アナログ'] },
  { id: 'turntable', name: 'レコードプレーヤー', parentId: 'analog', aliases: ['turntable', 'record player', 'レコードプレーヤー', 'レコードプレイヤー', 'ターンテーブル'] },
  { id: 'tonearm', name: 'トーンアーム', parentId: 'analog', aliases: ['tonearm', 'tone arm', 'トーンアーム'] },
  { id: 'cartridge', name: 'カートリッジ', parentId: 'analog', aliases: ['cartridge', 'カートリッジ'] },
  { id: 'phono_eq', name: 'フォノイコライザー', parentId: 'analog', aliases: ['phono equalizer', 'phono eq', 'phono stage', 'フォノイコライザー', 'フォノアンプ'] },

  { id: 'headphone', name: 'ヘッドホン', parentId: null, aliases: ['headphone', 'headphones', 'ヘッドホン'] },
  { id: 'earphone', name: 'イヤホン', parentId: null, aliases: ['earphone', 'earphones', 'iem', 'イヤホン'] },
  { id: 'cable', name: 'ケーブル', parentId: null, aliases: ['cable', 'cables', 'ケーブル'] },
  { id: 'rack', name: 'オーディオラック', parentId: null, aliases: ['audio rack', 'rack', 'オーディオラック', 'ラック'] },
  { id: 'vacuum_tube', name: '真空管', parentId: null, aliases: ['vacuum tube', 'tube', '真空管'] },
  { id: 'dj_dtm', name: 'DJ機器・DTM', parentId: null, aliases: ['dj', 'ddj', 'dtm', 'rekordbox', 'serato', 'midi', 'オーディオインターフェース'] },
  { id: 'accessory', name: 'アクセサリー', parentId: null, aliases: ['accessory', 'accessories', 'アクセサリー', 'インシュレーター', 'インシュレータ'] },
  { id: 'other', name: 'その他', parentId: null, aliases: ['その他', 'others', 'other'] }
].map(category => Object.freeze({ selectable: true, ...category }));

export const CATEGORIES = Object.freeze(CATEGORY_DEFINITIONS);
const CATEGORY_BY_ID = new Map(CATEGORIES.map(category => [category.id, category]));

const CATEGORY_RULES = [
  ['speaker', /speaker|スピーカー|monitor\s*audio|bookshelf/i],
  ['integrated_amp', /integrated(?:\s+amp(?:lifier)?)?|プリメイン|\bpma[-\s]?\w*/i],
  ['pre_amp', /pre[\s-]?amp|pre amplifier|control amplifier|control amp|プリアンプ|コントロールアンプ/i],
  ['power_amp', /power[\s-]?amp|power amplifier|パワーアンプ/i],
  ['headphone_amp', /headphone[\s-]?amp|headphone amplifier|ヘッドホンアンプ/i],
  ['dac', /\bdac\b|d\s*[/\-]\s*a(?:\s*(?:converter|コンバータ(?:ー)?))?|da\s*コンバータ(?:ー)?|wandla|tambaqui/i],
  ['network_transport', /network transport|streaming transport|ネットワークトランスポート/i],
  ['network_player', /network|streamer|streaming|ネットワーク|rivo|zen stream/i],
  ['cd_sacd_player', /sacd|cd\s*player|cdプレーヤ|cdプレイヤ|dcd[-\s]?/i],
  ['phono_eq', /phono equalizer|phono eq|phono stage|フォノイコ|フォノアンプ/i],
  ['turntable', /turntable|record player|ターンテーブル|レコードプレーヤ|レコードプレイヤ/i],
  ['tonearm', /tone\s*arm|tonearm|トーンアーム/i],
  ['cartridge', /cartridge|カートリッジ/i],
  ['dap', /\bdap\b|digital audio player|ポータブルプレーヤ|ポータブルプレイヤ/i],
  ['earphone', /earphone|イヤホン|\biem\b/i],
  ['headphone', /headphone|ヘッドホン|stax|d8000|susvara/i],
  ['vacuum_tube', /vacuum tube|真空管/i],
  ['rack', /audio rack|オーディオラック/i],
  ['dj_dtm', /\bdj\b|\bddj[-\s]|rekordbox|serato|midi|オーディオインターフェース/i],
  ['cable', /\bcable\b|ケーブル/i],
  ['accessory', /insulator|インシュレータ|アクセサリ|電源タップ/i]
];

const AMPLIFIER_CATEGORY_IDS = new Set(['integrated_amp', 'pre_amp', 'power_amp', 'headphone_amp']);
const COMPONENT_CATEGORY_IDS = new Set([
  'speaker', 'integrated_amp', 'pre_amp', 'power_amp', 'headphone_amp', 'dac',
  'network_player', 'network_transport', 'cd_sacd_player', 'turntable', 'tonearm',
  'cartridge', 'phono_eq', 'dap', 'earphone', 'headphone'
]);

function normalizeLookup(value = '') {
  return String(value)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s・･_\-\/()（）]+/g, '');
}

function mappingValue(mapping, rawCategory) {
  if (!mapping || !rawCategory) return null;
  const needle = normalizeLookup(rawCategory);
  for (const [raw, mapped] of Object.entries(mapping)) {
    if (normalizeLookup(raw) === needle) return mapped;
  }
  return null;
}

function validCategoryIds(values = []) {
  return [...new Set(values)].filter(id => CATEGORY_BY_ID.get(id)?.selectable);
}

function resolveInferenceConflicts(values) {
  let ids = validCategoryIds(values);
  const set = new Set(ids);

  // A network transport is a distinct seller category; the broad "network" rule must not
  // also turn it into a network player when classification is inferred from a title.
  if (set.has('network_transport')) ids = ids.filter(id => id !== 'network_player');

  // "headphone amplifier" contains the word "headphone" but is not a headphone itself.
  if (set.has('headphone_amp')) ids = ids.filter(id => id !== 'headphone');

  // Tube amplifiers are amplifiers, not loose vacuum tubes.
  if (set.has('vacuum_tube') && ids.some(id => AMPLIFIER_CATEGORY_IDS.has(id))) {
    ids = ids.filter(id => id !== 'vacuum_tube');
  }

  // Accessory/cable titles frequently contain the component they are intended for
  // (speaker cable, headphone cable, DAC accessory). Prefer the accessory product type.
  const accessoryId = set.has('cable') ? 'cable' : set.has('accessory') ? 'accessory' : null;
  if (accessoryId) {
    const remaining = ids.filter(id => !COMPONENT_CATEGORY_IDS.has(id));
    return validCategoryIds([accessoryId, ...remaining.filter(id => id !== accessoryId)]);
  }

  return validCategoryIds(ids);
}

function inferCategoryIds(text = '') {
  const ids = [];
  for (const [id, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) ids.push(id);
  }
  return resolveInferenceConflicts(ids);
}

function categoryIdFromAlias(value = '') {
  const needle = normalizeLookup(value);
  if (!needle) return null;
  for (const category of CATEGORIES) {
    if (!category.selectable) continue;
    if (normalizeLookup(category.name) === needle) return category.id;
    if (category.aliases.some(alias => normalizeLookup(alias) === needle)) return category.id;
  }
  return null;
}

export function getCategory(categoryId) {
  return CATEGORY_BY_ID.get(categoryId) || null;
}

export function categoryIdForFilter(value = '') {
  if (CATEGORY_BY_ID.get(value)?.selectable) return value;
  return categoryIdFromAlias(value);
}

export function categoryFacet(categoryId) {
  const category = getCategory(categoryId);
  if (!category?.selectable) return null;
  const parent = category.parentId ? getCategory(category.parentId) : null;
  return {
    id: category.id,
    name: category.name,
    parentId: category.parentId,
    group: parent?.name || null
  };
}

export function categorySearchAliases(categoryIds = []) {
  return validCategoryIds(categoryIds)
    .flatMap(id => {
      const category = getCategory(id);
      return [category.name, ...category.aliases];
    })
    .join(' ');
}

export function normalizeCategory({ rawCategory = '', title = '', hintedCategory = '', categoryMapping = {} } = {}) {
  const mapped = mappingValue(categoryMapping, rawCategory);
  let categoryIds = [];
  let primaryCategoryId = null;
  let source = 'unclassified';

  if (mapped) {
    const mappedIds = validCategoryIds(Array.isArray(mapped) ? mapped : [mapped]);
    if (mappedIds.length) {
      categoryIds = mappedIds;
      primaryCategoryId = mappedIds[0];
      source = 'shop_mapping';
    }
  }

  if (!categoryIds.length && rawCategory) {
    const exact = categoryIdFromAlias(rawCategory);
    if (exact) {
      categoryIds = [exact];
      primaryCategoryId = exact;
      source = 'global_alias';
    } else {
      categoryIds = inferCategoryIds(rawCategory);
      if (categoryIds.length) {
        primaryCategoryId = categoryIds[0];
        source = 'raw_inference';
      }
    }
  }

  if (!categoryIds.length && hintedCategory) {
    const exact = categoryIdFromAlias(hintedCategory);
    categoryIds = exact ? [exact] : inferCategoryIds(hintedCategory);
    if (categoryIds.length) {
      primaryCategoryId = categoryIds[0];
      source = 'parser_hint';
    }
  }

  if (!categoryIds.length) {
    categoryIds = inferCategoryIds(title);
    if (categoryIds.length) {
      primaryCategoryId = categoryIds[0];
      source = 'title_inference';
    }
  }

  if (!categoryIds.length) {
    categoryIds = ['other'];
    primaryCategoryId = 'other';
  }

  const primary = getCategory(primaryCategoryId) || getCategory('other');
  return {
    primaryCategoryId: primary.id,
    categoryIds,
    displayName: primary.name,
    classificationStatus: source === 'unclassified' ? 'unclassified' : 'classified',
    classificationSource: source,
    searchAliases: categorySearchAliases(categoryIds)
  };
}
