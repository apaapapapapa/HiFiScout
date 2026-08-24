/**
 * Seller-facing color and finish presentations that do not change product identity.
 *
 * Long-form finish names are safe as trailing annotations. Short color codes are accepted only
 * behind strong presentation syntax (brackets or a whitespace-delimited separator), so legitimate
 * model suffixes such as `SE` and compact model names such as `FS-700S3/B` remain identity-bearing.
 *
 * A finish is not identity — `MC Cadenza Black` and `MC Cadenza Bronze` are one catalog product,
 * and removing the finish is what lets the two group together. It is still the thing a shopper is
 * looking at, so the patterns capture what they remove and the capture is normalized to one
 * spelling per finish here, rather than being deleted along with the text.
 *
 * The catalog below is the single source for both: the match patterns are generated from the same
 * spellings the normalizer looks up, so a finish cannot be recognized by one and not the other.
 */

import type { PresentationColorDefinition } from "./types.js";

/**
 * The finishes a listing may name, and every spelling observed for each.
 *
 * Order is display order: a product offered in several finishes lists them this way rather than in
 * whatever order its offers happened to be aggregated. Qualified finishes stay separate entries —
 * `グロスブラック` and `ピアノブラック` are different products to look at, and folding them into
 * `ブラック` would claim a listing said something it did not.
 *
 * `aliases` are long-form spellings, matched on their own. `codes` are the short forms, which are
 * ambiguous enough (`B`, `S`, `N`) that the patterns only accept them inside brackets or behind a
 * whitespace-delimited separator. Multi-word spellings are written with their words separated;
 * any separator, or none, matches (`グロス ブラック` covers `グロス・ブラック` and `グロスブラック`).
 */
const PRESENTATION_COLOR_SOURCE: readonly (readonly [
  id: string,
  name: string,
  aliases: readonly string[],
  codes: readonly string[],
])[] = [
  ["black", "ブラック", ["black", "ブラック", "黒"], ["b", "bk", "blk", "k"]],
  [
    "gloss-black",
    "グロスブラック",
    ["gloss black", "グロス ブラック", "high gloss black", "ハイグロス ブラック"],
    [],
  ],
  ["satin-black", "サテンブラック", ["satin black", "サテン ブラック"], []],
  ["matte-black", "マットブラック", ["matte black", "マット ブラック"], []],
  ["piano-black", "ピアノブラック", ["piano black", "ピアノ ブラック"], []],
  ["white", "ホワイト", ["white", "ホワイト", "白"], ["w", "wh"]],
  [
    "gloss-white",
    "グロスホワイト",
    ["gloss white", "グロス ホワイト", "high gloss white", "ハイグロス ホワイト"],
    [],
  ],
  ["satin-white", "サテンホワイト", ["satin white", "サテン ホワイト"], []],
  ["matte-white", "マットホワイト", ["matte white", "マット ホワイト"], []],
  ["silver", "シルバー", ["silver", "シルバー", "銀"], ["s", "sil", "slv"]],
  ["dark-silver", "ダークシルバー", ["dark silver", "ダーク シルバー"], []],
  ["gold", "ゴールド", ["gold", "ゴールド", "金"], []],
  ["champagne-gold", "シャンパンゴールド", ["champagne gold", "シャンパン ゴールド"], []],
  ["bronze", "ブロンズ", ["bronze", "ブロンズ"], []],
  ["copper", "カッパー", ["copper", "カッパー", "銅"], []],
  [
    "titanium",
    "チタニウム",
    ["titanium", "titanium gray", "titanium grey", "チタニウム", "チタン"],
    [],
  ],
  ["gray", "グレー", ["gray", "grey", "グレー", "グレイ"], ["gry"]],
  ["red", "レッド", ["red", "レッド"], []],
  ["blue", "ブルー", ["blue", "ブルー"], []],
  ["green", "グリーン", ["green", "グリーン"], []],
  ["brown", "ブラウン", ["brown", "ブラウン"], []],
  ["beige", "ベージュ", ["beige", "ベージュ"], []],
  ["natural", "ナチュラル", ["natural", "ナチュラル"], ["n"]],
  ["walnut", "ウォールナット", ["walnut", "ウォールナット", "ウォルナット"], []],
  ["rosewood", "ローズウッド", ["rosewood", "ローズウッド"], []],
  ["cherry", "チェリー", ["cherry", "チェリー"], []],
  ["maple", "メープル", ["maple", "メープル", "メイプル"], []],
  ["oak", "オーク", ["oak", "オーク"], []],
];

export const PRESENTATION_COLORS: readonly PresentationColorDefinition[] =
  PRESENTATION_COLOR_SOURCE.map(([id, name, aliases, codes], order) =>
    Object.freeze({ id, name, aliases, codes, order }),
  );

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `dark silver` also matches `ダーク・シルバー` and `グロスブラック`-style unseparated spellings. */
function spellingPattern(spelling: string): string {
  return spelling
    .trim()
    .split(/[\s・]+/u)
    .filter(Boolean)
    .map(escapeRegExp)
    .join(String.raw`[・\s]*`);
}

/** Longest spelling first, so `グロス ブラック` is never shadowed by the `ブラック` alternative. */
function alternation(spellings: readonly string[]): string {
  const unique = [...new Set(spellings)].sort((left, right) => right.length - left.length);
  return `(?:${unique.map(spellingPattern).join("|")})`;
}

