import { crawlDispatchToken } from "../db/shop-state-repository.js";
import { getShopPlugin } from "./shops/index.js";

export const CRAWL_SCHEDULER_START_PATH = "/start-crawl";
export const CRAWL_SCHEDULER_COMMAND_VERSION = 1 as const;

/** Immutable command delivered from cron/manual dispatch to the per-shop Durable Object. */
export interface CrawlDispatchMessage {
  shopKey: string;
  force: boolean;
  requestedAt: string;
  jobId?: string;
  batchRunId?: string;
}

export interface CrawlSchedulerStartCommand {
  schemaVersion: typeof CRAWL_SCHEDULER_COMMAND_VERSION;
  type: "start_crawl";
  message: CrawlDispatchMessage;
}

/** Every registered crawler transport is executed by CrawlScheduler. */
export function isCrawlDoEligible(shopKey: string): boolean {
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return false;
  const transport = plugin.capabilities.transport?.kind || "direct";
  return transport === "direct" || transport === "relay";
}

/** Deliver one immutable dispatch identity to the per-shop Durable Object. */
export async function deliverCrawlDispatch(
  env: Env,
  message: CrawlDispatchMessage,
): Promise<"durable_object"> {
  if (!isCrawlDoEligible(message.shopKey)) {
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
