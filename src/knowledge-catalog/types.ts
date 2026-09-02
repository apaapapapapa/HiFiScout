/**
 * Shapes shared across the verification queue's modules.
 *
 * Kept leaf-like — types only, no imports from the queue's own modules — so policy, processing,
 * dispatch and finalization can all depend on it without forming a cycle.
 */

import type {
  KnowledgeSourceCandidate,
  KnowledgeSourceStatus,
  KnowledgeSourceVerification,
  KnowledgeVerificationEnv,
} from "../catalog/knowledge-verification/types.js";
import type { KnowledgeCatalogJobType, QueryableDatabase } from "../db/types.js";

/** Which dispatcher enqueued a knowledge-catalog verification run. */
export type KnowledgeCatalogDispatchMode = "daily_candidates" | "monthly_recheck";

/** The only message produced for a new verification run. D1 owns every unit of work. */
export interface KnowledgeCatalogRunWakeMessage {
  kind: "knowledge_catalog_run_wakeup";
  runId: number;
}

/**
 * Job-level message emitted by Workers deployed before run wake-ups.
 *
 * It remains readable during the rolling deployment so already-enqueued work is not stranded. New
 * dispatches never create this shape.
 */
export interface LegacyKnowledgeCatalogJobMessage {
  jobId: number;
  runId: number;
  jobType: KnowledgeCatalogJobType;
  mode: KnowledgeCatalogDispatchMode;
  preferRetries: boolean;
  verifierVersion: number;
  hostname?: string;
  target?: KnowledgeSourceCandidate;
}

export type KnowledgeCatalogQueueMessage =
  | KnowledgeCatalogRunWakeMessage
  | LegacyKnowledgeCatalogJobMessage;

/** Immutable context persisted on every job created for a run. */
export interface KnowledgeCatalogJobPayload {
  mode: KnowledgeCatalogDispatchMode;
  preferRetries: boolean;
  verifierVersion: number;
  target?: KnowledgeSourceCandidate;
}

/**
 * Configuration the Knowledge Catalog review pipeline reads.
 *
 * This context owns its settings instead of extending `CrawlerEnv`. Verification still reuses the
 * crawler's robots-respecting fetch implementation, but its configuration contract is independent,
 * so changes to shop/crawl settings cannot leak into queue policy types.
 */
export interface KnowledgeCatalogConfigEnv extends KnowledgeVerificationEnv {
  readonly KNOWLEDGE_CATALOG_SOURCE_REQUEST_DELAY_MS?: string;
  readonly KNOWLEDGE_CATALOG_DAILY_VERIFY_MAX_CANDIDATES?: string;
  readonly KNOWLEDGE_CATALOG_VERIFY_MAX_CANDIDATES?: string;
  readonly KNOWLEDGE_CATALOG_VERIFY_MAX_DUE_PRODUCTS?: string;
  readonly KNOWLEDGE_CATALOG_REVIEW_INTERVAL_DAYS?: string;
  readonly KNOWLEDGE_CATALOG_QUEUE_JOB_LEASE_SECONDS?: string;
  readonly KNOWLEDGE_CATALOG_QUEUE_DOMAIN_LEASE_SECONDS?: string;
  readonly KNOWLEDGE_CATALOG_QUEUE_DOMAIN_RETRY_SECONDS?: string;
  readonly KNOWLEDGE_CATALOG_QUEUE_TRANSIENT_MAX_ATTEMPTS?: string;
  readonly KNOWLEDGE_CATALOG_QUEUE_FINALIZE_RETRY_SECONDS?: string;
  readonly KNOWLEDGE_CATALOG_QUEUE_WAKE_MAX_JOBS?: string;
  readonly KNOWLEDGE_CATALOG_QUEUE_WAKE_WALL_BUDGET_MS?: string;
  readonly KNOWLEDGE_CATALOG_IDENTITY_CONVERGENCE_MAX_GROUPS?: string;
  readonly KNOWLEDGE_CATALOG_REMEDIATION_MAX_PRODUCTS?: string;
  readonly KNOWLEDGE_CATALOG_REMEDIATION_MAX_LISTINGS?: string;
}

/**
 * What the queue's modules need from the Worker environment.
 *
 * Narrower than `Env`: only Knowledge Catalog settings plus the database and producer binding, so
 * these modules stay callable from a test without standing up the crawler or whole Worker.
 */
export interface KnowledgeCatalogQueueEnv extends KnowledgeCatalogConfigEnv {
  DB: QueryableDatabase;
  KNOWLEDGE_CATALOG_QUEUE: Pick<Queue<KnowledgeCatalogQueueMessage>, "send">;
}

export interface DispatchOptions {
  now?: Date;
  /** Prefers candidates that already failed once, for a retry-focused run. */
  preferRetries?: boolean;
  /** Non-zero while a verifier rollout is in flight, so finalization can close it out. */
  verifierVersion?: number;
  /** Existing atomically-claimed run row used only by failed-run recovery. */
  runId?: number;
}

export interface DispatchRunOptions extends DispatchOptions {
  mode: KnowledgeCatalogDispatchMode;
}

/**
 * The outcome of verifying one target, after its result has been persisted.
 *
 * `verification` is carried alongside the counters because the consumer still has to decide
 * whether the failure was transient enough to retry.
 */
export interface VerificationTargetResult {
  outcome: KnowledgeSourceStatus;
  promoted: number;
  rechecked: number;
  verification: KnowledgeSourceVerification;
}
