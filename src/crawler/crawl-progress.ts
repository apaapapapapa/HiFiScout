import { recordCrawlRunProgress } from "../db/crawl-run-repository.js";
import { errorMessage } from "../types.js";
import type { InvocationDeadline } from "../deadline.js";
import type { QueryableDatabase } from "../db/types.js";
import type { CrawlStage } from "./crawl-stages.js";

/**
 * Minimum gap between two heartbeat writes within one stage.
 *
 * A page costs seconds, so writing a heartbeat per page would be affordable — but a shop that
 * discovers fifty of them would still spend fifty statements saying almost the same thing. The
 * throttle keeps the useful resolution (which stage, roughly how many pages) without turning
 * diagnostics into a write load of their own. A stage change always writes, whatever the gap.
 */
const PROGRESS_MIN_INTERVAL_MS = 5_000;

export interface CrawlRunProgressRecorder {
  /**
   * Reports the run's position. Writes when the stage changed or the throttle has elapsed.
   *
   * `pagesDone` counts what this run has collected, so it is carried forward when a later stage
   * reports without one: a run that dies in the listing write still has to say how many seller
   * pages it read, and a stage change that reset the count to zero would erase exactly that.
   *
   * Never throws: the heartbeat exists to explain a failure, so it must not be able to cause one.
   */
  record(stage: CrawlStage, pagesDone?: number): Promise<void>;
}

interface CrawlRunProgressOptions {
  /** Bounds the heartbeat write itself, so diagnostics cannot be what blocks the invocation. */
  deadline: InvocationDeadline;
  minIntervalMs?: number;
  now?: () => Date;
}

/**
 * The durable answer to "where did this run stop".
 *
 * Stage telemetry already names the stage, but only in logs, and only for whoever is watching at
 * the time. A run killed at the platform's wall-clock limit is read hours later by the recovery
 * sweep, from the database alone — so the position has to be in the row.
 *
 * A no-op recorder is returned when the run has no id, which is the case only for callers that
 * never opened a run row.
 */
export function createCrawlRunProgressRecorder(
  db: QueryableDatabase,
  crawlRunId: number | null,
  {
    deadline,
    minIntervalMs = PROGRESS_MIN_INTERVAL_MS,
    now = () => new Date(),
  }: CrawlRunProgressOptions,
): CrawlRunProgressRecorder {
  if (crawlRunId == null) return { async record() {} };

  let lastStage: CrawlStage | null = null;
  let lastWriteAtMs = 0;
  let pagesCollected = 0;

  return {
    async record(stage: CrawlStage, pagesDone?: number): Promise<void> {
      if (pagesDone != null) pagesCollected = Math.max(pagesCollected, pagesDone);
      const at = now();
      const stageChanged = stage !== lastStage;
      if (!stageChanged && at.getTime() - lastWriteAtMs < minIntervalMs) return;
      lastStage = stage;
      lastWriteAtMs = at.getTime();
      try {
        await deadline.guard("crawl_run_progress", () =>
          recordCrawlRunProgress(db, crawlRunId, {
            stage,
            pagesDone: pagesCollected,
            observedAt: at.toISOString(),
          }),
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "crawl_run_progress_failure",
            crawlRunId,
            stage,
            pagesDone: pagesCollected,
            message: errorMessage(error),
          }),
        );
      }
    },
  };
}
