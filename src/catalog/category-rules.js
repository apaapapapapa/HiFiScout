const RULES = [
  ['cable', /\bcables?\b|(?:usb|xlr|rca|lan|speaker|headphone|power)\s+cable|ケーブル/i],
  ['power_accessory', /power\s*(?:strip|conditioner)|電源タップ|電源コンディショナ(?:ー)?/i],
  ['other_accessory', /\baccessor(?:y|ies)\b|insulator|インシュレータ(?:ー)?|アクセサリ(?:ー)?/i],
  ['vacuum_tube', /vacuum\s+tube|真空管/i],
  ['rack', /audio\s+rack|オーディオラック/i],
  ['integrated_amp', /integrated\s+(?:amp|amplifier)|プリメインアンプ|インテグレーテッドアンプ/i],
  ['pre_amp', /pre[\s-]?(?:amp|amplifier)|control\s+(?:amp|amplifier)|プリアンプ|コントロールアンプ/i],
  ['power_amp', /power[\s-]?(?:amp|amplifier)|パワーアンプ/i],
  ['headphone_amp', /headphone[\s-]?(?:amp|amplifier)|ヘッドホンアンプ/i],
  ['network_player', /network\s+(?:audio\s+)?(?:player|transport)|streaming\s+(?:player|transport)|ネットワーク(?:オーディオ)?(?:プレーヤー|プレイヤー|トランスポート)/i],
  ['cd_sacd_player', /(?:sacd|cd)\s*(?:\/\s*(?:sacd|cd))?\s*(?:player|transport|プレーヤー|プレイヤー|トランスポート)|(?:sacd\s*\/\s*cd|cd\s*\/\s*sacd)/i],
  ['phono_eq', /phono\s+(?:equalizer|eq|stage)|フォノイコライザー|フォノアンプ/i],
  ['turntable', /\bturntable\b|record\s+player|ターンテーブル|レコード(?:プレーヤー|プレイヤー)/i],
  ['tonearm', /tone\s*arm|トーンアーム/i],
  ['cartridge', /\bcartridge\b|カートリッジ/i],
  ['dap', /\bdap\b|digital\s+audio\s+player|デジタルオーディオ(?:プレーヤー|プレイヤー)|ポータブルオーディオ(?:プレーヤー|プレイヤー)/i],
  ['speaker_bookshelf', /bookshelf(?:\s+speaker)?|stand[\s-]?mount|ブックシェルフ(?:型)?/i],
  ['speaker_floorstanding', /floor[\s-]?standing|tower\s+speaker|トールボーイ|フロア型|フロアスタンディング/i],
  ['subwoofer', /sub[\s-]?woofer|サブウーファー/i],
  ['speaker_other', /\bspeakers?\b|スピーカー/i],
  ['earphone', /\bearphones?\b|\biem\b|イヤホン/i],
  ['headphone', /\bheadphones?\b|ヘッドホン/i],
  ['dj_dtm', /\bdj\b|\bddj[-\s]|rekordbox|serato|\bmidi\b|オーディオインターフェース/i],
  ['dac', /\bdac\b|d\s*[\/\-]\s*a\s*(?:converter|コンバータ(?:ー)?)|da\s*コンバータ(?:ー)?|d\/aコンバータ(?:ー)?/i]
];

export function inferExplicitCategoryIds(text = '') {
  const value = String(text || '').normalize('NFKC');
  if (!value.trim()) return [];
  for (const [id, pattern] of RULES) {
    if (pattern.test(value)) return [id];
  }
  return [];
}
