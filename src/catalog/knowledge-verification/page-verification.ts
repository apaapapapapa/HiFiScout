/**
 * Decides what an official page proves about one candidate.
 *
 * Every strategy ends here: whatever route discovered the page, the page itself must confirm the
 * model and yield an unambiguous category before a candidate is promoted. Two failure modes are
 * kept distinct because they mean different things operationally — `not_found` says the page is
 * about something else, `ambiguous` says the page is about this model but its category cannot be
 * trusted, and only the latter is worth re-reviewing.
 *
 * Category evidence is read in descending order of authority. A conflict is a terminal verdict;
 * only a lack of evidence permits fallback to a weaker tier:
 *
 * 1. structured JSON-LD `category` / `name`;
 * 2. model-local semantic blocks and nearby product-content text;
 * 3. page-level description and breadcrumb, which are demoted to `strong` because they describe
 *    the page rather than the model.
 *
 * Model and category evidence must refer to product content. Global navigation/header/footer/aside
 * chrome cannot prove either fact about the candidate.
 */

import { classifyCategoryEvidence } from "../category-classifier.js";
import { inferExplicitCategoryIds } from "../category-rules.js";
import { normalizeManufacturer } from "../manufacturers.js";
import type {
  CategoryClassification,
  CategoryEvidenceInput,
  CategoryEvidenceStrength,
  ClassifiableCategoryId,
} from "../types.js";
import type { KnowledgeSourceCandidate, KnowledgeSourceVerification } from "./types.js";
import {
  brandName,
  breadcrumbText,
  clean,
  flattenJsonLd,
  isProductNode,
  jsonLdValues,
  metaContent,
  visibleText,
} from "./html.js";
import { sha256Hex } from "./http.js";
import {
  candidateModelVariants,
  flexibleIdentityPattern,
  matchesCandidateText,
  normalizeIdentityText,
} from "./model-matching.js";

/** How far either side of a model mention counts as describing that model. */
const MODEL_CONTEXT_CHARS = 96;

/** Bounds the scan of model-bearing blocks on a long index page. */
const MAX_MODEL_BEARING_BLOCKS = 12;

/** Canonical names are display/search facts, not a place to persist a whole page heading. */
const MAX_CANONICAL_NAME_CHARS = 240;

export interface VerifyOfficialProductPageOptions {
  candidate?: KnowledgeSourceCandidate;
  html?: string;
  sourceUrl?: string;
  sourceType?: string;
  httpStatus?: number;
  /** Injected at the verifier composition root; evaluated only on already-scoped evidence. */
  additionalCategoryIds?: (
    text: string,
    candidate: KnowledgeSourceCandidate,
  ) => ClassifiableCategoryId[];
}

function firstElementText(html: string, tag: string): string {
  const match = String(html).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? visibleText(match[1]) : "";
}

/**
 * Text eligible for page-level model-context category evidence.
 *
 * Prefer a semantic main/article container when one exists. On older manufacturer sites that lack
 * either element, remove the standard global-chrome containers before converting the body to text.
 */
function productContentHtml(html: string): string {
  const value = String(html).replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const semantic = value.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2];
  return semantic ?? value;
}

function matchingProductNodes(
  products: readonly Record<string, unknown>[],
  candidate: KnowledgeSourceCandidate,
): Record<string, unknown>[] {
  return products.filter((product) => {
    const identifiers = [product.model, product.sku, product.mpn].filter(Boolean);
    return (identifiers.length ? identifiers : [product.name]).some((value) =>
      matchesCandidateText(value, candidate),
    );
  });
}

/**
 * Category ids stated by official text.
 *
 * The two extra patterns cover phrasings the shared listing rules deliberately leave out: retail
 * listings rarely spell out "Super Audio CD player" or "phono equalizer amplifier", but
 * manufacturer pages do.
 */
function officialCategoryIds(text: unknown = ""): ClassifiableCategoryId[] {
  const value = clean(text);
  if (!value) return [];
  const ids = new Set(inferExplicitCategoryIds(value, { context: "detail" }));
  if (
    /\b(?:disc|disk)\s+player\b|\bsa-?cd\s+player\b|スーパーオーディオ\s*cd(?:\s*\/\s*cd)?\s*(?:プレーヤー|プレイヤー)/i.test(
      value,
    )
  ) {
    ids.add("SRC.DISC");
  }
  if (/\bphono\s+(?:equalizer\s+)?amplifier\b|フォノ(?:イコライザー)?アンプ/i.test(value)) {
    ids.add("AMP.PHONO");
  }
  return [...ids];
}

