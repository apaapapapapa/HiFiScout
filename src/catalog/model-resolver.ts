/**
 * Model Resolution.
 *
 * Seller evidence is immutable (`rawModel`). Canonical model presentation may remove only explicit
 * merchandising annotations, and every removal is checked against identity revision tokens.
 */

import {
  bootstrapManufacturers,
  manufacturerPrefixPattern,
  normalizeManufacturerKey,
  stripBracketedManufacturerAlias,
} from "./manufacturers.js";
import {
  PRESENTATION_BARE_COLOR_PATTERN,
  PRESENTATION_COLOR_PATTERNS,
  canStripBarePresentationColor,
  presentationColorLabel,
  presentationColorLabels,
} from "./model-presentation-color.js";
import { identityModelParts, normalizeIdentityModel } from "./product-identity.js";
import type {
  ManufacturerAliasEvidence,
  ModelResolutionInput,
  ModelResolutionResult,
  NormalizedCatalogProduct,
  ResolutionStatus,
} from "./types.js";

export const MODEL_RESOLVER_VERSION = 9;

export type ModelResolver = (input: ModelResolutionInput) => ModelResolutionResult;

interface ManufacturerPresentation {
  readonly patterns: readonly RegExp[];
  readonly aliases: readonly string[];
}

type PreparedModelResolver = ReadonlyMap<string, ManufacturerPresentation>;

interface AnnotationRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly requiresBarePresentationEvidence?: boolean;
  readonly shopKey?: string;
}

interface StrippedModel {
  text: string;
  removed: string[];
  /** Raw finish captures, in the order they appeared in the source text. */
  colors: string[];
}

/** The rule whose captures are kept instead of discarded with the text they matched. */
const PRESENTATION_COLOR_RULE = "presentation_color";

const OPENING_BRACKETS = String.raw`【《[［(（`;
const CLOSING_BRACKETS = String.raw`】》\]］)）`;
const BRACKETED_ANNOTATION_TAIL = 10;

/**
 * A seller annotation either stands bare or fills a bracketed group.
 *
 * Accepting the opening and closing bracket as independently optional characters is what let
 * `【新品在庫限り】` lose only the vocabulary a rule knows and keep the malformed `在庫限り】`. The
 * bracketed branch therefore requires its closing bracket, absorbing a short remainder with it.
 */
function annotationPattern(words: string, flags: string = "gu"): RegExp {
  return new RegExp(
    String.raw`(?:[${OPENING_BRACKETS}]\s*(?:${words})[^${CLOSING_BRACKETS}]{0,${BRACKETED_ANNOTATION_TAIL}}\s*[${CLOSING_BRACKETS}]|(?:${words}))`,
    flags,
  );
}

