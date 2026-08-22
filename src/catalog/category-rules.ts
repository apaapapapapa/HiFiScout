import type { ClassifiableCategoryId } from "./types.js";

/**
 * Digital audio player model families, each anchored to its own brand.
 *
 * A bare `M23` or `R6` identifies nothing, and matching one would be actively harmful: those
 * strings also appear in other brands' cable and earphone model numbers. Every family therefore
 * requires the brand token to appear in the same text, close to the model.
 *
 * The brand comes from the title rather than from `manufacturer_id` because none of these brands
 * are in `MANUFACTURER_SOURCE` yet — a rule keyed on the resolved id would classify nothing until
 * that separate brand-coverage work lands, and shop titles carry the brand anyway.
 *
 * Each entry lists only the families that are unambiguously players for that brand. Brands that
 * also sell amplifiers, dongles or earphones keep those out: FiiO's `K`/`Q`/`BTR`/`FH` lines,
 * Cayin's `C9`/`RU`, HiBy's `FC`, Shanling's `UA`/`ME` and Astell&Kern's `PA` are deliberately
 * absent, so a portable amplifier is still read as one.
 */
const DAP_MODEL_FAMILIES: readonly (readonly [brand: RegExp, models: RegExp])[] = [
  [/astell\s*&?\s*kern|アステル(?:アンドケルン)?/, /\b(?:kann|sp\d{3,4}|se\d{3}|sr\d{2})\b/],
  [/cayin|カイン/, /\bn\d{1,2}[a-z]{0,3}\b/],
  [/hiby|ハイビー/, /\brs?\d{1,2}(?:\s*(?:i{1,3}|gen\s*\d|pro|saber))?\b/],
  [/fiio|フィーオ/, /\bm\d{1,2}[a-z]*\b/],
  [/shanling|シャンリン/, /\bm\d{1,2}[a-z]*\b/],
  [/ibasso|アイバッソ/, /\bdx\d{2,3}\b/],
  [/luxury\s*&?\s*precision|ラグジュアリー(?:アンドプレシジョン)?/, /\b(?:lp|p|e)\d{1,2}\b/],
];

/**
 * A bounded gap between the two halves, so a shop title that puts a katakana reading between brand
 * and model still matches while an unrelated brand elsewhere in the same string cannot lend its
 * name to a model number.
 */
const DAP_BRAND_MODEL_GAP = /[^]{0,32}?/;

/**
 * A player's model number also names the accessories sold for it, and those are not players.
 *
 * This guard is anchored to the beginning of the whole input, not to the position where the brand
 * happens to match. RegExp#test searches for a match at every position, so an unanchored lookahead
 * let titles such as `ケース Astell&Kern SP2000` skip past the accessory word and start matching at
 * `Astell&Kern`. Blocking on the whole title keeps accessory-first and accessory-last spellings
 * symmetric. A genuine player whose title advertises a bundled case remains conservatively
 * unclassified so enrichment or the Knowledge Catalog can recover it instead of assigning a wrong
 * terminal label.
 */
const DAP_ACCESSORY_GUARD =
  /^(?![^]*(?:ケース|カバー|フィルム|ストラップ|\bcase\b|\bcover\b|\bfilm\b|\bstrap\b))/;

const DAP_MODEL_PATTERN = new RegExp(
  `${DAP_ACCESSORY_GUARD.source}[^]*?(?:${DAP_MODEL_FAMILIES.map(
    ([brand, models]) => `(?:${brand.source})${DAP_BRAND_MODEL_GAP.source}(?:${models.source})`,
  ).join("|")})`,
  "i",
);

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
  // "vacuum tube" describes the implementation of an amplifier as often as it describes a
  // replacement tube. Product-type amplifier evidence must therefore win before the tube-accessory
  // fallback; a bare 12AX7/真空管 listing still lands here.
  ["vacuum_tube", /vacuum\s+tube|真空管/i],
  [
    "transport",
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
  [
    "turntable",
    /\bturntable\b|record\s+player|ターンテーブル|(?:レコード|アナログ)(?:プレーヤー|プレイヤー)/i,
  ],
  ["tonearm", /tone\s*arm|トーンアーム/i],
  ["headshell", /\bhead\s*shell\b|ヘッドシェル/i],
  ["cartridge", /\bcartridge\b|カートリッジ/i],
  [
    "dap",
    /\bdap\b|digital\s+audio\s+player|デジタルオーディオ(?:プレーヤー|プレイヤー)|ポータブルオーディオ(?:プレーヤー|プレイヤー)/i,
  ],
  // Deliberately below the cable, amplifier and earphone-word rules above: an explicit product-type
  // word in the title beats a model number every time, so a brand's replacement cable or portable
  // amplifier keeps its own category even though the brand also makes players.
  ["dap", DAP_MODEL_PATTERN],
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
  ["subwoofer", /sub[\s-]?woofer|スーパーウーファー|サブウーファー/i],
  // Soundbars only. A generic "speaker" word must NOT resolve here: `other` is a terminal leaf, and
  // `enrichProductCategories()` skips classified products, so labelling a bare `2Wayスピーカー` as
  // "その他" froze it permanently — worse than leaving it unclassified, where the detail-page and
  // Knowledge Catalog paths can still reach it. The alternative was introduced by the
  // `speaker_other` leaf removal (#189) rewriting that id to `other`, not by a design decision.
  // Do not add a generic classifiable speaker leaf back: `speaker` is `classifiable:false` on
  // purpose, and a "その他スピーカー" bucket is useless as a buyer-facing filter.
  ["other", /\bsound\s*bars?\b|サウンドバー/i],
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
