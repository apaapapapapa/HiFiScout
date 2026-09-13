import { normalizeProductSearchQuery, productSearchTerms } from "../api/contracts.js";

export interface FtsSearchPlan {
  query: string;
  terms: string[];
  ftsTerms: string[];
  shortTerms: string[];
  ftsQuery: string;
}

export function quoteFtsTerm(value: unknown = ""): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function parseFtsSearchQuery(value: unknown = ""): FtsSearchPlan {
  const query = normalizeProductSearchQuery(value);
  if (!query) return { query: "", terms: [], ftsTerms: [], shortTerms: [], ftsQuery: "" };

  const terms = productSearchTerms(query);
  const ftsTerms: string[] = [];
  const shortTerms: string[] = [];
  for (const term of terms) {
    if ([...term].length >= 3) ftsTerms.push(term);
    else shortTerms.push(term);
  }

  return {
    query,
    terms,
    ftsTerms,
    shortTerms,
    ftsQuery: ftsTerms.map(quoteFtsTerm).join(" AND "),
  };
}
