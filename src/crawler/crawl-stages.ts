import { errorMessage } from "../types.js";
import type { InvocationDeadline } from "../deadline.js";

/**
 * The stages one crawl performs, in execution order.
 *
 * The list is the vocabulary operational logs and stalled-run diagnosis share, so a run that is
 * killed mid-flight can be described by the stage it never finished rather than by a stack that a
 * hard termination never produces.
 */
export type CrawlStage =
  | "fetch_parse"
  | "manufacturer_resolution"
  | "category_enrichment"
  | "listing_write"
  | "search_projection"
  | "identity_resolution"
  | "search_entity"
  | "membership_cleanup"
  | "product_metadata"
  | "data_quality";

export interface CrawlStageOptions {
  /** Units handed to the stage, so a slow stage can be read against the work it was given. */
  inputCount?: number;
  /**
   * Failure event name for a stage that already has a documented one. Stages without their own
   * name report the generic `crawl_stage_failure`.
   */
  failureEvent?: string;
}

export interface CrawlStageHandle {
  /** Records the stage as finished, optionally with the units it changed. */
  complete(changedCount?: number | null): void;
  /** Records the stage as failed. The caller still owns the error. */
  fail(error: unknown): void;
}

export interface CrawlStageRecorderOptions {
  /**
   * Outer bound applied to every stage run through {@link CrawlStageRecorder.run}.
   *
   * A stage is the unit a crawl can attribute a failure to, so it is also the right unit to bound:
   * one guard here covers every D1 and R2 call the stage makes, without each repository having to
   * learn about deadlines. Stages that manage their own budget — the derived-work drains — stop
   * gracefully long before this fires; it exists for the ones that would otherwise block forever.
   */
  deadline?: InvocationDeadline;
  /** Durable heartbeat, written as each stage is entered. */
  onStageStart?: (stage: CrawlStage) => Promise<void>;
}

export interface CrawlStageRecorder {
  /**
   * Opens a stage whose body cannot be wrapped in a callback, such as the paging loop.
   *
   * A stage left open reports no failure of its own; the crawl's terminal error accounting names
   * it through {@link CrawlStageRecorder.activeStage}.
   */
  begin(stage: CrawlStage, options?: CrawlStageOptions): CrawlStageHandle;
  /** Runs one stage, logging its start, completion or failure. The result is passed through. */
  run<T>(
    stage: CrawlStage,
    options: CrawlStageOptions & { changedCount?: (result: T) => number },
    operation: () => Promise<T>,
  ): Promise<T>;
  /** The stage currently executing; after a thrown error, the stage that failed. */
  readonly activeStage: CrawlStage | null;
  /** The last stage that finished, which is how far a hard-terminated run actually got. */
  readonly lastCompletedStage: CrawlStage | null;
  /** Completed stage durations in execution order, for the crawl-run summary. */
  stageDurationsMs(): Record<string, number>;
}

/**
 * Per-run stage telemetry.
 *
 * Cloudflare terminates a Queue invocation that exceeds its wall-clock limit without running any
 * catch or finally block, so a stalled crawl leaves no exception to inspect. Emitting the start of
 * every stage means the last `crawl_stage_start` without a matching completion identifies where the
 * invocation died — the measurement a chunking decision has to be based on rather than assume.
 */
export function createCrawlStageRecorder(
  shopKey: string,
  crawlRunId: number | null,
  { deadline, onStageStart }: CrawlStageRecorderOptions = {},
): CrawlStageRecorder {
  const durations = new Map<CrawlStage, number>();
  let activeStage: CrawlStage | null = null;
  let lastCompletedStage: CrawlStage | null = null;

  const recorder: CrawlStageRecorder = {
    get activeStage() {
      return activeStage;
    },
    get lastCompletedStage() {
      return lastCompletedStage;
    },
    stageDurationsMs() {
      return Object.fromEntries(durations);
    },

    begin(stage, { inputCount, failureEvent }: CrawlStageOptions = {}): CrawlStageHandle {
      const startedAt = Date.now();
      activeStage = stage;
      console.log(
        JSON.stringify({
          event: "crawl_stage_start",
          stage,
          shopKey,
          crawlRunId,
          inputCount: inputCount ?? null,
        }),
      );

      return {
        complete(changedCount = null) {
          const durationMs = Date.now() - startedAt;
          durations.set(stage, durationMs);
          activeStage = null;
          lastCompletedStage = stage;
          console.log(
            JSON.stringify({
              event: "crawl_stage_complete",
              stage,
              shopKey,
              crawlRunId,
              inputCount: inputCount ?? null,
              changedCount,
              durationMs,
            }),
          );
        },
        fail(error: unknown) {
          console.warn(
            JSON.stringify({
              event: failureEvent || "crawl_stage_failure",
              stage,
              shopKey,
              crawlRunId,
              inputCount: inputCount ?? null,
              durationMs: Date.now() - startedAt,
              message: errorMessage(error),
            }),
          );
        },
      };
    },

    async run<T>(
      stage: CrawlStage,
      options: CrawlStageOptions & { changedCount?: (result: T) => number },
      operation: () => Promise<T>,
    ): Promise<T> {
      const handle = recorder.begin(stage, options);
      await onStageStart?.(stage);
      let result: T;
      try {
        result = await (deadline ? deadline.guard(stage, operation) : operation());
      } catch (error) {
        handle.fail(error);
        throw error;
      }
      handle.complete(options.changedCount ? options.changedCount(result) : null);
      return result;
    },
  };

  return recorder;
}
