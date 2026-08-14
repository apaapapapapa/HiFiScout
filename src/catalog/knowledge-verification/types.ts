/**
 * The vocabulary of knowledge source verification.
 *
 * Kept beside the modules that implement it, and deliberately leaf-like: the only thing it reaches
 * for is the category taxonomy, so persistence and the queue can both speak this vocabulary without
 * either becoming a dependency of the other.
 */

import type { CategoryId } from "../types.js";

export type KnowledgeSourceType =
  | "manufacturer_official"
  | "official_distributor"
  | "manufacturer_archive"
  | "trusted_catalog"
  | "manual_verified";

export type KnowledgeSourceStatus =
  | "verified"
  | "not_found"
  | "ambiguous"
  | "unsupported"
  | "error";

/** Fields present on every verification result, whatever the status. */
export interface KnowledgeSourceVerificationBase {
  sourceUrl: string;
  /**
   * `""` on the "unsupported" branch, otherwise copied from the matching
   * `KnowledgeSourceDefinition`, so it is as unvalidated as that field is.
   */
  sourceType: string;
  httpStatus: number | null;
  /** Hash of fetched response content when verification reached a readable source page. */
  contentHash?: string;
  /** Template-interpolated (`http_404`, `...:official_family_v5`); never a literal union. */
  message: string;
}

export interface VerifiedKnowledgeSource extends KnowledgeSourceVerificationBase {
  status: "verified";
  canonicalModel: string;
  canonicalName: string;
  categoryIds: CategoryId[];
  primaryCategoryId: CategoryId;
  /** 64 hex chars, or `""` when `crypto.subtle` is unavailable. */
  contentHash: string;
}

export interface FailedKnowledgeSource extends KnowledgeSourceVerificationBase {
  status: Exclude<KnowledgeSourceStatus, "verified">;
}

/** Discriminated on `status`: checking `status === "verified"` narrows to the rich variant. */
export type KnowledgeSourceVerification = VerifiedKnowledgeSource | FailedKnowledgeSource;

/**
 * Permissive candidate accepted by `verifyCandidate` and `verifyStoredSource`.
 *
 * Every field is optional because the same shape carries a pending catalog candidate, a stored
 * product due for recheck, and an alias substitution; every read is `?.`-guarded or `||`-chained.
 */
export interface KnowledgeSourceCandidate {
  id?: number;
  manufacturerId?: string;
  normalizedModel?: string;
  observedModel?: string;
  observedManufacturer?: string;
  model?: string;
  canonicalModel?: string;
  canonicalName?: string;
  primaryCategoryId?: string | null;
  categoryIds?: readonly string[];
  sampleTitle?: string;
  sourceId?: number;
  sourceUrl?: string;
  sourceType?: KnowledgeSourceType;
}

/** Raw registry entry (bundled defaults or `KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON`). */
export interface KnowledgeSourceDefinitionInput {
  manufacturerId?: string;
  sourceType?: string;
  baseUrl?: string;
  catalogUrls?: readonly string[];
  sitemapUrls?: readonly string[];
  searchUrlTemplate?: string;
  /** `false` removes the manufacturer entirely. */
  enabled?: boolean;
  /** `false` appends to the existing definitions instead of replacing them. */
  replace?: boolean;
}

export interface KnowledgeSourceDefinition {
  manufacturerId: string;
  adapter: "official_site";
  /**
   * Deliberately `string`, not `KnowledgeSourceType`: `normalizedSource()` copies whatever
   * `KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON` supplied without a membership check.
   */
  sourceType: string;
  baseUrl: string;
  catalogUrls: string[];
  sitemapUrls: string[];
  /** `""` when absent; supports `{model}` / `{manufacturer}` placeholders. */
  searchUrlTemplate: string;
}

/** What callers of `createKnowledgeSourceVerifier` may use. */
export interface KnowledgeSourceVerifier {
  verifyCandidate(candidate: KnowledgeSourceCandidate): Promise<KnowledgeSourceVerification>;
  verifyStoredSource(product: KnowledgeSourceCandidate): Promise<KnowledgeSourceVerification>;
  definitions: Map<string, KnowledgeSourceDefinition[]>;
}

export interface KnowledgeSourceVerifierOptions {
  fetchImpl?: typeof fetch;
  /**
   * Whether site-wide generic discovery may run. Retry-only rollouts disable it: it is the
   * slowest strategy and re-running it on a candidate that already failed rarely changes the
   * outcome.
   */
  fallbackEnabled?: boolean;
}

/** Result of the shared bounded fetch in `knowledge-verification/http.ts`. */
export interface FetchTextResult {
  ok: boolean;
  /** `0` when the request threw. */
  status: number;
  url: string;
  text: string;
  /** Present only on the catch branch (`"timeout"` for an abort). */
  error?: string;
}
