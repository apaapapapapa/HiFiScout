/**
 * Bounded configuration reads.
 *
 * Verification limits come from deployment variables, so every one is clamped here rather than
 * trusted: a typo in a Worker variable must not remove a crawl budget.
 */

import { isRecord } from "../../types.js";
import type { KnowledgeSourceCandidate } from "./types.js";

/** Clamps into `[min, max]`; a non-numeric value falls back rather than becoming `NaN`. */
export function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/**
 * Parses `KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON`.
 *
 * Accepts either an array of source records or an object keyed by manufacturer id, and yields the
 * array form. Malformed JSON produces an empty list — a bad deployment variable disables the
 * override rather than failing every verification.
 */
export function parseSourceRegistry(value: unknown): Record<string, unknown>[] {
  if (!value) return [];
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    if (isRecord(parsed)) {
      return Object.entries(parsed)
        .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
        .map(([manufacturerId, config]) => ({ manufacturerId, ...config }));
    }
  } catch {}
  return [];
}

/** Fills `{model}` / `{manufacturer}` in a configured search URL, percent-encoded. */
export function applySearchTemplate(template: string, candidate: KnowledgeSourceCandidate): string {
  if (!template) return "";
  return template
    .replaceAll(
      "{model}",
      encodeURIComponent(
        candidate.observedModel || candidate.model || candidate.normalizedModel || "",
      ),
    )
    .replaceAll(
      "{manufacturer}",
      encodeURIComponent(candidate.observedManufacturer || candidate.manufacturerId || ""),
    );
}
