import type { CrawlWorkloadObservation } from "../db/crawl-workload-repository.js";
import type { CrawlQueueLane, CrawlQueueMessage, CrawlerEnv, ShopPlugin } from "./types.js";

export const LEGACY_CRAWL_QUEUE = "hifiscout-crawl";
export const LEGACY_CRAWL_DLQ = "hifiscout-crawl-dlq";

export const CRAWL_QUEUE_NAMES: Readonly<Record<CrawlQueueLane, string>> = Object.freeze({
  fast: "hifiscout-crawl-fast",
  heavy: "hifiscout-crawl-heavy",
  relay: "hifiscout-crawl-relay",
});

export const CRAWL_DLQ_NAMES: Readonly<Record<CrawlQueueLane, string>> = Object.freeze({
  fast: "hifiscout-crawl-fast-dlq",
  heavy: "hifiscout-crawl-heavy-dlq",
  relay: "hifiscout-crawl-relay-dlq",
});

const HEAVY_PAGE_THRESHOLD = 30;

/**
 * Observed inventory at which a shop is scheduled as heavy regardless of what it declares.
 *
 * Set from the incident: the shop that stalled reported around 745 listings while its declaration
 * classified it as small. The number is a scheduling threshold, not a safety limit — a shop below
 * it that turns out to be expensive is caught by the budget-exhaustion signal instead.
 */
const HEAVY_ITEM_THRESHOLD = 300;

type CrawlQueueSender = Pick<Queue<CrawlQueueMessage>, "send">;

/**
 * Whether the shop's own definition proves the crawl is small.
 *
 * A shop that omits `defaultMaxPages` inherits the deployment-wide page budget, not a budget of
 * zero — so reading the missing value as a small inventory classified dynamically paginated shops
 * as fast no matter how many pages they went on to discover. Absence is unknown size, and unknown
 * size is only safe to treat as small when the shop cannot discover further pages at all.
 */
function provablySmall(plugin: ShopPlugin): boolean {
  const declaredMaxPages = plugin.definition.defaultMaxPages;
  if (declaredMaxPages == null) return !plugin.discovery.discoverTargets;
  return declaredMaxPages < HEAVY_PAGE_THRESHOLD;
}

/**
 * Whether what the shop has actually cost outweighs what it declares.
 *
 * Both signals are high-water marks, so this only ever promotes: a shop that was large once, or
 * that once had to hand derived work to the continuation sweep, keeps its lane instead of flapping
 * back the first time it reports a quiet day.
 */
function observedHeavy(observation: CrawlWorkloadObservation | null | undefined): boolean {
  if (!observation) return false;
  return observation.peakItemCount >= HEAVY_ITEM_THRESHOLD || observation.budgetExhaustedCount > 0;
}

/**
 * Keep slow transports and broad inventories from consuming the same concurrency pool as the
 * small direct collectors.
 *
 * The lane is operational scheduling metadata; it never changes parsing, and correctness must
 * never depend on a shop being classified correctly. A shop wrongly left in the fast lane still
 * completes, because the same bounded runner and the same continuation sweep finish its derived
 * work either way — the observation only makes it share a pool with shops of its own size sooner.
 */
export function crawlQueueLane(
  plugin: ShopPlugin,
  observation?: CrawlWorkloadObservation | null,
): CrawlQueueLane {
  if (plugin.capabilities.transport?.kind === "relay") return "relay";
  if (observedHeavy(observation)) return "heavy";
  return provablySmall(plugin) ? "fast" : "heavy";
}

/** New lane names plus the legacy queue retained temporarily so already-enqueued work can drain. */
export function isCrawlQueueName(queue: string): boolean {
  return queue === LEGACY_CRAWL_QUEUE || Object.values(CRAWL_QUEUE_NAMES).includes(queue);
}

export function isCrawlDeadLetterQueueName(queue: string): boolean {
  return queue === LEGACY_CRAWL_DLQ || Object.values(CRAWL_DLQ_NAMES).includes(queue);
}

/**
 * Production uses the lane-specific binding. `CRAWL_QUEUE` is a rollout/test fallback and can be
 * removed after the legacy production queue is empty.
 */
export function crawlQueueSender(
  env: CrawlerEnv,
  plugin: ShopPlugin,
  observation?: CrawlWorkloadObservation | null,
): { lane: CrawlQueueLane; queue: CrawlQueueSender } | null {
  const lane = crawlQueueLane(plugin, observation);
  const laneQueue =
    lane === "fast"
      ? env.CRAWL_FAST_QUEUE
      : lane === "heavy"
        ? env.CRAWL_HEAVY_QUEUE
        : env.CRAWL_RELAY_QUEUE;
  const queue = laneQueue || env.CRAWL_QUEUE;
  return queue ? { lane, queue } : null;
}
