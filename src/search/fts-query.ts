const MAX_TERMS = 12;

export interface FtsSearchPlan {
  query: string;
  terms: string[];
  ftsTerms: string[];
  shortTerms: string[];
  ftsQuery: string;
}

function clean(value: unknown = ""): string {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function quoteFtsTerm(value: unknown = ""): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function parseFtsSearchQuery(value: unknown = ""): FtsSearchPlan {
  const query = clean(value);
  if (!query) return { query: "", terms: [], ftsTerms: [], shortTerms: [], ftsQuery: "" };

  const terms = query.split(" ").filter(Boolean).slice(0, MAX_TERMS);
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
