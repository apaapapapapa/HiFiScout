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
} from "./manufacturers.js";
import { identityModelParts, normalizeIdentityModel } from "./product-identity.js";
import type {
  ManufacturerAliasEvidence,
  ModelResolutionInput,
  ModelResolutionResult,
  NormalizedCatalogProduct,
  ResolutionStatus,
} from "./types.js";

export const MODEL_RESOLVER_VERSION = 4;

export type ModelResolver = (input: ModelResolutionInput) => ModelResolutionResult;
type PreparedModelResolver = ReadonlyMap<string, readonly RegExp[]>;

interface AnnotationRule {
  readonly name: string;
  readonly pattern: RegExp;
}

interface StrippedModel {
  text: string;
  removed: string[];
}

const ANNOTATION_RULES: readonly AnnotationRule[] = [
  {
    name: "listing_state",
    pattern:
      /[【《[［(（]?\s*(?:販売済み?|売約済み?|ご成約|商談中|予約済み?|完売|売切れ?|品切れ?|お取り寄せ|1セットのみ|色選択)\s*[】》\]］)）]?/gu,
  },
  { name: "listing_state", pattern: /[【《[［(（]?\s*SOLD(?:\s*OUT)?\s*[】》\]］)）]?/giu },
  {
    name: "condition",
    pattern:
      /[【《[［(（]?\s*(?:中古美品|中古|極美品|美品|良品|並品|新品同様|新同品|新品|未使用品|未使用|未使用開封品|開封品|展示処分品|展示品|デモ機|アウトレット|訳あり|B級品|ジャンク品?|保証書付き?|保証付き?)\s*[】》\]］)）]?/gu,
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
    name: "shipping",
    pattern: /\s*(?:※\s*)?送料無料\s*$/gu,
  },
  {
    name: "presentation_color",
    pattern:
      /\s*\/\s*(?:ブラック|ホワイト|シルバー|ゴールド|レッド|ブルー|ブラウン|黒|白|銀|BLACK|WHITE|SILVER|GOLD)(?:\s*[（(]?\s*(?:ペア|PAIR)\s*[）)]?)?\s*$/iu,
  },
  {
    name: "presentation_color",
    pattern: /\s*[（(](?:B|S|BK|WH|W|K|N|ブラック|ホワイト|シルバー|黒|白|銀)[）)]\s*$/iu,
  },
  {
    // Several seller list pages append a Japanese product-type label and then the Japanese brand
    // presentation to the actual model (for example `DP-570 CDデッキ アキュフェーズ` or
    // `Fiber Box 2 JPSM 光絶縁ツール エディスクリエーション`). These are explicit presentation
    // tokens, not revisions. Keep the vocabulary narrow; unknown Japanese residue remains a
    // candidate and therefore cannot merge with a base model.
    name: "seller_title_suffix",
    pattern:
      /\s+(?:光絶縁ツール|スイッチングハブ|CDデッキ|プリメインアンプ|パワーアンプ|プリアンプ|ターンテーブル|フォノイコライザー|ネットワークプレーヤー|スピーカー|ヘッドホン)(?:\s+[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・]+)?\s*$/giu,
  },
];

const UNCLASSIFIED_RULES: readonly AnnotationRule[] = [
  { name: "seller_bracket", pattern: /[【】《》[\]［］]/u },
  { name: "seller_number", pattern: /(?:^|[^A-Za-z0-9])\d{5,}(?:$|[^A-Za-z0-9])/u },
  {
    name: "unclassified_text",
    pattern: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/u,
  },
];

const TITLE_MODEL_MAX_TOKENS = 3;
const BRACKETED_ALIAS_MIN_COMMON_PREFIX = 12;
const BRACKETED_ALIAS_MIN_COMMON_RATIO = 0.65;

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
  if (!match) return { text: value, removed: [] };

  const leading = tidy(match[1]);
  const alias = tidy(match[2]);
  const normalizedLeading = normalizeIdentityModel(leading);
  const normalizedAlias = normalizeIdentityModel(alias);
  const shorterLength = Math.min(normalizedLeading.length, normalizedAlias.length);
  if (!shorterLength) return { text: value, removed: [] };

  const common = commonPrefixLength(normalizedLeading, normalizedAlias);
  if (
    common < BRACKETED_ALIAS_MIN_COMMON_PREFIX ||
    common / shorterLength < BRACKETED_ALIAS_MIN_COMMON_RATIO
  ) {
    return { text: value, removed: [] };
  }

  const sourceVariants = identityModelParts(value).variants;
  const aliasVariants = identityModelParts(alias).variants;
  if (!sourceVariants.every((variant) => aliasVariants.includes(variant))) {
    return { text: value, removed: [] };
  }
  return { text: alias, removed: ["seller_model_alias"] };
}

function stripSellerAnnotations(value: string): StrippedModel {
  const preferred = preferredBracketedModelAlias(value);
  const removed = [...preferred.removed];
  let text = preferred.text;
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
  return createModelResolver(operationalAliases)(input, operationalAliases);
}

export function applyModelResolution(
  product: NormalizedCatalogProduct,
  aliasesOrResolver: readonly ManufacturerAliasEvidence[] | ModelResolver = [],
): NormalizedCatalogProduct {
  const resolver =
    typeof aliasesOrResolver === "function"
      ? aliasesOrResolver
      : createModelResolver(aliasesOrResolver);
  const resolution = resolver({
    rawModel: product.rawModel,
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
