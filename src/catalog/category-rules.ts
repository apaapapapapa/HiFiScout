import type { ClassifiableCategoryId } from "./types.js";

/** Product-type-only inference. Properties are inferred independently in `product-facets.ts`. */
const DAP_MODEL_FAMILIES: readonly (readonly [RegExp, RegExp])[] = [
  [/astell\s*&?\s*kern|アステル(?:アンドケルン)?/, /\b(?:kann|sp\d{3,4}|se\d{3}|sr\d{2})\b/],
  [/cayin|カイン/, /\bn\d{1,2}[a-z]{0,3}\b/],
  [/hiby|ハイビー/, /\brs?\d{1,2}(?:\s*(?:i{1,3}|gen\s*\d|pro|saber))?\b/],
  [/fiio|フィーオ/, /\bm\d{1,2}[a-z]*\b/],
  [/shanling|シャンリン/, /\bm\d{1,2}[a-z]*\b/],
  [/ibasso|アイバッソ/, /\bdx\d{2,3}\b/],
  [/luxury\s*&?\s*precision|ラグジュアリー(?:アンドプレシジョン)?/, /\b(?:lp|p|e)\d{1,2}\b/],
];
const DAP_ACCESSORY_GUARD = /^(?![^]*(?:ケース|カバー|フィルム|ストラップ|\bcase\b|\bcover\b|\bfilm\b|\bstrap\b))/;
const DAP_MODEL_PATTERN = new RegExp(
  `${DAP_ACCESSORY_GUARD.source}[^]*?(?:${DAP_MODEL_FAMILIES.map(([brand, models]) => `(?:${brand.source})[^]{0,32}?(?:${models.source})`).join("|")})`,
  "i",
);

/** `SYS.MULTIFUNCTION` requires explicit co-equal positioning and at least three major roles. */
function isCoEqualMultifunction(value: string): boolean {
  if (!/(?:all[\s-]*in[\s-]*one|multi[\s-]*function|複合オーディオ|オールインワン)/i.test(value)) return false;
  if (/integrated\s+(?:amp|amplifier)|プリメインアンプ|network\s+(?:audio\s+)?player|streaming\s+player|receiver|レシーバ|disc\s+player|cd\s*\/\s*sacd\s*プレーヤー/i.test(value)) return false;
  const roles = [
    /\bdac\b|d\s*[/-]\s*a\s*(?:converter|コンバータ(?:ー)?)/i,
    /headphone[\s-]*(?:amp|amplifier)|ヘッドホンアンプ/i,
    /stream(?:er|ing)|network\s+(?:playback|transport)|ネットワーク再生/i,
    /pre[\s-]?(?:amp|amplifier)|プリアンプ/i,
    /power[\s-]?(?:amp|amplifier)|パワーアンプ/i,
    /music\s+server|ミュージックサーバ/i,
  ].filter((pattern) => pattern.test(value));
  return roles.length >= 3;
}

