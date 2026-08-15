/**
 * Model Resolution.
 *
 * A dedicated stage, deliberately not a generic "split the title at whitespace" fallback. It runs
 * after Manufacturer Resolution because a verified manufacturer is what makes presentation-token
 * removal and title extraction safe, and it keeps three separate levels:
 *
 *   raw model        - the seller's presentation, never overwritten
 *   normalized model - the deterministic search/identity representation
 *   canonical model  - the Knowledge Catalog's verified model, resolved elsewhere
 *
 * Merchandising annotations are removed only through the explicit vocabulary below, and every
 * removal is re-checked against the identity parts: a rule that would drop a revision or edition
 * token (MK2, TX, SE, Signature, Meta, X, ...) is rejected and the listing becomes a candidate
 * instead. Losing `D-1000 MK2 != D-1000` is worse than leaving a listing unresolved.
 */

import {
  bootstrapManufacturers,
  manufacturerPrefixPattern,
  normalizeManufacturerKey,
} from "./manufacturers.js";
import { identityModelParts, normalizeIdentityModel } from "./product-identity.js";
import type {
  ManufacturerAliasEvidence,
  ModelResolutionInput,
  ModelResolutionResult,
  NormalizedCatalogProduct,
  ResolutionStatus,
} from "./types.js";

export const MODEL_RESOLVER_VERSION = 2;

export type ModelResolver = (input: ModelResolutionInput) => ModelResolutionResult;

/** Presentation prefixes per canonical manufacturer, longest alias first. */
type PreparedModelResolver = ReadonlyMap<string, readonly RegExp[]>;

interface AnnotationRule {
  readonly name: string;
  readonly pattern: RegExp;
}

interface StrippedModel {
  text: string;
  removed: string[];
}

/**
 * Merchandising vocabulary. Every entry describes something a retailer writes *around* a product
 * name — listing state, condition, packaging, its own stock number, a presentation colour. Nothing
 * here may overlap the revision/edition tokens `identityModelParts` recognises.
 */
const ANNOTATION_RULES: readonly AnnotationRule[] = [
  {
    name: "listing_state",
    pattern:
      /[【《[［(（]?\s*(?:販売済み?|売約済み?|ご成約|商談中|予約済み?|完売|売切れ?|品切れ?)\s*[】》\]］)）]?/gu,
  },
  { name: "listing_state", pattern: /[【《[［(（]?\s*SOLD(?:\s*OUT)?\s*[】》\]］)）]?/giu },
  {
    name: "condition",
    pattern:
      /[【《[［(（]?\s*(?:中古美品|中古|極美品|美品|良品|並品|新品同様|新品|未使用品|未使用|展示処分品|展示品|デモ機|アウトレット|訳あり|ジャンク品?|保証書付き?|保証付き?)\s*[】》\]］)）]?/gu,
  },
  {
    name: "condition",
    pattern: /\b(?:USED|DEMO|OUTLET|MINT|PRE-?OWNED|SECOND\s*HAND|EX-?DEMO|B-?STOCK)\b/giu,
  },
  {
    name: "packaging",
    pattern:
      /[【《[［(（]?\s*(?:元箱付き?|元箱有り?|元箱|箱付き?|純正箱|取扱説明書付き?|説明書付き?|取説付き?|リモコン付き?|付属品完備|付属品付き?|ケーブル付き?)\s*[】》\]］)）]?/gu,
  },
  {
    name: "seller_sku",
    pattern:
      /[【《[［(（]?\s*(?:管理番号|管理No\.?|商品番号|在庫番号|品番)\s*[:：]?\s*[A-Z0-9][A-Z0-9._/-]*\s*[】》\]］)）]?/giu,
  },
  { name: "seller_sku", pattern: /\s*[[［]\s*[A-Z0-9][A-Z0-9._/-]{3,}\s*[\]］]\s*$/iu },
  { name: "seller_sku", pattern: /\s*《[^》]{1,40}》\s*/gu },
  {
    name: "presentation_color",
    pattern:
      /\s*\/\s*(?:ブラック|ホワイト|シルバー|ゴールド|レッド|ブルー|ブラウン|黒|白|銀|BLACK|WHITE|SILVER|GOLD)(?:\s*[（(]?\s*(?:ペア|PAIR)\s*[）)]?)?\s*$/iu,
  },
  {
    name: "presentation_color",
    pattern: /\s*[（(](?:B|S|BK|WH|W|K|N|ブラック|ホワイト|シルバー|黒|白|銀)[）)]\s*$/iu,
  },
];

/**
 * Residue that is neither clearly merchandising nor clearly identity. It is kept in the model —
 * removing it could destroy a real model number — but it downgrades the listing to `candidate` so
 * the remediation loop can surface the pattern instead of silently claiming a resolved model.
 */
const UNCLASSIFIED_RULES: readonly AnnotationRule[] = [
  { name: "seller_bracket", pattern: /[【】《》[\]［］]/u },
  { name: "seller_number", pattern: /(?:^|[^A-Za-z0-9])\d{5,}(?:$|[^A-Za-z0-9])/u },
  {
    name: "unclassified_text",
    pattern: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/u,
  },
];

