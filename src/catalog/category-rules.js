const COMMON_RULES = [
  ['speaker', /\bspeakers?\b|スピーカー|ブックシェルフ(?:型)?|フロア型/i],
  ['integrated_amp', /integrated\s+(?:amp|amplifier)|プリメインアンプ|インテグレーテッドアンプ/i],
  ['pre_amp', /pre[\s-]?(?:amp|amplifier)|control\s+(?:amp|amplifier)|プリアンプ|コントロールアンプ/i],
  ['power_amp', /power[\s-]?(?:amp|amplifier)|パワーアンプ/i],
  ['headphone_amp', /headphone[\s-]?(?:amp|amplifier)|ヘッドホンアンプ/i],
  ['dac', /\bdac\b|d\s*[\/\-]\s*a\s*(?:converter|コンバータ(?:ー)?)|da\s*コンバータ(?:ー)?|d\/aコンバータ(?:ー)?/i],
  ['network_transport', /network\s+transport|streaming\s+transport|ネットワークトランスポート/i],
  ['network_player', /network\s+(?:audio\s+)?player|streaming\s+player|ネットワーク(?:オーディオ)?(?:プレーヤー|プレイヤー)/i],
  ['phono_eq', /phono\s+(?:equalizer|eq|stage)|フォノイコライザー|フォノアンプ/i],
  ['turntable', /\bturntable\b|record\s+player|ターンテーブル|レコード(?:プレーヤー|プレイヤー)/i],
  ['tonearm', /tone\s*arm|トーンアーム/i],
  ['cartridge', /\bcartridge\b|カートリッジ/i],
  ['dap', /\bdap\b|digital\s+audio\s+player|デジタルオーディオ(?:プレーヤー|プレイヤー)|ポータブルオーディオ(?:プレーヤー|プレイヤー)/i],
  ['earphone', /\bearphones?\b|\biem\b|イヤホン/i],
  ['headphone', /\bheadphones?\b|ヘッドホン/i],
  ['vacuum_tube', /vacuum\s+tube|真空管/i],
  ['rack', /audio\s+rack|オーディオラック/i],
  ['dj_dtm', /\bdj\b|\bddj[-\s]|rekordbox|serato|\bmidi\b|オーディオインターフェース/i],
  ['cable', /\bcables?\b|(?:usb|xlr|rca|lan|speaker|headphone|power)\s+cable|ケーブル/i],
  ['accessory', /\baccessor(?:y|ies)\b|insulator|インシュレータ(?:ー)?|アクセサリ(?:ー)?|電源タップ/i]
];

const TITLE_DISC_RULE = ['cd_sacd_player', /sacd\s*-?\s*\d[\w-]*|sacd\s*(?:\/\s*cd)?\s*(?:player|プレーヤー|プレイヤー)|cd\s*(?:\/\s*sacd)?\s*(?:player|プレーヤー|プレイヤー)|(?:sacd\s*\/\s*cd|cd\s*\/\s*sacd)\s*(?:player|プレーヤー|プレイヤー)?/i];
const DETAIL_DISC_RULE = ['cd_sacd_player', /sacd\s*(?:\/\s*cd)?\s*(?:player|プレーヤー|プレイヤー)|cd\s*(?:\/\s*sacd)?\s*(?:player|プレーヤー|プレイヤー)|(?:sacd\s*\/\s*cd|cd\s*\/\s*sacd)プレーヤー/i];

const AMPLIFIER_CATEGORY_IDS = new Set(['integrated_amp', 'pre_amp', 'power_amp', 'headphone_amp']);
const COMPONENT_CATEGORY_IDS = new Set([
  'speaker', 'integrated_amp', 'pre_amp', 'power_amp', 'headphone_amp', 'dac',
  'network_player', 'network_transport', 'cd_sacd_player', 'turntable', 'tonearm',
  'cartridge', 'phono_eq', 'dap', 'earphone', 'headphone'
]);

function unique(values) { return [...new Set(values)]; }

function resolveConflicts(values) {
  let ids = unique(values);
  const set = new Set(ids);
  if (set.has('network_transport')) ids = ids.filter(id => id !== 'network_player');
  if (set.has('headphone_amp')) ids = ids.filter(id => id !== 'headphone');
  if (set.has('vacuum_tube') && ids.some(id => AMPLIFIER_CATEGORY_IDS.has(id))) {
    ids = ids.filter(id => id !== 'vacuum_tube');
  }
  const accessoryId = set.has('cable') ? 'cable' : set.has('accessory') ? 'accessory' : null;
  if (accessoryId) {
    const remaining = ids.filter(id => !COMPONENT_CATEGORY_IDS.has(id));
    return unique([accessoryId, ...remaining.filter(id => id !== accessoryId)]);
  }
  return unique(ids);
}

export function inferExplicitCategoryIds(text = '', { context = 'title' } = {}) {
  const value = String(text || '').normalize('NFKC');
  if (!value.trim()) return [];
  const rules = [...COMMON_RULES, context === 'detail' ? DETAIL_DISC_RULE : TITLE_DISC_RULE];
  const ids = [];
  for (const [id, pattern] of rules) if (pattern.test(value)) ids.push(id);
  return resolveConflicts(ids);
}
