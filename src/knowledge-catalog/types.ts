/**
 * Shapes shared across the verification queue's modules.
 *
 * Kept leaf-like — types only, no imports from the queue's own modules — so policy, processing,
 * dispatch and finalization can all depend on it without forming a cycle.
 */

import type { KnowledgeSourceStatus, KnowledgeSourceVerification } from "../catalog/types.js";
import type {
  CrawlerEnv,
  KnowledgeCatalogDispatchMode,
  KnowledgeCatalogQueueMessage,
} from "../crawler/types.js";
import type { QueryableDatabase } from "../db/types.js";

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
