/**
 * Seller-facing color and finish presentations that do not change product identity.
 *
 * A color word is only a *candidate* presentation token. Audio manufacturers also use color words
 * as model/grade names (`MC Cadenza Black`, `2M Blue`), so a bare plain color suffix is deliberately
 * kept in the model. We remove a color only when seller syntax makes the presentation intent clear,
 * or when the finish wording is self-describing (for example `グロスブラック`).
 *
 * Short color codes are accepted only behind strong presentation syntax (brackets or a
 * whitespace-delimited separator), so legitimate model suffixes such as `SE` and compact model
 * names such as `FS-700S3/B` remain identity-bearing.
 *
 * The catalog below is the single source for both matching and canonical display spelling, so a
 * finish cannot be recognized by the normalizer and missed by the matcher, or the reverse.
 */

import type { PresentationColorDefinition } from "./types.js";

/**
 * The finishes a listing may name, and every spelling observed for each.
 *
 * Order is display order: a product offered in several finishes lists them this way rather than in
 * whatever order its offers happened to be aggregated. Qualified finishes stay separate entries —
 * `グロスブラック` and `ピアノブラック` are different things to look at, and folding them into
 * `ブラック` would claim a listing said something it did not.
 *
 * `aliases` are long-form spellings. `codes` are short forms, which are ambiguous enough (`B`, `S`,
 * `N`) that the patterns only accept them inside explicit presentation syntax. Multi-word spellings
 * are written with their words separated; any separator, or none, matches (`グロス ブラック`
 * covers `グロス・ブラック` and `グロスブラック`).
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

/**
 * Bare suffix removal is intentionally narrower than recognition.
 *
 * These qualified surface descriptions carry presentation semantics in the wording itself. Plain
 * `Black`, `Blue`, `Bronze`, `Gold`, wood names, etc. do not: audio manufacturers routinely use
 * those as identity-bearing model or grade names, so they require explicit seller syntax instead.
 */
const SAFE_BARE_FINISH_IDS = new Set([
  "gloss-black",
  "satin-black",
  "matte-black",
  "piano-black",
  "gloss-white",
  "satin-white",
  "matte-white",
  "dark-silver",
  "champagne-gold",
]);

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

function spellingsFor(colors: readonly PresentationColorDefinition[]): string[] {
  return colors.flatMap((color) => [color.name, ...color.aliases]);
}

const PRESENTATION_FINISH_NAME = alternation(spellingsFor(PRESENTATION_COLORS));
const PRESENTATION_FINISH_CODE = alternation(PRESENTATION_COLORS.flatMap((color) => color.codes));
const SAFE_BARE_FINISH_NAME = alternation(
  spellingsFor(PRESENTATION_COLORS.filter((color) => SAFE_BARE_FINISH_IDS.has(color.id))),
);
const PRESENTATION_FINISH_QUALIFIER = String.raw`(?:色|仕上げ|FINISH)`;
const PRESENTATION_FINISH_SUFFIX = String.raw`(?:\s*${PRESENTATION_FINISH_QUALIFIER})?`;
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
  // Explicit suffix qualifiers: `ブラック仕上げ`, `BLACK FINISH`.
  finishPattern(
    String.raw`\s+(${PRESENTATION_FINISH_NAME})\s*${PRESENTATION_FINISH_QUALIFIER}${PRESENTATION_PAIR_SUFFIX}\s*$`,
  ),
  // Two-tone syntax is presentation evidence in seller prose: `91E ブラック/ゴールド`.
  finishPattern(
    String.raw`\s+(${PRESENTATION_FINISH_NAME}\s*\/\s*${PRESENTATION_FINISH_NAME})${PRESENTATION_FINISH_SUFFIX}${PRESENTATION_PAIR_SUFFIX}\s*$`,
  ),
  // Delimited seller variants are explicit enough even for otherwise ambiguous plain color names.
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
  // Only self-describing qualified finishes are safe when written as an otherwise bare suffix.
  finishPattern(
    String.raw`\s+(${SAFE_BARE_FINISH_NAME})${PRESENTATION_FINISH_SUFFIX}${PRESENTATION_PAIR_SUFFIX}\s*$`,
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

/** One seller spelling to one finish, or null when the spelling is not in the finish vocabulary. */
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
    // A captured two-tone finish is one seller presentation, but each component still normalizes
    // through the same catalog before the canonical label is re-joined by presentationColorLabel.
    for (const part of String(value).split("/")) {
      const color = normalizePresentationColor(part);
      if (color) found.set(color.id, color);
    }
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