/**
 * Longest token run a title tail may be and still be accepted as a model. Covers the real shapes
 * (`E-5000`, `D-1000 MK2`, `805 D4 Signature`, `Model 30 SE`) without swallowing a product
 * description.
 */
const TITLE_MODEL_MAX_TOKENS = 3;

function clean(value: unknown = ""): string {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function tidy(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s\-/_,:：|]+/u, "")
    .replace(/[\s\-/_,:：|]+$/u, "")
    .trim();
}

function stripSellerAnnotations(value: string): StrippedModel {
  const removed: string[] = [];
  let text = value;
  for (const rule of ANNOTATION_RULES) {
    const next = tidy(text.replace(rule.pattern, " "));
    if (!next || next === text) continue;
    if (!removed.includes(rule.name)) removed.push(rule.name);
    text = next;
  }
  return { text, removed };
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return index === needle.length;
}

/**
 * The safety invariant for every removal: annotation stripping may only delete characters from the
 * identity representation, and may never drop a revision or edition token.
 */
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

/**
 * Whether a title tail is short and model-shaped enough to be trusted as a model on its own.
 *
 * A title is prose with a model somewhere inside it, so taking the whole tail would turn
 * "Integrated Stereo Amplifier E-5000" into a resolved model and quietly inflate the metric. A real
 * model number is a short token run containing a digit; anything longer stays a candidate for
 * review rather than being guessed at or truncated.
 */
function looksLikeModel(value: string): boolean {
  const tokens = value.split(/\s+/u).filter(Boolean);
  return tokens.length > 0 && tokens.length <= TITLE_MODEL_MAX_TOKENS && /\d/u.test(value);
}

function stripManufacturerPresentation(value: string, patterns: readonly RegExp[]): string {
  for (const pattern of patterns) {
    const stripped = tidy(value.replace(pattern, " "));
    if (stripped && stripped !== value) return stripped;
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
  // Only verified operational spellings may be removed. A pending alias is not yet evidence that
  // the token is a brand name rather than part of the model.
  for (const row of operationalAliases) {
    if (row.verificationStatus !== "verified") continue;
    add(row.manufacturerId, row.canonicalName);
    add(row.manufacturerId, row.alias);
  }

  return new Map(
    [...byManufacturer].map(([id, entries]) => [
      id,
      entries
        .sort(
          (left, right) =>
            right.alias.length - left.alias.length || left.alias.localeCompare(right.alias),
        )
        .map((entry) => entry.pattern),
    ]),
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
  };
}

function resolvePreparedModel(
  input: ModelResolutionInput,
  prepared: PreparedModelResolver,
): ModelResolutionResult {
  const rawModel = clean(input.rawModel);
  const manufacturerId = clean(input.manufacturerId).toLowerCase();
  const fromSeller = Boolean(rawModel);
  // Without a resolved manufacturer a title is just prose: there is no verified brand token to
  // remove, so the model stays unresolved rather than being guessed at.
  const source = fromSeller ? rawModel : manufacturerId ? clean(input.title) : "";
  if (!source) return unresolvedResult(rawModel, rawModel);

  const patterns = prepared.get(manufacturerId) || [];
  const withoutManufacturer = patterns.length
    ? stripManufacturerPresentation(source, patterns)
    : source;
  const stripped = stripSellerAnnotations(withoutManufacturer);
  const safe = preservesModelIdentity(withoutManufacturer, stripped.text);
  const model = safe ? stripped.text : withoutManufacturer;
  const normalizedModel = normalizeIdentityModel(model);
  if (!normalizedModel) return unresolvedResult(rawModel, model || rawModel);

  const unclassifiedTokens = [
    ...(safe ? [] : ["identity_guard"]),
    ...unclassifiedResidue(model),
    // Title evidence is prose until proven otherwise; the seller's own model field is not.
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
  };
}

/** Compile one presentation snapshot for bounded batch resolution without rebuilding regexes. */
export function createModelResolver(
  operationalAliases: readonly ManufacturerAliasEvidence[] = [],
): ModelResolver {
  const prepared = presentationPatterns(operationalAliases);
  return (input) => resolvePreparedModel(input, prepared);
}

/** Pure, deterministic one-off resolution over bootstrap plus D1-provided alias evidence. */
export function resolveModel(
  input: ModelResolutionInput,
  operationalAliases: readonly ManufacturerAliasEvidence[] = [],
): ModelResolutionResult {
  return createModelResolver(operationalAliases)(input);
}

/** Re-resolve an already parsed listing without touching its immutable seller evidence. */
export function applyModelResolution(
  product: NormalizedCatalogProduct,
  aliasesOrResolver: readonly ManufacturerAliasEvidence[] | ModelResolver = [],
): NormalizedCatalogProduct {
  const resolver =
    typeof aliasesOrResolver === "function"
      ? aliasesOrResolver
      : createModelResolver(aliasesOrResolver);
  const resolution = resolver({
    rawModel: product.rawModel || product.model,
    title: product.title,
    manufacturerId: product.manufacturerId,
  });
  return {
    ...product,
    rawModel: resolution.rawModel,
    model: resolution.model,
    normalizedModel: resolution.normalizedModel,
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
      },
    },
  };
}
