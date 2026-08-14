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
} from "../catalog/knowledge-verification/types.js";
import type { CrawlerEnv } from "../crawler/types.js";
import type { KnowledgeCatalogJobType, QueryableDatabase } from "../db/types.js";

/** Which dispatcher enqueued a knowledge-catalog verification run. */
export type KnowledgeCatalogDispatchMode = "daily_candidates" | "monthly_recheck";

/**
 * Body of a `KNOWLEDGE_CATALOG_QUEUE` message.
 *
 * `hostname`/`target` are absent on the `"finalize"` message, which is sent on its own with a
 * delay after the target batch.
 */
export interface KnowledgeCatalogQueueMessage {
  jobId: number;
  runId: number;
  jobType: KnowledgeCatalogJobType;
  mode: KnowledgeCatalogDispatchMode;
  preferRetries: boolean;
  verifierVersion: number;
  hostname?: string;
  target?: KnowledgeSourceCandidate;
}

/**
 * What the queue's modules need from the Worker environment.
 *
 * Narrower than `Env`: only the database and the producer binding, so these modules stay callable
 * from a test without standing up the whole Worker.
 */
export interface KnowledgeCatalogQueueEnv extends CrawlerEnv {
  DB: QueryableDatabase;
  KNOWLEDGE_CATALOG_QUEUE: Pick<Queue<KnowledgeCatalogQueueMessage>, "send" | "sendBatch">;
}

export interface DispatchOptions {
  now?: Date;
  /** Prefers candidates that already failed once, for a retry-focused run. */
  preferRetries?: boolean;
  /** Non-zero while a verifier rollout is in flight, so finalization can close it out. */
  verifierVersion?: number;
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