const PRESENTATION_FINISH_NAME = alternation(
  PRESENTATION_COLORS.flatMap((color) => [color.name, ...color.aliases]),
);
const PRESENTATION_FINISH_CODE = alternation(PRESENTATION_COLORS.flatMap((color) => color.codes));
const PRESENTATION_FINISH_SUFFIX = String.raw`(?:\s*(?:色|仕上げ|FINISH))?`;
const PRESENTATION_PAIR_SUFFIX = String.raw`(?:\s*[（(]?\s*(?:ペア|PAIR)\s*[）)]?)?`;

function finishPattern(source: string): RegExp {
  return new RegExp(source, "iu");
}

/**
 * Every pattern captures the finish token in group 1 and nothing else, so a rule that matched can
 * say *which* finish it removed. Keep that invariant when adding a shape: the label a card renders
 * is read straight out of this capture.
 */
export const PRESENTATION_COLOR_PATTERNS: readonly RegExp[] = [
  // Explicit labels: `カラー: ブラック`, `finish: silver`.
  finishPattern(
    String.raw`\s+(?:カラー|色|仕上げ|COLOR|COLOUR|FINISH)\s*[:：]?\s*(${PRESENTATION_FINISH_NAME})${PRESENTATION_FINISH_SUFFIX}${PRESENTATION_PAIR_SUFFIX}\s*$`,
  ),
  // Long-form delimited seller variants are self-describing even without whitespace.
  finishPattern(
    String.raw`(?:\s*(?:\/|\||,)\s*|\s+-\s+)(${PRESENTATION_FINISH_NAME})${PRESENTATION_FINISH_SUFFIX}${PRESENTATION_PAIR_SUFFIX}\s*$`,
  ),
  // Short codes need whitespace around the separator. This deliberately rejects `FS-700S3/B`.
  finishPattern(
    String.raw`(?:\s+(?:\/|\||,)\s+|\s+-\s+)(${PRESENTATION_FINISH_CODE})${PRESENTATION_FINISH_SUFFIX}${PRESENTATION_PAIR_SUFFIX}\s*$`,
  ),
  // Bracketed names/codes: `D-1000 (S)`, `D-1000 [BLACK]`, `802D4W(サテン・ホワイト)`.
  finishPattern(
    String.raw`\s*(?:\(|（|\[|［|【)\s*((?:${PRESENTATION_FINISH_NAME}|${PRESENTATION_FINISH_CODE}))${PRESENTATION_FINISH_SUFFIX}\s*(?:\)|）|\]|］|】)${PRESENTATION_PAIR_SUFFIX}\s*$`,
  ),
  // Bare long-form finish suffixes: `D-1000 ブラック`, `805D3 グロスブラック`.
  finishPattern(
    String.raw`\s+(${PRESENTATION_FINISH_NAME})${PRESENTATION_FINISH_SUFFIX}${PRESENTATION_PAIR_SUFFIX}\s*$`,
  ),
];

/** Same shape of key as the manufacturer normalizer: spelling noise folded, characters kept. */
function presentationColorKey(value: unknown = ""): string {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・･_\-/&+.,'"()（）]+/gu, "");
}

const BY_ALIAS = new Map<string, PresentationColorDefinition>();
for (const color of PRESENTATION_COLORS) {
  for (const spelling of [color.id, color.name, ...color.aliases, ...color.codes]) {
    const key = presentationColorKey(spelling);
    if (key && !BY_ALIAS.has(key)) BY_ALIAS.set(key, color);
  }
}

/**
 * One seller spelling to one finish, or null when the spelling is not a finish this catalog knows.
 *
 * Null is not a failure to record: an unrecognized capture means the pattern removed something the
 * catalog cannot name, and the caller keeps the raw text out of the displayed label rather than
 * inventing a finish for it.
 */
export function normalizePresentationColor(
  value: unknown = "",
): PresentationColorDefinition | null {
  const key = presentationColorKey(value);
  return key ? (BY_ALIAS.get(key) ?? null) : null;
}

/** Canonical labels in catalog order, deduplicated. The stored and rendered spelling. */
export function presentationColorLabels(values: readonly string[] = []): string[] {
  const found = new Map<string, PresentationColorDefinition>();
  for (const value of values) {
    const color = normalizePresentationColor(value);
    if (color) found.set(color.id, color);
  }
  return [...found.values()].sort((left, right) => left.order - right.order).map((c) => c.name);
}

/**
 * A two-tone listing (`ブラック/ゴールド`) is one finish to a shopper, so the labels join into a
 * single value rather than becoming two finishes the product is offered in.
 */
export function presentationColorLabel(values: readonly string[] = []): string {
  return presentationColorLabels(values).join("/");
}

/**
 * The distinct finishes a product is offered in, from stored per-listing labels.
 *
 * The unit here is a whole label, not a colour: a two-tone `ブラック/ゴールド` listing is one thing
 * to buy, and splitting it would advertise a plain black and a plain gold that no shop listed. A
 * label is ordered by its leading colour and dropped when nothing in it is a known finish.
 */
export function presentationColorList(values: readonly string[] = []): string[] {
  const ordered: { label: string; order: number }[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const label = String(value).trim();
    if (!label || seen.has(label)) continue;
    const parts = label.split("/").map((part) => normalizePresentationColor(part));
    const leading = parts.find((part) => part);
    if (!leading || parts.some((part) => !part)) continue;
    seen.add(label);
    ordered.push({ label, order: leading.order });
  }
  return ordered.sort((left, right) => left.order - right.order).map((entry) => entry.label);
}
