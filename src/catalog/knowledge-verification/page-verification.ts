/**
 * Decides what an official page proves about one candidate.
 *
 * Every strategy ends here: whatever route discovered the page, the page itself must confirm the
 * model and yield an unambiguous category before a candidate is promoted. Two failure modes are
 * kept distinct because they mean different things operationally — `not_found` says the page is
 * about something else, `ambiguous` says the page is about this model but its category cannot be
 * trusted, and only the latter is worth re-reviewing.
 *
 * Category evidence is read in descending order of authority, stopping at the first level that
 * classifies:
 *
 * 1. structured JSON-LD `category` / `name`;
 * 2. model-local semantic blocks such as the page title, headings, paragraphs and list/table rows;
 * 3. page-level description and breadcrumb, which are demoted to `strong` because they describe
 *    the page rather than the model.
 *
 * The complete visible page text is allowed to prove that a model is present, but never to prove
 * its category: global navigation and sibling-product menus are not product facts.
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
  stripTags,
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

export interface VerifyOfficialProductPageOptions {
  candidate?: KnowledgeSourceCandidate;
  html?: string;
  sourceUrl?: string;
  sourceType?: string;
  httpStatus?: number;
}

function firstElementText(html: string, tag: string): string {
  const match = String(html).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function matchingProductNode(
  products: readonly Record<string, unknown>[],
  candidate: KnowledgeSourceCandidate,
): Record<string, unknown> | null {
  return (
    products.find((product) =>
      [product.model, product.sku, product.mpn, product.name].some(
        (value) => value && matchesCandidateText(value, candidate),
      ),
    ) || null
  );
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
    ids.add("cd_sacd_player");
  }
  if (/\bphono\s+(?:equalizer\s+)?amplifier\b|フォノ(?:イコライザー)?アンプ/i.test(value)) {
    ids.add("phono_eq");
  }
  return [...ids];
}

function categoryEvidence(
  value: unknown,
  strength: CategoryEvidenceStrength = "verified",
): CategoryEvidenceInput | null {
  const text = clean(value);
  const categoryIds = officialCategoryIds(text);
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
    const left = normalizedValue.slice(Math.max(0, modelStart - MODEL_CONTEXT_CHARS), modelStart);
    const right = normalizedValue.slice(
      modelEnd,
      Math.min(normalizedValue.length, modelEnd + MODEL_CONTEXT_CHARS),
    );
    const leftEvidence = categoryEvidence(left, strength);
    if (leftEvidence) return leftEvidence;
    const rightEvidence = categoryEvidence(right, strength);
    if (rightEvidence) return rightEvidence;
  }
  return null;
}

function modelBearingBlocks(html: string, candidate: KnowledgeSourceCandidate): string[] {
  const blocks: string[] = [];
  for (const match of String(html).matchAll(/<(h[1-4]|p|li|tr|dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripTags(match[2]);
    if (text && matchesCandidateText(text, candidate)) blocks.push(text);
    if (blocks.length >= MAX_MODEL_BEARING_BLOCKS) break;
  }
  return blocks;
}

/**
 * Verifies one already-fetched official page against one candidate.
 *
 * The `_v2` message suffix is persisted with every verification and read back by operational
 * status, so it is kept verbatim rather than renamed with the module.
 */
export async function verifyOfficialProductPage({
  candidate,
  html,
  sourceUrl = "",
  sourceType = "manufacturer_official",
  httpStatus = 200,
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
  const product = matchingProductNode(productNodes, candidate);
  const title = firstElementText(html, "title");
  const h1 = firstElementText(html, "h1");
  const pageText = visibleText(html);
  const modelMatched = [
    product?.model,
    product?.sku,
    product?.mpn,
    product?.name,
    h1,
    title,
    pageText,
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
  const explicitBrand = brandName(product?.brand);
  if (explicitBrand) {
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

  const structured = [product?.category, product?.name]
    .map((value) => categoryEvidence(value))
    .filter((value): value is CategoryEvidenceInput => value !== null);
  let classification: CategoryClassification | null = structured.length
    ? classifyCategoryEvidence(structured)
    : null;

  if (!classification || classification.classificationStatus !== "classified") {
    const localEvidence: CategoryEvidenceInput[] = [];
    for (const value of [h1, title, ...modelBearingBlocks(html, candidate)]) {
      const evidence = modelContextEvidence(value, candidate);
      if (evidence) localEvidence.push(evidence);
    }
    if (localEvidence.length) classification = classifyCategoryEvidence(localEvidence);
  }

  if (!classification || classification.classificationStatus !== "classified") {
    const fallbackEvidence = [
      product?.description,
      metaContent(html, "description"),
      breadcrumbText(html),
    ]
      .map((value) => categoryEvidence(value, "strong"))
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
  const canonicalName = clean(
    product?.name ||
      h1 ||
      title ||
      `${candidate.observedManufacturer || candidate.manufacturerId} ${canonicalModel}`,
  );
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
    message: "verified_from_official_product_page_v2",
  };
}