const ANNOTATION_RULES: readonly AnnotationRule[] = [
  {
    name: "listing_state",
    pattern: annotationPattern(
      String.raw`販売済み?|売約済み?|ご成約|商談中|予約済み?|完売|売切れ?|品切れ?|お取り寄せ|1セットのみ|色選択`,
    ),
  },
  { name: "listing_state", pattern: annotationPattern(String.raw`SOLD(?:\s*OUT)?`, "giu") },
  {
    name: "condition",
    pattern: annotationPattern(
      String.raw`中古美品|中古|極美品|美品|良品|並品|新品同様|新同品|新品|未使用品|未使用|未使用開封品|開封品|展示処分品|展示品|デモ機|アウトレット|訳あり|B級品|ジャンク品?|保証書付き?|保証付き?`,
    ),
  },
  {
    name: "condition",
    pattern: /\b(?:USED|DEMO|OUTLET|MINT|PRE-?OWNED|SECOND\s*HAND|EX-?DEMO|B-?STOCK)\b/giu,
  },
  {
    name: "packaging",
    pattern: annotationPattern(
      String.raw`元箱付き?|元箱有り?|元箱|箱付き?|純正箱|取扱説明書付き?|説明書付き?|取説付き?|リモコン付き?|付属品完備|付属品付き?|ケーブル付き?`,
    ),
  },
  ...PRESENTATION_COLOR_PATTERNS.map((pattern) => ({
    name: "presentation_color",
    pattern,
  })),
  {
    name: "presentation_color",
    pattern: PRESENTATION_BARE_COLOR_PATTERN,
    requiresBarePresentationEvidence: true,
  },
  {
    name: "seller_serial",
    shopKey: "shimamusen",
    // Shimamusen appends per-unit serials to used-product titles: `C-3900 (I0Y154)`,
    // `AP-505 (2080013)`, `D-03X (G40601378C)`. NFKC has already normalized full-width
    // parentheses. Requiring 6-20 contiguous alphanumerics and at least three digits leaves
    // `(ペア)`, manufacturer aliases and ordinary bracketed presentation untouched; the identity
    // guard below still vetoes removal if a recognized revision token would be lost.
    pattern: /\s*\((?=[A-Z0-9]{6,20}\))(?=(?:[A-Z]*\d){3})[A-Z0-9]+\)\s*/giu,
  },
  {
    name: "seller_sku",
    pattern:
      /[【《[［(（]?\s*(?:管理番号|管理No\.?|商品番号|在庫番号|品番)\s*[:：]?\s*[A-Z0-9][A-Z0-9._/-]*\s*[】》\]］)）]?/giu,
  },
  { name: "seller_sku", pattern: /\s*[[［]\s*[A-Z0-9][A-Z0-9._/-]{3,}\s*[\]］]\s*$/iu },
  { name: "seller_sku", pattern: /\s*《[^》]{1,40}》\s*/gu },
  {
    // Delivery terms are footnoted with `※`: `※送料無料`, `※配達設置費・送料別途相談`. The marker
    // is the seller's own "this is not the product" signal, so the note it introduces is removed
    // whole rather than by enumerating every wording.
    name: "shipping",
    pattern: /\s*※\s*[^※]*?(?:送料|配送|配達|運賃|発送|設置費)[^※]*$/u,
  },
  {
    name: "shipping",
    pattern: /\s*(?:※\s*)?送料無料\s*$/gu,
  },
  {
    // `\p{Script=Han}`/`\p{Script=Katakana}` prefix: a product type is often written with a
    // qualifier fused to it (`真空管プリメインアンプ`, `天井埋込スピーカー`), and the qualifier is
    // as much presentation as the type word. It can only extend the match inside the single
    // whitespace-delimited token the type word already ends.
    name: "product_type_suffix",
    pattern:
      /\s+[\p{Script=Han}\p{Script=Katakana}ー]{0,8}(?:プリメインアンプ|インテグレーテッドアンプ|パワーアンプ|プリアンプ|コントロールアンプ|AVアンプ|ヘッドホンアンプ|フォノイコライザー|レコードプレーヤー|ターンテーブル|CDプレーヤー|SACD(?:\/CD)?プレーヤー|CDトランスポート|SACDトランスポート|ネットワークプレーヤー|ネットワークプレイヤー|ネットワークトランスポート|D\/Aコンバータ(?:ー)?|DAコンバータ(?:ー)?|サブウーファー|スピーカー|ヘッドホン|イヤホン|トーンアーム|カートリッジ|昇圧トランス|チューナー|イコライザー)\s*$/gu,
  },
  {
    // Some seller list pages append both a Japanese product-type label and a Japanese brand
    // presentation to the actual model (for example `DP-570 CDデッキ アキュフェーズ` or
    // `Fiber Box 2 JPSM 光絶縁ツール エディスクリエーション`). Require both pieces of
    // presentation evidence: a bare category word such as Shimamusen's `ネットワークプレーヤー`
    // stays a candidate instead of being silently deleted.
    name: "seller_title_suffix",
    pattern:
      /\s+(?:光絶縁ツール|スイッチングハブ|CDデッキ|プリメインアンプ|パワーアンプ|プリアンプ|ターンテーブル|フォノイコライザー|ネットワークプレーヤー|スピーカー|ヘッドホン)\s+[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・]+\s*$/giu,
  },
];

/**
 * Shops whose model resolver behavior is narrower than the global rules.
 *
 * A resolver version bump makes every active listing replay-eligible. Administrative replay uses
 * this list to refresh the directly affected shops first, before draining the global backlog.
 */
export const MODEL_RESOLVER_SCOPED_SHOPS: readonly string[] = Object.freeze([
  ...new Set(ANNOTATION_RULES.flatMap((rule) => (rule.shopKey ? [rule.shopKey] : []))),
]);

