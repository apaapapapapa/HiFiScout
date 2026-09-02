// Transitional source-compatibility shim for Phase 7 rollout.
// The crawl Queue consumer no longer exists; execution is owned by the per-shop Durable Object.
export {
  executeResumableCrawlStep as consumeResumableCrawlMessage,
  type CrawlContinuationDescriptor,
  type ResumableCrawlConsumeOptions,
  type ResumableCrawlConsumeResult,
  type ResumableCrawlQueueMessage,
} from "./resumable-crawl-executor.js";
