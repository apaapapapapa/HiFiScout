import type {
  CrawlFetchContinuationPhase,
  CrawlFetchSessionRow,
} from "../db/crawl-fetch-session-repository.js";
import { crawlDispatchToken } from "../db/shop-state-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import type { CrawlQueueMessage, CrawlResult, CrawlerEnv, FetchHtmlPageOptions } from "./types.js";
import type { CollectionProgressState } from "./collection-progress.js";

export type ResumableRuntimeEnv = CrawlerEnv & { DB: QueryableDatabase };

export interface CrawlContinuationDescriptor {
  sequence: number;
  phase: CrawlFetchContinuationPhase;
  pageKey?: string;
}

export interface ResumableCrawlQueueMessage extends CrawlQueueMessage {
  collectionRunId?: string;
  continuation?: CrawlContinuationDescriptor;
}

export interface ResumableCrawlConsumeOptions {
  /** New DO executions keep collection cursors here; legacy executions finish with D1 progress. */
  collectionProgress?: CollectionProgressState;
  /** Queue is the legacy transport; return_only lets a Durable Object persist the next command. */
  continuationDelivery?: "queue" | "return_only";
  /** Create/read the D1 session and return its canonical continuation without executing it. */
  initializeOnly?: boolean;
  /** Prepared seller fetch supplied by the Durable Object after Alarm-based pacing. */
  fetchHtmlPage?: (url: string, options: FetchHtmlPageOptions) => Promise<string>;
  /** The owning DO can parse one fetched page before committing, without staging its HTML. */
  parseFetchedPage?: boolean;
  /** Phase 5 fail-closed guard: finalization may consume staged detail HTTP but never fetch around it. */
  requireStagedDetailFetches?: boolean;
  /**
   * The instant the Durable Object planned this run's detail enrichment, ISO-8601.
   *
   * Finalization re-evaluates the same time-dependent eligibility policy. Given the planning
   * instant it reaches the same answer; given its own clock it can decide a URL is required that
   * the plan never staged, which `requireStagedDetailFetches` reports as a failed crawl.
   */
  detailDecisionAt?: string;
}

export type ResumableCrawlConsumeResult =
  | {
      kind: "retry";
      shopKey: string;
      runId?: string;
      reason: "crawl_in_progress" | "continuation_ahead" | "finalization_in_progress";
      retryAfterSeconds: number;
    }
  | {
      kind: "continued";
      shopKey: string;
      runId: string;
      sequence: number;
      phase: CrawlFetchContinuationPhase;
      pageKey: string | null;
      continuationMessage: ResumableCrawlQueueMessage;
    }
  | { kind: "terminal"; runId?: string; result: CrawlResult };

export function workerVersion(env: CrawlerEnv): string | null {
  const metadata = (env as CrawlerEnv & { CF_VERSION_METADATA?: { id?: string } })
    .CF_VERSION_METADATA;
  return metadata?.id || null;
}

export function canonicalRunId(shopKey: string, requestedAt: string): string {
  return crawlDispatchToken(shopKey, requestedAt);
}

export function continuationFromSession(
  session: CrawlFetchSessionRow,
): CrawlContinuationDescriptor | null {
  if (!session.next_phase) return null;
  return {
    sequence: session.continuation_sequence,
    phase: session.next_phase,
    ...(session.next_page_key ? { pageKey: session.next_page_key } : {}),
  };
}
