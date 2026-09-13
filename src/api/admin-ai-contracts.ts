/** Operator-only advisory data. None of these contracts grants authority to change a product. */
export interface AiCatalogOption {
  id: number;
  manufacturerId: string;
  model: string;
  categoryIds: string[];
  revision: string;
}

export interface AiCatalogSnapshot {
  kind: "catalog_model_lead";
  target: {
    candidateId: number;
    manufacturerId: string;
    model: string;
    title: string;
    rawModels: string[];
    categoryIds: string[];
    rejectedBy: string[];
    revision: string;
  };
  candidates: AiCatalogOption[];
}

export interface AiCatalogSuggestion {
  decision: "suggestion" | "no_suggestion";
  catalogProductId: number | null;
  evidence: string[];
}

export type AiReviewOutcome = "useful" | "incorrect" | "insufficient_evidence";

export interface AiEvaluationMetrics {
  total: number;
  correctSuggestions: number;
  falseSuggestions: number;
  correctAbstentions: number;
  missedSuggestions: number;
  invalidResponses: number;
  precision: number | null;
  suggestionRecall: number | null;
  passed: boolean;
}
