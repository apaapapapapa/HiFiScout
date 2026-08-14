/**
 * Deciding whether a page is about a particular model.
 *
 * Two strictnesses coexist on purpose and both are still used:
 *
 * - {@link containsCatalogModelIdentity} requires the model to appear exactly as written. It is
 *   the original, conservative test.
 * - {@link containsFlexibleCatalogModelIdentity} tolerates the separator drift real manufacturer
 *   pages show (`L-507Z` / `L 507Z` / `L507Z`).
 *
 * Both anchor on non-alphanumeric boundaries so `SA-10` never matches inside `SA-100`, which is
 * the failure mode that would promote the wrong product into the catalog.
 */

import { clean } from "./html.js";
import type { KnowledgeSourceCandidate } from "../types.js";

export function escapeRegExp(value: unknown = ""): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Upper-cases and folds the many dash characters manufacturer pages use into ASCII `-`. */
export function normalizeIdentityText(value: unknown = ""): string {
  return clean(value)
    .toUpperCase()
    .replace(/[‐‑‒–—―－]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ");
}

/** Exact match, bounded by non-alphanumeric characters. */
export function containsCatalogModelIdentity(text: unknown = "", model: unknown = ""): boolean {
  const normalizedText = normalizeIdentityText(text);
  const normalizedModel = normalizeIdentityText(model);
  if (!normalizedText || !normalizedModel) return false;
  const pattern = new RegExp(`(^|[^A-Z0-9])${escapeRegExp(normalizedModel)}($|[^A-Z0-9])`, "i");
  return pattern.test(normalizedText);
}

/** Same boundaries, but the model's own separators may be spelled any way (or omitted). */
export function flexibleIdentityPattern(model: unknown = ""): RegExp | null {
  const normalized = normalizeIdentityText(model);
  if (!normalized) return null;
  const parts = normalized.split(/[\s_-]+/).filter(Boolean);
  if (!parts.length) return null;
  return new RegExp(`(^|[^A-Z0-9])${parts.map(escapeRegExp).join("[\\s_-]*")}($|[^A-Z0-9])`, "i");
}

export function containsFlexibleCatalogModelIdentity(
  text: unknown = "",
  model: unknown = "",
): boolean {
  const pattern = flexibleIdentityPattern(model);
  return Boolean(pattern && pattern.test(normalizeIdentityText(text)));
}

/**
 * Removes a leading brand name from a model string.
 *
 * Listings often carry `LUXMAN L-507Z` where the official page says only `L-507Z`. The lookahead
 * keeps `MARANTZ` from being stripped out of a model that merely starts with those letters.
 */
export function stripManufacturerPrefix(model: unknown, prefix: unknown): string {
  const value = clean(model);
  const brand = clean(prefix);
  if (!value || !brand) return "";
  const pattern = new RegExp(`^${escapeRegExp(brand)}(?=$|[\\s・･_\\-\\/&+.,'"()（）])`, "i");
  if (!pattern.test(value)) return "";
  return value
    .replace(pattern, "")
    .replace(/^[\s・･_\-/&+.,'"()（）]+/, "")
    .trim();
}

/** Every spelling of the candidate's model worth searching for, longest first. */
export function candidateModelVariants(candidate: KnowledgeSourceCandidate = {}): string[] {
  const variants = new Set<string>();
  const rawValues = [candidate.observedModel, candidate.model, candidate.normalizedModel].filter(
    Boolean,
  );
  for (const raw of rawValues) {
    const value = clean(raw);
    if (!value) continue;
    variants.add(value);
    for (const prefix of [candidate.observedManufacturer, candidate.manufacturerId]) {
      const stripped = stripManufacturerPrefix(value, prefix);
      if (stripped) variants.add(stripped);
    }
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

export function matchesCandidateText(text: unknown, candidate: KnowledgeSourceCandidate): boolean {
  return candidateModelVariants(candidate).some((model) =>
    containsFlexibleCatalogModelIdentity(text, model),
  );
}
