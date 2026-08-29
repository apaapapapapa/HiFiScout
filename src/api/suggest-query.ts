/** Query-string contract for the bounded `/api/suggest` typeahead endpoint. */

import { MAX_SUGGEST_QUERY_LENGTH } from "./contracts.js";
import { normalizeQueryValue, validateQueryContract } from "./route-contract.js";
import type { QueryParameterContract } from "./route-contract.js";

export interface SuggestQuery {
  q: string;
}

export const SUGGEST_QUERY_PARAMETERS = [
  {
    name: "q",
    type: "string",
    maxLength: MAX_SUGGEST_QUERY_LENGTH,
    normalize: "nfkc-space",
    normalizedMaxLength: MAX_SUGGEST_QUERY_LENGTH,
    description: "Typeahead text, normalized with NFKC and collapsed whitespace.",
  },
] as const satisfies readonly QueryParameterContract[];

/** Reject cache-buster parameters, repetitions, and oversized input before touching D1. */
export function validateSuggestQuery(url: URL): string | null {
  return validateQueryContract(url, SUGGEST_QUERY_PARAMETERS);
}

/** Normalize equivalent user input before both FTS construction and cache-key construction. */
export function parseSuggestQuery(url: URL): SuggestQuery {
  return {
    q: normalizeQueryValue(url.searchParams.get("q") || "", "nfkc-space"),
  };
}

/** Canonical edge-cache URL for a validated suggestion request. */
export function canonicalSuggestQueryUrl(url: URL, query: SuggestQuery): URL {
  const canonical = new URL(url);
  canonical.search = "";
  if (query.q) canonical.searchParams.set("q", query.q);
  return canonical;
}