function categoryEvidence(
  value: unknown,
  strength: CategoryEvidenceStrength = "verified",
  candidate?: KnowledgeSourceCandidate,
  additionalCategoryIds?: VerifyOfficialProductPageOptions["additionalCategoryIds"],
): CategoryEvidenceInput | null {
  const text = clean(value);
  const categoryIds = officialCategoryIds(text);
  if (candidate && additionalCategoryIds)
    categoryIds.push(...additionalCategoryIds(text, candidate));
  return categoryIds.length
    ? { categoryIds, source: "manufacturer_official", strength, value: text }
    : null;
}

/**
 * Category evidence taken from the text immediately around the model.
 *
 * A manufacturer index lists many products in one document, so page-level text would classify all
 * of them the same way. Only the window next to this model's own mention is used.
 */
function modelContextEvidence(
  text: unknown,
  candidate: KnowledgeSourceCandidate,
  strength: CategoryEvidenceStrength = "verified",
  additionalCategoryIds?: VerifyOfficialProductPageOptions["additionalCategoryIds"],
): CategoryEvidenceInput | null {
  const normalizedValue = normalizeIdentityText(text);
  if (!normalizedValue) return null;
  for (const model of candidateModelVariants(candidate)) {
    const pattern = flexibleIdentityPattern(model);
    if (!pattern) continue;
    const match = pattern.exec(normalizedValue);
    if (!match) continue;
    const modelStart = match.index + match[1].length;
    const modelEnd = match.index + match[0].length - match[2].length;
    const left =
      normalizedValue
        .slice(Math.max(0, modelStart - MODEL_CONTEXT_CHARS), modelStart)
        .split(/\s[/|]\s/u)
        .at(-1) || "";
    const right = normalizedValue.slice(
      modelEnd,
      Math.min(normalizedValue.length, modelEnd + MODEL_CONTEXT_CHARS),
    );
    const leftEvidence = categoryEvidence(left, strength, candidate, additionalCategoryIds);
    if (leftEvidence) return leftEvidence;
    const rightEvidence = categoryEvidence(right, strength, candidate, additionalCategoryIds);
    if (rightEvidence) return rightEvidence;
  }
  return null;
}

