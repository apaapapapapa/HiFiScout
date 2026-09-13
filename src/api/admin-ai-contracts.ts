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

export type AiJobStatus =
  | "queued"
  | "processing"
  | "suggested"
  | "no_suggestion"
  | "invalid"
  | "deferred"
  | "stale"
  | "failed"
  | "reviewed";
export interface AiJobSummary {
  id: string;
  candidateId: number;
  status: AiJobStatus;
  attempts: number;
  title: string;
  model: string;
  manufacturerId: string;
  updatedAt: string;
  error: string;
  reviewOutcome: string | null;
}
export interface AiCatalogPage {
  enabled: boolean;
  evaluationApproved: boolean;
  model: string;
  budget: {
    day: string;
    allowance: number;
    reserved: number;
    startedJobs: number;
    blocked: boolean;
  } | null;
  items: AiJobSummary[];
  next: { updatedAt: string; id: string } | null;
}
export interface AiCatalogDetail {
  job: AiJobSummary;
  snapshot: AiCatalogSnapshot | null;
  suggestion: AiCatalogSuggestion | null;
  fresh: boolean;
  handoffUrl: string | null;
  attempts: {
    ordinal: number;
    day: string;
    reservedMilli: number;
    actualMilli: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number | null;
    outcome: string;
  }[];
}
export type AiAdminCommand =
  | { action: "list"; status: AiJobStatus; before: { updatedAt: string; id: string } | null }
  | { action: "detail" | "retry"; id: string }
  | { action: "prepare"; candidateId: number }
  | { action: "review"; id: string; outcome: AiReviewOutcome }
  | {
      action: "grant";
      allowanceNeurons: number;
      evidence: string;
      checkedAt: string;
      otherConsumersAccountedFor: true;
    }
  | { action: "block" };

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
