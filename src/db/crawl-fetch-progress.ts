/** Compact collection progress stored with the DO execution and a page's commit receipt. */
export interface CrawlFetchProgress {
  pages_fetched: number;
  pages_parsed: number;
  coverage_incomplete: 0 | 1;
  reached_end: 0 | 1;
  last_completed_page: string | null;
  continuation_sequence: number;
  next_phase: "fetch" | "parse" | "finalize" | null;
  next_page_key: string | null;
  updated_at: string;
}

export interface StoredCollectionProgress {
  runId: string;
  progress: CrawlFetchProgress;
}

export interface CrawlFetchProgressReceipt extends StoredCollectionProgress {
  version: 1;
  pageKey: string;
  previousSequence: number;
}

/** Pick only progress, never HTML, products, permits, or a growing page frontier. */
export function collectionProgress(row: CrawlFetchProgress): CrawlFetchProgress {
  return {
    pages_fetched: row.pages_fetched,
    pages_parsed: row.pages_parsed,
    coverage_incomplete: row.coverage_incomplete,
    reached_end: row.reached_end,
    last_completed_page: row.last_completed_page,
    continuation_sequence: row.continuation_sequence,
    next_phase: row.next_phase,
    next_page_key: row.next_page_key,
    updated_at: row.updated_at,
  };
}

export function decodeCollectionProgressReceipt(raw: string): CrawlFetchProgressReceipt {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("invalid crawl progress receipt");
  const receipt = value as Partial<CrawlFetchProgressReceipt>;
  const progress = receipt.progress;
  if (
    receipt.version !== 1 ||
    typeof receipt.runId !== "string" ||
    !receipt.runId ||
    typeof receipt.pageKey !== "string" ||
    !receipt.pageKey ||
    !Number.isSafeInteger(receipt.previousSequence) ||
    Number(receipt.previousSequence) < 0 ||
    !progress ||
    typeof progress !== "object" ||
    !Number.isSafeInteger(progress.pages_fetched) ||
    progress.pages_fetched < 0 ||
    !Number.isSafeInteger(progress.pages_parsed) ||
    progress.pages_parsed < 0 ||
    progress.pages_parsed > progress.pages_fetched ||
    !Number.isSafeInteger(progress.continuation_sequence) ||
    progress.continuation_sequence !== Number(receipt.previousSequence) + 1 ||
    ![0, 1].includes(progress.coverage_incomplete) ||
    ![0, 1].includes(progress.reached_end) ||
    !["fetch", "parse", "finalize"].includes(progress.next_phase || "") ||
    !(progress.next_page_key === null || typeof progress.next_page_key === "string") ||
    !(progress.last_completed_page === null || typeof progress.last_completed_page === "string") ||
    typeof progress.updated_at !== "string" ||
    !Number.isFinite(Date.parse(progress.updated_at)) ||
    (progress.next_phase === "finalize" ? progress.next_page_key !== null : !progress.next_page_key)
  )
    throw new Error("invalid crawl progress receipt");
  return receipt as CrawlFetchProgressReceipt;
}
