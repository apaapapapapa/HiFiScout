import {
  collectionProgress,
  decodeCollectionProgressReceipt,
  type CrawlFetchProgress,
  type CrawlFetchProgressReceipt,
  type StoredCollectionProgress,
} from "../db/crawl-fetch-progress.js";
import {
  getCrawlFetchSession,
  type CrawlFetchPageRow,
  type CrawlFetchSessionRow,
} from "../db/crawl-fetch-session-repository.js";
import type { QueryableDatabase } from "../db/types.js";

/** Mutated during a step, then persisted with its next command in the existing DO write. */
export interface CollectionProgressState {
  value: StoredCollectionProgress | null;
}

export function withCollectionProgress(
  session: CrawlFetchSessionRow,
  state?: CollectionProgressState,
): CrawlFetchSessionRow {
  if (session.progress_storage !== "durable_object") return session;
  if (!state) throw new Error("DO-owned crawl requires its durable collection progress");
  if (state.value && state.value.runId !== session.run_id) {
    throw new Error("crawl collection progress belongs to another generation");
  }
  if (!state.value || session.continuation_sequence > state.value.progress.continuation_sequence) {
    state.value = { runId: session.run_id, progress: collectionProgress(session) };
  }
  return session.status === "collecting" ? { ...session, ...state.value.progress } : session;
}

export async function readCollectionSession(
  db: QueryableDatabase,
  runId: string,
  state?: CollectionProgressState,
): Promise<CrawlFetchSessionRow | null> {
  const row = await getCrawlFetchSession(db, runId);
  return row ? withCollectionProgress(row, state) : null;
}

export function nextCollectionProgress(
  session: CrawlFetchSessionRow,
  changes: Partial<CrawlFetchProgress>,
): CrawlFetchProgressReceipt | undefined {
  if (session.progress_storage !== "durable_object") return undefined;
  if (!session.next_page_key) throw new Error("collection transition requires a page");
  return {
    version: 1,
    runId: session.run_id,
    pageKey: session.next_page_key,
    previousSequence: session.continuation_sequence,
    progress: {
      ...collectionProgress(session),
      ...changes,
      continuation_sequence: session.continuation_sequence + 1,
    },
  };
}

export function acceptCollectionProgress(
  receipt: CrawlFetchProgressReceipt | undefined,
  state?: CollectionProgressState,
): void {
  if (!receipt) return;
  if (!state) throw new Error("missing DO collection progress owner");
  state.value = { runId: receipt.runId, progress: receipt.progress };
}

/** The page write can outlive the Alarm that issued it; consume its receipt before any I/O. */
export function recoverCollectionProgress(
  session: CrawlFetchSessionRow,
  page: CrawlFetchPageRow,
  state?: CollectionProgressState,
): boolean {
  if (session.progress_storage !== "durable_object" || !page.progress_json) return false;
  const receipt = decodeCollectionProgressReceipt(page.progress_json);
  if (receipt.runId !== session.run_id || receipt.pageKey !== page.page_key) {
    throw new Error("crawl page receipt belongs to another generation");
  }
  if (receipt.progress.continuation_sequence <= session.continuation_sequence) return false;
  if (receipt.previousSequence !== session.continuation_sequence) {
    throw new Error("crawl page receipt skipped a collection transition");
  }
  acceptCollectionProgress(receipt, state);
  return true;
}
