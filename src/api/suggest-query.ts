/** Query-string contract for the bounded `/api/suggest` typeahead endpoint. */

/** Matches the public product-search free-text ceiling while keeping cache keys bounded. */
export const MAX_SUGGEST_QUERY_LENGTH = 100;

export interface SuggestQuery {
  q: string;
}

function normalizedSuggestText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** Reject cache-buster parameters, repetitions, and oversized input before touching D1. */
export function validateSuggestQuery(url: URL): string | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (key !== "q") return "parameter_unknown";
  }
  if (params.getAll("q").length > 1) return "q_repeated";
  const value = params.get("q");
  if (
    value != null &&
    ([...value].length > MAX_SUGGEST_QUERY_LENGTH ||
      [...normalizedSuggestText(value)].length > MAX_SUGGEST_QUERY_LENGTH)
  ) {
    return "q_too_long";
  }
  return null;
}

/** Normalize equivalent user input before both FTS construction and cache-key construction. */
export function parseSuggestQuery(url: URL): SuggestQuery {
  return { q: normalizedSuggestText(url.searchParams.get("q") || "") };
}

/** Canonical edge-cache URL for a validated suggestion request. */
export function canonicalSuggestQueryUrl(url: URL, query: SuggestQuery): URL {
  const canonical = new URL(url);
  canonical.search = "";
  if (query.q) canonical.searchParams.set("q", query.q);
  return canonical;
}
