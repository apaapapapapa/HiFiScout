import type {
  CrawlFetchContinuationPhase,
  CrawlFetchSessionRow,
} from "../db/crawl-fetch-session-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import type { CrawlQueueMessage, CrawlResult, CrawlerEnv, FetchHtmlPageOptions } from "./types.js";

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
  /** Queue is the legacy transport; return_only lets a Durable Object persist the next command. */
  continuationDelivery?: "queue" | "return_only";
  /** Create/read the D1 session and return its canonical continuation without executing it. */
  initializeOnly?: boolean;
  /** Prepared seller fetch supplied by the Durable Object after Alarm-based pacing. */
  fetchHtmlPage?: (url: string, options: FetchHtmlPageOptions) => Promise<string>;
  /** Phase 5 fail-closed guard: finalization may consume staged detail HTTP but never fetch around it. */
  requireStagedDetailFetches?: boolean;
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
  return `crawl:${shopKey}:${requestedAt}`;
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