function modelBearingBlocks(html: string, candidate: KnowledgeSourceCandidate): string[] {
  const blocks: string[] = [];
  for (const match of String(html).matchAll(/<(h[1-4]|p|li|tr|dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = visibleText(match[2]);
    if (text && matchesCandidateText(text, candidate)) blocks.push(text);
    if (blocks.length >= MAX_MODEL_BEARING_BLOCKS) break;
  }
  return blocks;
}

function canonicalNameFromPage(
  candidate: KnowledgeSourceCandidate,
  values: readonly unknown[],
  fallback: string,
): string {
  for (const value of values) {
    const text = clean(value);
    if (text && text.length <= MAX_CANONICAL_NAME_CHARS && matchesCandidateText(text, candidate)) {
      return text;
    }
  }
  return clean(fallback).slice(0, MAX_CANONICAL_NAME_CHARS);
}

/**
 * Verifies one already-fetched official page against one candidate.
 *
 * The message suffix identifies the evidence policy, allowing old page-wide verification results
 * to be selected for budgeted review without refetching every verified product at deployment.
 */
export async function verifyOfficialProductPage({
  candidate,
  html,
  sourceUrl = "",
  sourceType = "manufacturer_official",
  httpStatus = 200,
  additionalCategoryIds,
}: VerifyOfficialProductPageOptions = {}): Promise<KnowledgeSourceVerification> {
  if (!candidate?.manufacturerId || !candidateModelVariants(candidate).length || !html) {
    return {
      status: "not_found",
      sourceUrl,
      sourceType,
      httpStatus,
      message: "missing_candidate_or_page_content",
    };
  }

  const productNodes = jsonLdValues(html)
    .flatMap((value) => flattenJsonLd(value))
    .filter(isProductNode);
  const matchingProducts = matchingProductNodes(productNodes, candidate);
  const product = matchingProducts[0];
  const title = firstElementText(html, "title");
  const contentHtml = productContentHtml(html);
  const h1 = firstElementText(contentHtml, "h1");
  const blocks = modelBearingBlocks(contentHtml, candidate);
  const titleEligible =
    (!h1 || matchesCandidateText(h1, candidate)) &&
    (!productNodes.length || matchingProducts.length > 0);
  const modelMatched = [
    product?.model,
    product?.sku,
    product?.mpn,
    product?.name,
    h1,
    titleEligible ? title : "",
    ...blocks,
  ].some((value) => value && matchesCandidateText(value, candidate));
  if (!modelMatched) {
    return {
      status: "not_found",
      sourceUrl,
      sourceType,
      httpStatus,
      message: "official_page_does_not_confirm_model",
    };
  }

  // An explicit conflicting brand means the page belongs to a different manufacturer's product,
  // which is a stronger signal than any category evidence the page might also carry.
  for (const productNode of matchingProducts) {
    const explicitBrand = brandName(productNode.brand);
    if (!explicitBrand) continue;
    const resolved = normalizeManufacturer(explicitBrand);
    if (resolved.id && resolved.id !== candidate.manufacturerId) {
      return {
        status: "ambiguous",
        sourceUrl,
        sourceType,
        httpStatus,
        message: `official_product_brand_mismatch:${resolved.id}`,
      };
    }
  }

  const structured = matchingProducts
    .flatMap((node) => [node.category, node.name])
    .map((value) => categoryEvidence(value, "verified", candidate, additionalCategoryIds))
    .filter((value): value is CategoryEvidenceInput => value !== null);
  let classification: CategoryClassification | null = structured.length
    ? classifyCategoryEvidence(structured)
    : null;

  if (!classification || classification.classificationReason === "insufficient_evidence") {
    const localEvidence: CategoryEvidenceInput[] = [];
    for (const value of [h1, titleEligible ? title : "", ...blocks]) {
      const evidence = modelContextEvidence(value, candidate, "verified", additionalCategoryIds);
      if (evidence) localEvidence.push(evidence);
    }
    if (!localEvidence.length) {
      const evidence = modelContextEvidence(
        visibleText(contentHtml),
        candidate,
        "verified",
        additionalCategoryIds,
      );
      if (evidence) localEvidence.push(evidence);
    }
    if (localEvidence.length) classification = classifyCategoryEvidence(localEvidence);
  }

  if (!classification || classification.classificationReason === "insufficient_evidence") {
    const fallbackEvidence = [
      product?.description,
      // Page-level labels describe this product only if the page heading identifies it. On index
      // pages a matching paragraph for one sibling must not borrow the page's general category.
      ...([h1, titleEligible ? title : ""].some((value) => matchesCandidateText(value, candidate))
        ? [metaContent(html, "description"), breadcrumbText(html)]
        : []),
    ]
      .map((value) => categoryEvidence(value, "strong", candidate, additionalCategoryIds))
      .filter((value): value is CategoryEvidenceInput => value !== null);
    if (fallbackEvidence.length) classification = classifyCategoryEvidence(fallbackEvidence);
  }

  if (
    !classification ||
    classification.classificationStatus !== "classified" ||
    !classification.categoryIds.length
  ) {
    return {
      status: "ambiguous",
      sourceUrl,
      sourceType,
      httpStatus,
      message:
        classification?.classificationState === "ambiguous"
          ? "conflicting_official_category_evidence"
          : "official_page_has_no_unambiguous_category",
    };
  }

  const directModel = [product?.model, product?.sku, product?.mpn].find(
    (value) => value && matchesCandidateText(value, candidate),
  );
  const canonicalModel = clean(
    candidate.observedModel || candidate.model || directModel || candidate.normalizedModel,
  );
  const fallbackName = `${candidate.observedManufacturer || candidate.manufacturerId} ${canonicalModel}`;
  const canonicalName = canonicalNameFromPage(candidate, [product?.name, h1, title], fallbackName);
  return {
    status: "verified",
    sourceUrl,
    sourceType,
    httpStatus,
    canonicalModel,
    canonicalName,
    categoryIds: classification.categoryIds,
    primaryCategoryId: classification.primaryCategoryId,
    contentHash: await sha256Hex(html),
    message: "verified_from_official_product_page_v3",
  };
}