const UNCLASSIFIED_RULES: readonly AnnotationRule[] = [
  { name: "seller_bracket", pattern: /[【】《》[\]［］]/u },
  { name: "seller_number", pattern: /(?:^|[^A-Za-z0-9])\d{5,}(?:$|[^A-Za-z0-9])/u },
  {
    name: "unclassified_text",
    pattern: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/u,
  },
];

const ANNOTATION_PASS_LIMIT = 4;
const TITLE_MODEL_MAX_TOKENS = 3;
const BRACKETED_ALIAS_MIN_COMMON_PREFIX = 12;
const BRACKETED_ALIAS_MIN_COMMON_RATIO = 0.65;

function clean(value: unknown = ""): string {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

const BRACKET_OPENERS = new Set("([{【《［（〖");
const BRACKET_CLOSERS = new Set(")]}】》］）〗");

/**
 * Drop bracket delimiters left without a partner.
 *
 * Removing a manufacturer alias or an annotation from inside a bracketed group strands the other
 * delimiter — `Bowers&Wilkins(B&W) 802D4 B` resolves through `B&W` to `) 802D4 B`. Pairing is
 * deliberately lenient about *which* bracket closes which, because a seller who opens with `(` and
 * closes with `）` still wrote one group.
 */
function dropOrphanBrackets(value: string): string {
  const characters = [...value];
  const open: number[] = [];
  const orphans = new Set<number>();
  characters.forEach((character, index) => {
    if (BRACKET_OPENERS.has(character)) open.push(index);
    else if (BRACKET_CLOSERS.has(character)) {
      if (open.length) open.pop();
      else orphans.add(index);
    }
  });
  for (const index of open) orphans.add(index);
  if (!orphans.size) return value;
  return characters.filter((_, index) => !orphans.has(index)).join("");
}

function tidy(value: string): string {
  return dropOrphanBrackets(value)
    .replace(/\s+/g, " ")
    .replace(/^[\s\-/_,:：|]+/u, "")
    .replace(/[\s\-/_,:：|]+$/u, "")
    .trim();
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

/**
 * Some retailers put their own long-form model first and the canonical market model in brackets,
 * e.g. `SilentSwitch OCXO JPN STD [SILENT SWITCH OCXO JPSM]`.
 *
 * Brackets alone are never trusted. The bracketed value must be ASCII/model-shaped, must share a
 * long majority prefix with the leading value, and must retain every recognized revision token.
 * This lets an explicit alternate presentation converge without turning arbitrary bracket prose
 * into identity evidence.
 */
function preferredBracketedModelAlias(value: string): StrippedModel {
  const match = value.match(/^(.+?)\s+\[([A-Za-z0-9][A-Za-z0-9 ._+/-]{4,})\]\s*$/u);
  if (!match) return { text: value, removed: [], colors: [] };

  const leading = tidy(match[1]);
  const alias = tidy(match[2]);
  const normalizedLeading = normalizeIdentityModel(leading);
  const normalizedAlias = normalizeIdentityModel(alias);
  const shorterLength = Math.min(normalizedLeading.length, normalizedAlias.length);
  if (!shorterLength) return { text: value, removed: [], colors: [] };

  const common = commonPrefixLength(normalizedLeading, normalizedAlias);
  if (
    common < BRACKETED_ALIAS_MIN_COMMON_PREFIX ||
    common / shorterLength < BRACKETED_ALIAS_MIN_COMMON_RATIO
  ) {
    return { text: value, removed: [], colors: [] };
  }

  const sourceVariants = identityModelParts(value).variants;
  const aliasVariants = identityModelParts(alias).variants;
  if (!sourceVariants.every((variant) => aliasVariants.includes(variant))) {
    return { text: value, removed: [], colors: [] };
  }
  return { text: alias, removed: ["seller_model_alias"], colors: [] };
}

function stripSellerAnnotations(
  value: string,
  manufacturerId: string,
  shopKey: string,
): StrippedModel {
  const preferred = preferredBracketedModelAlias(value);
  const removed = [...preferred.removed];
  const colors: string[] = [];
  let text = preferred.text;
  // Rules run to a fixed point. A seller who stacks annotations (`… シルバー 真空管プリメインアンプ`)
  // hides each one behind the last, and which of them survives should not depend on the order the
  // rules happen to be written in.
  for (let pass = 0; pass < ANNOTATION_PASS_LIMIT; pass += 1) {
    const before = text;
    for (const rule of ANNOTATION_RULES) {
      if (rule.shopKey && rule.shopKey !== shopKey) continue;
      if (
        rule.requiresBarePresentationEvidence &&
        !canStripBarePresentationColor(manufacturerId, text)
      ) {
        continue;
      }
      const next = tidy(text.replace(rule.pattern, " "));
      if (!next || next === text) continue;
      if (!removed.includes(rule.name)) removed.push(rule.name);
      if (rule.name === PRESENTATION_COLOR_RULE) {
        // Every colour pattern is anchored at the end, so each further match sits to the left of
        // the one before it. Unshifting recovers the order the seller wrote (`ブラック/ゴールド`).
        const capture = text.match(rule.pattern)?.[1];
        if (capture) colors.unshift(capture);
      }
      text = next;
    }
    if (text === before) break;
  }
  return { text, removed, colors };
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return index === needle.length;
}

function preservesModelIdentity(before: string, after: string): boolean {
  const source = identityModelParts(before);
  const result = identityModelParts(after);
  if (!result.normalizedModel) return false;
  if (!isSubsequence(result.normalizedModel, source.normalizedModel)) return false;
  return source.variants.every((variant) => result.variants.includes(variant));
}

function unclassifiedResidue(value: string): string[] {
  const found: string[] = [];
  for (const rule of UNCLASSIFIED_RULES) {
    if (rule.pattern.test(value) && !found.includes(rule.name)) found.push(rule.name);
  }
  return found;
}

function looksLikeModel(value: string): boolean {
  const tokens = value.split(/\s+/u).filter(Boolean);
  return tokens.length > 0 && tokens.length <= TITLE_MODEL_MAX_TOKENS && /\d/u.test(value);
}

function stripManufacturerPresentation(
  value: string,
  presentation: ManufacturerPresentation,
): string {
  for (const pattern of presentation.patterns) {
    const withoutPrefix = value.replace(pattern, " ");
    if (withoutPrefix === value) continue;
    const stripped = tidy(stripBracketedManufacturerAlias(withoutPrefix, presentation.aliases));
    if (stripped) return stripped;
  }
  return value;
}

function presentationPatterns(
  operationalAliases: readonly ManufacturerAliasEvidence[],
): PreparedModelResolver {
  const byManufacturer = new Map<string, { alias: string; pattern: RegExp }[]>();
  const add = (manufacturerId: unknown, alias: unknown): void => {
    const id = clean(manufacturerId).toLowerCase();
    const text = clean(alias);
    const pattern = manufacturerPrefixPattern(text);
    if (!id || !pattern) return;
    const entries = byManufacturer.get(id) || [];
    if (
      entries.some(
        (entry) => normalizeManufacturerKey(entry.alias) === normalizeManufacturerKey(text),
      )
    )
      return;
    entries.push({ alias: text, pattern });
    byManufacturer.set(id, entries);
  };

  for (const manufacturer of bootstrapManufacturers()) {
    for (const alias of [manufacturer.name, ...manufacturer.aliases]) add(manufacturer.id, alias);
  }
  for (const row of operationalAliases) {
    if (row.verificationStatus !== "verified") continue;
    add(row.manufacturerId, row.canonicalName);
    add(row.manufacturerId, row.alias);
  }

  return new Map(
    [...byManufacturer].map(([id, entries]) => {
      const sorted = [...entries].sort(
        (left, right) =>
          right.alias.length - left.alias.length || left.alias.localeCompare(right.alias),
      );
      return [
        id,
        {
          patterns: sorted.map((entry) => entry.pattern),
          aliases: sorted.map((entry) => entry.alias),
        },
      ];
    }),
  );
}

function unresolvedResult(rawModel: string, model: string): ModelResolutionResult {
  return {
    rawModel,
    model,
    normalizedModel: "",
    status: "unresolved",
    method: "none",
    confidence: "none",
    removedAnnotations: [],
    unclassifiedTokens: [],
    presentationColors: [],
  };
}

function resolvePreparedModel(
  input: ModelResolutionInput,
  prepared: PreparedModelResolver,
): ModelResolutionResult {
  const rawModel = clean(input.rawModel);
  const manufacturerId = clean(input.manufacturerId).toLowerCase();
  const shopKey = clean(input.shopKey).toLowerCase();
  const fromSeller = Boolean(rawModel);
  const source = fromSeller ? rawModel : manufacturerId ? clean(input.title) : "";
  if (!source) return unresolvedResult(rawModel, rawModel);

  const presentation = prepared.get(manufacturerId);
  const withoutManufacturer = presentation?.patterns.length
    ? stripManufacturerPresentation(source, presentation)
    : source;
  const stripped = stripSellerAnnotations(withoutManufacturer, manufacturerId, shopKey);
  const safe = preservesModelIdentity(withoutManufacturer, stripped.text);
  const model = safe ? stripped.text : withoutManufacturer;
  const normalizedModel = normalizeIdentityModel(model);
  if (!normalizedModel) return unresolvedResult(rawModel, model || rawModel);

  // A finish is only reported when its text actually left the model. When the identity guard rolls
  // the strip back, the colour is still sitting in `model`, and claiming it twice would put it on
  // the card beside a model that already spells it out.
  const presentationColors = safe ? presentationColorLabels(stripped.colors) : [];
  const unclassifiedTokens = [
    ...(safe ? [] : ["identity_guard"]),
    ...unclassifiedResidue(model),
    ...(fromSeller || looksLikeModel(model) ? [] : ["title_prose"]),
  ];
  if (unclassifiedTokens.length) {
    return {
      rawModel,
      model,
      normalizedModel,
      status: "candidate",
      method: "unsafe_annotation",
      confidence: "low",
      removedAnnotations: safe ? stripped.removed : [],
      unclassifiedTokens,
      presentationColors,
    };
  }

  const status: ResolutionStatus = "resolved";
  if (!fromSeller) {
    return {
      rawModel,
      model,
      normalizedModel,
      status,
      method: "title_after_manufacturer",
      confidence: "medium",
      removedAnnotations: stripped.removed,
      unclassifiedTokens,
      presentationColors,
    };
  }
  return {
    rawModel,
    model,
    normalizedModel,
    status,
    method: stripped.removed.length ? "seller_model_annotated" : "seller_model",
    confidence: "high",
    removedAnnotations: stripped.removed,
    unclassifiedTokens,
    presentationColors,
  };
}

export function createModelResolver(
  operationalAliases: readonly ManufacturerAliasEvidence[] = [],
): ModelResolver {
  const prepared = presentationPatterns(operationalAliases);
  return (input) => resolvePreparedModel(input, prepared);
}

export function resolveModel(
  input: ModelResolutionInput,
  operationalAliases: readonly ManufacturerAliasEvidence[] = [],
): ModelResolutionResult {
  return createModelResolver(operationalAliases)(input);
}

export function applyModelResolution(
  product: NormalizedCatalogProduct,
  aliasesOrResolver: readonly ManufacturerAliasEvidence[] | ModelResolver = [],
  shopKey = "",
): NormalizedCatalogProduct {
  const resolver =
    typeof aliasesOrResolver === "function"
      ? aliasesOrResolver
      : createModelResolver(aliasesOrResolver);
  const resolution = resolver({
    rawModel: product.rawModel,
    title: product.title,
    manufacturerId: product.manufacturerId,
    shopKey,
  });
  return {
    ...product,
    rawModel: resolution.rawModel,
    model: resolution.model,
    normalizedModel: resolution.normalizedModel,
    presentationColor: presentationColorLabel(resolution.presentationColors),
    modelResolutionStatus: resolution.status,
    modelResolutionMethod: resolution.method,
    modelResolutionConfidence: resolution.confidence,
    metadata: {
      ...product.metadata,
      modelNormalization: {
        version: MODEL_RESOLVER_VERSION,
        status: resolution.status,
        method: resolution.method,
        confidence: resolution.confidence,
        normalizedModel: resolution.normalizedModel,
        removedAnnotations: resolution.removedAnnotations,
        unclassifiedTokens: resolution.unclassifiedTokens,
        presentationColors: resolution.presentationColors,
      },
    },
  };
}