const RULES: readonly (readonly [ClassifiableCategoryId, RegExp])[] = [
  ["PWR.CORD", /\b(?:ac|power|mains)\b.*(?:\bcables?\b|cord)|(?:電源|ac)\s*(?:ケーブル|コード)/i],
  ["CAB.DATA", /\b(?:usb|lan|ethernet|network)\b.*\bcables?\b|(?:usb|lan|イーサネット|ネットワーク)\s*ケーブル/i],
  ["CAB.DIGITAL", /\b(?:digital|s\/?pdif|aes\/?ebu|aes3|toslink|optical|coaxial|hdmi)\b.*(?:\bcables?\b|interconnect)|(?:デジタル|同軸デジタル|光デジタル|hdmi|aes\/?ebu)\s*ケーブル/i],
  ["CAB.SPEAKER", /speaker\s+cables?|スピーカーケーブル/i],
  ["CAB.PERSONAL", /(?:headphone|earphone|iem)\s+cables?|(?:ヘッドホン|イヤホン|iem)\s*ケーブル|リケーブル/i],
  ["CAB.ANALOG", /\b(?:phono|tonearm|xlr|rca|analog|balanced)\b.*(?:\bcables?\b|interconnect)|(?:フォノ|トーンアーム|xlr|rca|アナログ|バランス)\s*(?:ケーブル|インターコネクト)/i],
  ["CAB.ADAPTER", /passive\s+(?:adapter|splitter)|(?:無増幅|パッシブ)(?:変換|分岐)|変換プラグ/i],
  ["PWR.REGEN", /ac\s*regenerator|power\s*regenerator|電源リジェネレータ(?:ー)?/i],
  ["PWR.CONDITIONER", /power\s*conditioner|clean\s*power|isolation\s*transformer|クリーン電源|電源コンディショナ(?:ー)?|アイソレーション(?:トランス)?/i],
  ["PWR.DISTRIBUTION", /power\s*(?:strip|distributor|distribution)|電源タップ|電源ボックス|pdu\b/i],
  ["PWR.SUPPLY", /linear\s+(?:power\s+)?supply|external\s+power\s+supply|\b(?:ac|dc)\s*power\s*supply|リニア電源|外部電源|dc電源/i],
  ["PWR.BATTERY", /\bups\b|battery\s+(?:power|supply)|バッテリー電源|無停電電源/i],
  ["SIG.NETWORK", /switching\s+hub|network\s+switch|ethernet\s+switch|audio\s+router|スイッチングハブ|ネットワークスイッチ|オーディオルータ(?:ー)?/i],
  ["SIG.ISOLATOR", /(?:signal|usb|lan|optical|fiber|fibre|analog)\s+isolator|光アイソレータ(?:ー)?|信号アイソレータ(?:ー)?|光絶縁/i],
  ["SIG.SELECTOR", /(?:audio|signal|input)?\s*(?:selector|distributor|matrix)|セレクタ(?:ー)?|ディストリビュータ(?:ー)?|分配器/i],
  ["SIG.WIRELESS", /wireless\s+(?:transmitter|receiver|adapter)|bluetooth\s+(?:transmitter|receiver|adapter)|ワイヤレス(?:送信機|受信機|アダプタ)|bluetooth(?:送信機|受信機)/i],
  ["AMP.INTEGRATED", /integrated\s+(?:amp|amplifier)|プリメインアンプ|インテグレーテッドアンプ/i],
  ["AMP.RECEIVER", /\b(?:stereo|av|audio\s+video)\s+(?:receiver|amplifier|amp)\b|network\s+receiver|av(?:サラウンド)?(?:レシーバ(?:ー)?|アンプ)|\bavr[-\s]?[a-z0-9]|ステレオレシーバ(?:ー)?/i],
  ["PRC.PROCESSOR", /av\s+(?:preamp|pre[\s-]?pro|processor)|surround\s+processor|room\s+correction|audio\s+processor|graphic\s+equalizer|(?<!phono\s)\bequalizer\b|channel\s+divider|\bcrossover\b|avプリアンプ|サラウンドプロセッサ|音場補正|ルーム補正|(?<!フォノ)イコライザ(?:ー)?|チャンネル(?:デバイダ|ディバイダ)(?:ー)?|周波数分割/i],
  ["AMP.PRE", /pre[\s-]?(?:amp|amplifier)|control\s+(?:amp|amplifier)|linestage\s+preamplifier|プリアンプ|コントロールアンプ/i],
  ["AMP.POWER", /power[\s-]?(?:amp|amplifier)|パワーアンプ/i],
  ["AMP.HEADPHONE", /headphone[\s-]?(?:amp|amplifier)|energizer|ヘッドホンアンプ|エナジャイザー/i],
  ["AMP.STEPUP", /(?:mc|moving\s+coil)\s+(?:step[\s-]*up\s+)?transformer|step[\s-]*up\s+transformer|(?:mc)?昇圧トランス|ヘッドアンプ/i],
  ["AMP.PHONO", /phono\s+(?:equalizer|eq|stage|amp)|フォノイコライザー|フォノアンプ/i],
  ["SRC.STREAMER", /network\s+(?:audio\s+)?(?:player|transport)|network\s+cd\s+receiver|streaming\s+(?:player|transport)|\bstreamer\b|ネットワーク(?:オーディオ)?(?:プレーヤー|プレイヤー|トランスポート)|ストリーミングトランスポート/i],
  ["SRC.DISC", /(?:sacd|cd|dvd|blu[\s-]?ray)\s*(?:\/\s*(?:sacd|cd|dvd))?\s*(?:player|transport|プレーヤー|プレイヤー|トランスポート)|super\s+audio\s+cd\s+transport|disc\s+(?:player|transport)|(?:sacd\s*\/\s*cd|cd\s*\/\s*sacd)/i],
  ["SRC.SERVER", /music\s+(?:server|ripper)|audio\s+server|music\s+library\s+server|ミュージックサーバ(?:ー)?|オーディオサーバ(?:ー)?|リッパー/i],
  ["SRC.TUNER", /(?:dds\s+)?(?:fm|am\s*\/\s*fm)\s+stereo\s+tuner|\btuner\b|チューナー/i],
  ["SRC.DAP", /\bdap\b|digital\s+audio\s+player|デジタルオーディオ(?:プレーヤー|プレイヤー)|ポータブルオーディオ(?:プレーヤー|プレイヤー)/i],
  ["SRC.DAP", DAP_MODEL_PATTERN],
  ["PRC.DDC", /\bddc\b|digital\s+(?:interface|format)\s+(?:converter|bridge)|usb\s+bridge|reclocker|デジタル(?:インターフェース|フォーマット)変換|リクロッカ(?:ー)?/i],
  ["PRC.ADC", /\badc\b|a\s*[/-]\s*d\s*(?:converter|コンバータ(?:ー)?)|ad\s*コンバータ(?:ー)?/i],
  ["PRC.CLOCK", /master\s+clock(?:\s+generator)?|clock\s+generator|マスタークロック(?:ジェネレータ(?:ー)?)?|クロックジェネレータ(?:ー)?/i],
  ["PRC.DAC", /\bdac\b|d\s*[/-]\s*a\s*(?:converter|コンバータ(?:ー)?)|da\s*コンバータ(?:ー)?|d\/aコンバータ(?:ー)?/i],
  ["ANA.TURNTABLE", /\bturntable\b|record\s+player|ターンテーブル|(?:レコード|アナログ)(?:プレーヤー|プレイヤー)/i],
  ["ANA.TONEARM", /tone\s*arm|トーンアーム/i],
  ["ANA.HEADSHELL", /\bhead\s*shell\b|ヘッドシェル/i],
  ["ANA.STYLUS", /replacement\s+stylus|交換針|レコード針/i],
  ["ANA.CARTRIDGE", /\bcartridge\b|カートリッジ/i],
  ["ANA.TAPE", /tape\s+deck|cassette\s+deck|open[\s-]*reel|テープデッキ|カセットデッキ|オープンリール/i],
  ["ACC.FURNITURE", /audio\s+(?:rack|furniture)|オーディオラック|オーディオ家具/i],
  ["ACC.STAND", /speaker\s+stand|headphone\s+stand|equipment\s+(?:stand|mount)|スピーカースタンド|ヘッドホンスタンド|機器スタンド|マウント/i],
  ["ACC.ISOLATION", /insulator|isolation\s+(?:board|footer)|spike|インシュレータ(?:ー)?|オーディオボード|フッタ(?:ー)?|スパイク/i],
  ["ACC.ACOUSTIC", /acoustic\s+(?:panel|absorber|diffuser|treatment)|bass\s+trap|吸音|拡散パネル|ルームアコースティック|ベーストラップ/i],
  ["ACC.WEAR", /ear\s*(?:pad|tip)|headband|イヤーパッド|イヤーピース|ヘッドバンド/i],
  ["ACC.CASE", /(?:equipment|headphone|earphone|record)?\s*(?:case|cover|bag)|ケース|カバー|バッグ|ダストカバー/i],
  ["ACC.MAINTENANCE", /clean(?:er|ing)|maintenance|stylus\s+brush|クリーニング|メンテナンス|接点復活/i],
  ["ACC.TUBE", /vacuum\s+tube|replacement\s+tube|真空管/i],
  ["ACC.PART", /replacement\s+(?:driver|terminal|knob|board)|diy\s+part|交換部品|補修部品|ドライバーユニット|ターミナル|ノブ/i],
  ["SPK.SUBWOOFER", /sub[\s-]?woofer|スーパーウーファー|サブウーファー/i],
  ["SPK.SOUNDBAR", /\bsound\s*bars?\b|サウンドバー/i],
  ["SPK.LOUDSPEAKER", /\b(?:active|powered|bookshelf|stand[\s-]?mount|floor[\s-]?standing|tower|cent(?:er|re)(?:\s+channel)?|surround)?\s*(?:loud)?speakers?\b|powered\s+monitors?|アクティブ.*スピーカー|パワードスピーカー|ブックシェルフ(?:型)?|トールボーイ|フロア型|フロアスタンディング|センター(?:・)?スピーカー|サラウンドスピーカー|スピーカー/i],
  ["PER.EARPHONE", /\bwf-\d|\btour\s+pro\b|\bopen(?:fit|dots|run)\w*\b|\bairpods\b(?!\s*max)|\blinkbuds\b|\bfreebuds\b|quietcomfort.*\bearbuds?\b/i],
  ["PER.HEADPHONE", /\bwh-\d{4}|\bwi-\d|quietcomfort\s+(?:ultra\s+)?headphones|\bpx[78]\b|\bmomentum\s+\d+\s+wireless\b|\bairpods\s+max\b/i],
  ["PER.EARPHONE", /\bearphones?\b|\bearbuds?\b|\biem\b|イヤホン|イヤーモニター/i],
  ["PER.HEADPHONE", /\bheadphones?\b|\bheadset\b|ヘッドホン|ヘッドセット/i],
  ["REC.INTERFACE", /audio\s+interface|オーディオインターフェース/i],
  ["REC.MICPRE", /mic(?:rophone)?\s+pre(?:amp)?|channel\s+strip|マイクプリ|チャンネルストリップ/i],
  ["REC.MONITOR", /monitor\s+controller|モニターコントローラ(?:ー)?/i],
  ["REC.MIXER", /mixing\s+console|audio\s+mixer|ミキサー|ミキシングコンソール/i],
  ["REC.RECORDER", /field\s+recorder|digital\s+recorder|レコーダー|録音機/i],
  ["REC.MIC", /\bmicrophones?\b|\bmic\b|マイクロフォン|マイク(?:$|\s)/i],
  ["REC.DJ", /dj\s+(?:controller|player|system)|\bddj[-\s]|rekordbox\s+controller|DJコントローラ(?:ー)?|デジタルDJ/i],
  ["SYS.COMPLETE", /complete\s+audio\s+system|packaged\s+audio\s+system|一体型オーディオシステム|コンポーネントシステム/i],
];

export function inferExplicitCategoryIds(
  text: string = "",
  _options?: { context?: string },
): ClassifiableCategoryId[] {
  const value = String(text || "").normalize("NFKC");
  if (!value.trim()) return [];
  if (isCoEqualMultifunction(value)) return ["SYS.MULTIFUNCTION"];
  for (const [id, pattern] of RULES) if (pattern.test(value)) return [id];
  return [];
}
