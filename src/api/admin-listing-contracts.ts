import type { PresentationColorDefinition } from "../catalog/types.js";
export type { PresentationColorDefinition };

/** Shared by the edit preview and the HTTP parser so saved finish labels agree. */
export function canonicalAdminPresentationColor(
  value: string,
  colors: readonly PresentationColorDefinition[],
): string | null {
  if (!value) return "";
  const key = (text: string) =>
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s・･_\-/&+.,'"()（）]+/gu, "");
  const byAlias = new Map<string, PresentationColorDefinition>();
  for (const color of colors) {
    for (const spelling of [color.id, color.name, ...color.aliases, ...color.codes]) {
      const alias = key(spelling);
      if (alias && !byAlias.has(alias)) byAlias.set(alias, color);
    }
  }
  const parts = value.split("/").map((part) => part.trim());
  const selected = parts.map((part) => byAlias.get(key(part)));
  if (selected.some((color) => !color)) return null;
  return [...new Map(selected.map((color) => [color!.id, color!])).values()]
    .sort((left, right) => left.order - right.order)
    .map((color) => color.name)
    .join("/");
}

export interface AdminListingDiagnosis {
  listingId: number;
  observedAt: string;
  seller: { title: string; manufacturer: string; model: string; category: string; url: string };
  decision: {
    manufacturerId: string;
    manufacturer: string;
    manufacturerStatus: string;
    manufacturerMethod: string;
    manufacturerConfidence: string;
    model: string;
    normalizedModel: string;
    modelStatus: string;
    modelMethod: string;
    modelConfidence: string;
    category: string;
    categoryId: string;
    categoryStatus: string;
    color: string;
  };
  overrides: Record<string, string | null>;
  identity: {
    status: string | null;
    method: string | null;
    confidence: string | null;
    matchedFields: string;
    rejectedBy: string;
    evaluatedAt: string | null;
    catalogId: number | null;
    catalogName: string | null;
    candidateId: number | null;
    candidateName: string | null;
  };
  search: {
    key: string | null;
    kind: string | null;
    model: string | null;
    categoryId: string | null;
    offerCount: number | null;
    pending: number;
    active: number;
  };
  peers: Array<{
    id: number;
    shop: string;
    category: string;
    modelStatus: string;
    entityKey: string | null;
  }>;
  peersHasMore: boolean;
}
