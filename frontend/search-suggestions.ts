import { useEffect, useState } from "react";

import {
  MAX_SUGGEST_QUERY_LENGTH,
  MIN_SUGGEST_QUERY_LENGTH,
} from "../src/api/contracts.js";
import { isSuggestResponse } from "./api-client.js";
import type { ApiClient } from "./api-client.js";

const SUGGEST_DEBOUNCE_MS = 180;

/** Mirror the endpoint's canonicalization so equivalent keystrokes reuse one client/cache URL. */
function normalizeSuggestText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/**
 * Build the only public suggestion request the browser is allowed to issue.
 *
 * Short and oversized inputs are stopped before fetch. The server repeats the same validation at
 * the trust boundary, so this is a traffic optimization rather than a security check.
 */
export function suggestionRequestPath(value: string): string | null {
  if ([...value].length > MAX_SUGGEST_QUERY_LENGTH) return null;
  const query = normalizeSuggestText(value);
  const length = [...query].length;
  if (length < MIN_SUGGEST_QUERY_LENGTH || length > MAX_SUGGEST_QUERY_LENGTH) return null;
  return `/api/suggest?q=${encodeURIComponent(query)}`;
}

/** Lightweight typeahead only; selecting a datalist option still goes through the normal q search. */
export function useSearchSuggestions(api: ApiClient, query: string): string[] {
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    const path = suggestionRequestPath(query);
    setSuggestions([]);
    if (!path) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api
        .fetchJson(path, { signal: controller.signal })
        .then((data) => {
          if (!isSuggestResponse(data)) throw new TypeError("Unexpected /api/suggest payload");
          if (!controller.signal.aborted) setSuggestions(data.suggestions);
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === "AbortError") return;
          if (!controller.signal.aborted) setSuggestions([]);
        });
    }, SUGGEST_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, query]);

  return suggestions;
}
