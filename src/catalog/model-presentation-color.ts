/**
 * Seller-facing color and finish presentations that do not change product identity.
 *
 * Long-form finish names are safe as trailing annotations. Short color codes are accepted only
 * behind an explicit delimiter or inside brackets so legitimate model suffixes such as `SE` remain
 * part of the model identity.
 */

const PRESENTATION_FINISH_NAME = String.raw`(?:シャンパンゴールド|ピアノブラック|サテンブラック|マットブラック|ダークシルバー|ブラック|ホワイト|シルバー|ゴールド|チタニウム|チタン|グレー|グレイ|レッド|ブルー|グリーン|ブラウン|ベージュ|ナチュラル|ウォールナット|ウォルナット|ローズウッド|チェリー|メープル|オーク|黒|白|銀|金|CHAMPAGNE\s+GOLD|PIANO\s+BLACK|SATIN\s+(?:BLACK|WHITE)|MATTE\s+(?:BLACK|WHITE)|GLOSS\s+(?:BLACK|WHITE)|HIGH\s+GLOSS\s+(?:BLACK|WHITE)|DARK\s+SILVER|TITANIUM(?:\s+(?:GRAY|GREY))?|BLACK|WHITE|SILVER|GOLD|GRAY|GREY|RED|BLUE|GREEN|BROWN|BEIGE|NATURAL|WALNUT|ROSEWOOD|CHERRY|MAPLE|OAK)`;
const PRESENTATION_FINISH_CODE = String.raw`(?:B|S|BK|BLK|WH|W|K|N|SLV|SIL|GRY)`;
const PRESENTATION_FINISH_SUFFIX = String.raw`(?:\s*(?:色|仕上げ|FINISH))?`;
const PRESENTATION_PAIR_SUFFIX = String.raw`(?:\s*[（(]?\s*(?:ペア|PAIR)\s*[）)]?)?`;

function finishPattern(source: string): RegExp {
  return new RegExp(source, "iu");
}

export const PRESENTATION_COLOR_PATTERNS: readonly RegExp[] = [
  // Explicit labels: `カラー: ブラック`, `finish: silver`.
  finishPattern(
    String.raw`\s+(?:カラー|色|仕上げ|COLOR|COLOUR|FINISH)\s*[:：]?\s*${PRESENTATION_FINISH_NAME}${PRESENTATION_FINISH_SUFFIX}${PRESENTATION_PAIR_SUFFIX}\s*$`,
  ),
  // Delimited seller variants: `D-1000 / BK`, `D-1000 | Silver`, `D-1000 - Black`.
  finishPattern(
    String.raw`(?:\s*(?:\/|\||,)\s*|\s+-\s+)(?:${PRESENTATION_FINISH_NAME}|${PRESENTATION_FINISH_CODE})${PRESENTATION_FINISH_SUFFIX}${PRESENTATION_PAIR_SUFFIX}\s*$`,
  ),
  // Bracketed names/codes: `D-1000 (S)`, `D-1000 [BLACK]`, `D-1000【シルバー】`.
  finishPattern(
    String.raw`\s*(?:\(|（|\[|［|【)\s*(?:${PRESENTATION_FINISH_NAME}|${PRESENTATION_FINISH_CODE})${PRESENTATION_FINISH_SUFFIX}\s*(?:\)|）|\]|］|】)${PRESENTATION_PAIR_SUFFIX}\s*$`,
  ),
  // Bare long-form finish suffixes: `D-1000 ブラック`, `805 D4 Signature Walnut`.
  finishPattern(
    String.raw`\s+${PRESENTATION_FINISH_NAME}${PRESENTATION_FINISH_SUFFIX}${PRESENTATION_PAIR_SUFFIX}\s*$`,
  ),
];
