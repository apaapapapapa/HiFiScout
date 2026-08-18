import type { ClassifiableCategoryId } from "./types.js";

/**
 * Ordered match table: the first pattern that matches wins, so entry order is behaviour.
 * The explicit tuple element type stops TypeScript widening each pair to
 * `(string | RegExp)[]`, which would erase the category id at every call site.
 */
const RULES: readonly (readonly [ClassifiableCategoryId, RegExp])[] = [
  ["cable_usb", /\busb\b.*(?:\bcables?\b|interconnect)|usb\s*ケーブル|オーディオusbケーブル/i],
  [
    "cable_lan",
    /\b(?:lan|ethernet|network)\b.*\bcables?\b|(?:lan|イーサネット|ネットワーク)\s*ケーブル/i,
  ],
  [
    "cable_phono",
    /\b(?:phono|tonearm)\b.*(?:\bcables?\b|interconnect)|フォノ(?:用)?ケーブル|トーンアームケーブル/i,
  ],
  [
    "cable_power",
    /\b(?:ac|power|mains)\b.*(?:\bcables?\b|cord)|(?:電源|ac)\s*(?:ケーブル|コード)/i,
  ],
  [
    "cable_digital",
    /\b(?:digital|s\/?pdif|aes\/?ebu|toslink|optical|coaxial|hdmi)\b.*(?:\bcables?\b|interconnect)|(?:デジタル|同軸デジタル|光デジタル|hdmi)\s*ケーブル/i,
  ],
  ["cable_xlr", /\bxlr\b.*(?:\bcables?\b|interconnect)|xlr\s*(?:ケーブル|インターコネクト)/i],
  ["cable_rca", /\brca\b.*(?:\bcables?\b|interconnect)|rca\s*(?:ケーブル|インターコネクト)/i],
  ["cable_other", /\bcables?\b|ケーブル/i],
  [
    "clean_power",
    /power\s*(?:conditioner|regenerator)|ac\s*regenerator|clean\s*power|クリーン電源|電源コンディショナ(?:ー)?|電源リジェネレータ(?:ー)?/i,
  ],
  ["power_strip", /power\s*(?:strip|distributor|distribution)|電源タップ|電源ボックス/i],
  [
    "network_switch",
    /switching\s+hub|network\s+switch|ethernet\s+switch|スイッチングハブ|ネットワークスイッチ/i,
  ],
  [
    "optical_isolator",
    /optical\s+isolator|fiber\s+isolator|fibre\s+isolator|光アイソレータ(?:ー)?|光絶縁/i,
  ],
  ["router", /\b(?:audio\s+)?router\b|オーディオルータ(?:ー)?|ルータ(?:ー)?/i],
  [
    "music_server",
    /music\s+server|audio\s+server|music\s+library\s+server|ミュージックサーバ(?:ー)?|オーディオサーバ(?:ー)?/i,
  ],
  [
    "master_clock",
    /master\s+clock(?:\s+generator)?|clock\s+generator|マスタークロック(?:ジェネレータ(?:ー)?)?|クロックジェネレータ(?:ー)?/i,
  ],
  [
    "other_accessory",
    /\baccessor(?:y|ies)\b|insulator|インシュレータ(?:ー)?|アクセサリ(?:ー)?|hdmi\s*(?:switcher|switch)|hdmiスイッチャー|dust\s*cover|ダストカバー/i,
  ],
  ["vacuum_tube", /vacuum\s+tube|真空管/i],
  ["rack", /audio\s+rack|オーディオラック/i],
  [
    "av_amp",
    /\bav\s+(?:receiver|amplifier|amp)\b|audio\s+video\s+receiver|av(?:サラウンド)?(?:レシーバ(?:ー)?|アンプ)|\bavr[-\s]?[a-z0-9]/i,
  ],
  [
    "other",
    /voicing\s+equalizer|graphic\s+equalizer|(?<!phono\s)\bequalizer\b|音場補正|(?<!フォノ)イコライザ(?:ー)?|frequency\s+dividing\s+network|channel\s+divider|\bcrossover\b|チャンネル(?:デバイダ|ディバイダ)(?:ー)?|周波数分割|(?:dds\s+)?(?:fm|am\s*\/\s*fm)\s+stereo\s+tuner|\btuner\b|チューナー/i,
  ],
  ["integrated_amp", /integrated\s+(?:amp|amplifier)|プリメインアンプ|インテグレーテッドアンプ/i],
  [
    "pre_amp",
    /pre[\s-]?(?:amp|amplifier)|control\s+(?:amp|amplifier)|linestage\s+preamplifier|プリアンプ|コントロールアンプ/i,
  ],
  ["power_amp", /power[\s-]?(?:amp|amplifier)|パワーアンプ/i],
  ["headphone_amp", /headphone[\s-]?(?:amp|amplifier)|ヘッドホンアンプ/i],
  [
    "cd_sacd_transport",
    /(?:network(?:\s+audio)?|streaming)\s+transport|ネットワーク(?:オーディオ)?トランスポート|ストリーミングトランスポート|(?:sacd|cd)\s*(?:\/\s*(?:sacd|cd))?\s*(?:transport|トランスポート)|super\s+audio\s+cd\s+transport|(?:cd|sacd)\s*\/\s*(?:sacd|cd)\s*トランスポート/i,
  ],
  [
    "network_player",
    /network\s+(?:audio\s+)?player|network\s+cd\s+receiver|streaming\s+player|ネットワーク(?:オーディオ)?(?:プレーヤー|プレイヤー)/i,
  ],
  [
    "cd_sacd_player",
    /network\s+cd\s+receiver|(?:sacd|cd)\s*(?:\/\s*(?:sacd|cd))?\s*(?:player|プレーヤー|プレイヤー)|(?:sacd\s*\/\s*cd|cd\s*\/\s*sacd)(?!\s*トランスポート)/i,
  ],
  [
    "phono_step_up_transformer",
    /(?:mc|moving\s+coil)\s+(?:step[\s-]*up\s+)?transformer|step[\s-]*up\s+transformer|(?:mc)?昇圧トランス/i,
  ],
  ["phono_eq", /phono\s+(?:equalizer|eq|stage)|フォノイコライザー|フォノアンプ/i],
  ["turntable", /\bturntable\b|record\s+player|ターンテーブル|レコード(?:プレーヤー|プレイヤー)/i],
  ["tonearm", /tone\s*arm|トーンアーム/i],
  ["cartridge", /\bcartridge\b|カートリッジ/i],
  [
    "dap",
    /\bdap\b|digital\s+audio\s+player|デジタルオーディオ(?:プレーヤー|プレイヤー)|ポータブルオーディオ(?:プレーヤー|プレイヤー)/i,
  ],
  [
    "active_speaker",
    /\bactive\b.*\bspeakers?\b|powered\s+(?:speakers?|monitors?)|アクティブ.*スピーカー|パワードスピーカー/i,
  ],
  ["center_speaker", /cent(?:er|re)(?:\s+channel)?\s+speaker|センター(?:・)?スピーカー/i],
  ["speaker_bookshelf", /bookshelf(?:\s+speaker)?|stand[\s-]?mount|ブックシェルフ(?:型)?/i],
  [
    "speaker_floorstanding",
    /floor[\s-]?standing|tower\s+speaker|トールボーイ|フロア型|フロアスタンディング/i,
  ],
  ["subwoofer", /sub[\s-]?woofer|サブウーファー/i],
  ["other", /\bsound\s*bars?\b|サウンドバー|\bspeakers?\b|スピーカー/i],
  [
    "btw_earphone",
    /(?:bluetooth|wireless|true\s+wireless|\btws\b).*?(?:earphones?|earbuds?|\biem\b)|(?:earphones?|earbuds?|\biem\b).*?(?:bluetooth|wireless|true\s+wireless|\btws\b)|(?:bluetooth|ワイヤレス|完全ワイヤレス).*?イヤホン|イヤホン.*?(?:bluetooth|ワイヤレス|完全ワイヤレス)/i,
  ],
  [
    "btw_headphone",
    /(?:bluetooth|wireless).*?headphones?|headphones?.*?(?:bluetooth|wireless)|(?:bluetooth|ワイヤレス).*?ヘッドホン|ヘッドホン.*?(?:bluetooth|ワイヤレス)/i,
  ],
  ["wired_earphone", /\bearphones?\b|\bearbuds?\b|\biem\b|イヤホン/i],
  ["wired_headphone", /\bheadphones?\b|ヘッドホン/i],
  ["dj_dtm", /\bdj\b|\bddj[-\s]|rekordbox|serato|\bmidi\b|オーディオインターフェース/i],
  [
    "dac",
    /\bdac\b|d\s*[/-]\s*a\s*(?:converter|コンバータ(?:ー)?)|da\s*コンバータ(?:ー)?|d\/aコンバータ(?:ー)?/i,
  ],
];

/**
 * The second argument is accepted (and ignored) so callers can document the text they are
 * matching: `{ context: "title" | "seller" | "hint" | "detail" }`. The rule table itself is
 * context-independent.
 */
export function inferExplicitCategoryIds(
  text: string = "",
  _options?: { context?: string },
): ClassifiableCategoryId[] {
  const value = String(text || "").normalize("NFKC");
  if (!value.trim()) return [];
  for (const [id, pattern] of RULES) {
    if (pattern.test(value)) return [id];
  }
  return [];
}
