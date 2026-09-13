import type { QueryableDatabase } from "../db/types.js";

export const AI_CATALOG_QUEUE = "hifiscout-ai-catalog";
export const AI_CATALOG_DLQ = "hifiscout-ai-catalog-dlq";
export interface AiCatalogMessage {
  kind: "ai_catalog_job";
  jobId: string;
}
export interface AiCatalogEnv {
  DB: QueryableDatabase;
  AI?: Ai;
  AI_CATALOG_QUEUE?: Queue<AiCatalogMessage>;
  AI_CATALOG_ENABLED?: string;
  /** Set only after a recorded live evaluation of this exact policy passes. */
  AI_CATALOG_EVALUATION_POLICY?: string;
}
export interface AiJobRow {
  id: string;
  candidate_id: number;
  snapshot_json: string;
  status:
    | "queued"
    | "processing"
    | "suggested"
    | "no_suggestion"
    | "invalid"
    | "deferred"
    | "stale"
    | "failed"
    | "reviewed";
  attempts: number;
  attempt_token: string | null;
  lease_until: string | null;
  result_json: string | null;
  error_code: string;
  review_outcome: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface AiBudgetRow {
  day: string;
  policy_key: string;
  allowance_milli: number;
  reserved_milli: number;
  started_jobs: number;
  blocked: number;
  account_evidence: string;
  approved_by: string;
  created_at: string;
}
