import { crawlDispatchToken } from "../db/shop-state-repository.js";
import { getShopPlugin } from "./shops/index.js";
import type { CrawlQueueMessage } from "./types.js";

export const CRAWL_SCHEDULER_OBSERVE_PATH = "/observe-checkpoint";
export const CRAWL_SCHEDULER_START_PATH = "/start-crawl";
export const CRAWL_SCHEDULER_COMMAND_VERSION = 1 as const;

export interface CrawlSchedulerObserveCommand {
  schemaVersion: typeof CRAWL_SCHEDULER_COMMAND_VERSION;
  type: "observe_checkpoint";
  shopKey: string;
  requestedAt: string;
  jobId: string;
  runId: string;
}

export interface CrawlSchedulerStartCommand {
  schemaVersion: typeof CRAWL_SCHEDULER_COMMAND_VERSION;
  type: "start_crawl";
  message: CrawlQueueMessage;
}

function selectedShops(value: string | null | undefined): ReadonlySet<string> {
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/** @deprecated Phase 6 removed crawl Queue rollout routing; retained until Phase 7 cleanup. */
export function selectedCrawlDoShadowShops(value: string | null | undefined): ReadonlySet<string> {
  return selectedShops(value);
}

/** @deprecated Phase 6 removed crawl Queue rollout routing; retained until Phase 7 cleanup. */
export function selectedCrawlDoCanaryShops(value: string | null | undefined): ReadonlySet<string> {
  return selectedShops(value);
}

/** @deprecated Shadow observation no longer participates in crawl delivery. */
export function shouldObserveCrawlWithDurableObject(
  configuredShops: string | null | undefined,
  shopKey: string,
): boolean {
  return selectedCrawlDoShadowShops(configuredShops).has(shopKey);
}

/**
 * Phase 6 makes CrawlScheduler authoritative for every configured crawl shop. The allowlist is no
 * longer a routing switch; this compatibility helper therefore reflects the final all-DO state.
 */
export function shouldExecuteCrawlWithDurableObject(
  _configuredShops: string | null | undefined,
  shopKey: string,
): boolean {
  return isCrawlDoCanaryEligible(shopKey);
}

/**
 * Every current crawler transport is supported by CrawlScheduler. Direct secondary-detail HTTP is
 * paced by the same per-shop Alarm authority as listing pages, while Relay collectors continue to
 * use PREPARE -> Alarm -> FETCH.
 */
export function isCrawlDoCanaryEligible(shopKey: string): boolean {
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return false;
  const transport = plugin.capabilities.transport?.kind || "direct";
  return transport === "direct" || transport === "relay";
}

export function buildCrawlSchedulerObserveCommand(body: {
  shopKey: string;
  requestedAt: string;
  jobId?: string;
  collectionRunId?: string;
}): CrawlSchedulerObserveCommand {
  return {
    schemaVersion: CRAWL_SCHEDULER_COMMAND_VERSION,
    type: "observe_checkpoint",
    shopKey: body.shopKey,
    requestedAt: body.requestedAt,
    jobId: body.jobId || crawlDispatchToken(body.shopKey, body.requestedAt),
    runId: body.collectionRunId || crawlDispatchToken(body.shopKey, body.requestedAt),
  };
}

/** Deliver one immutable dispatch identity to the per-shop Durable Object. */
export async function deliverCrawlDispatch(
  env: Env,
  message: CrawlQueueMessage,
): Promise<"durable_object"> {
  if (!isCrawlDoCanaryEligible(message.shopKey)) {
    throw new Error(`crawl shop is not eligible for DO execution: ${message.shopKey}`);
  }

  const command: CrawlSchedulerStartCommand = {
    schemaVersion: CRAWL_SCHEDULER_COMMAND_VERSION,
    type: "start_crawl",
    message,
  };
  const id = env.CRAWL_SCHEDULER.idFromName(message.shopKey);
  const stub = env.CRAWL_SCHEDULER.get(id);
  const response = await stub.fetch(
    `https://crawl-scheduler.internal${CRAWL_SCHEDULER_START_PATH}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    },
  );
  if (!response.ok) {
    throw new Error(`crawl scheduler returned HTTP ${response.status}`);
  }
  console.log(
    JSON.stringify({
      event: "crawl_do_dispatched",
      shopKey: message.shopKey,
      requestedAt: message.requestedAt,
      jobId: message.jobId || crawlDispatchToken(message.shopKey, message.requestedAt),
      batchRunId: message.batchRunId || null,
    }),
  );
  return "durable_object";
}
