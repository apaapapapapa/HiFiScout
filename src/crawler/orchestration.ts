import { crawlDispatchToken } from "../db/shop-state-repository.js";
import { isCrawlQueueName } from "./queue-lanes.js";
import { getShopPlugin } from "./shops/index.js";
import type { CrawlQueueMessage } from "./types.js";

export const CRAWL_SCHEDULER_OBSERVE_PATH = "/observe-checkpoint";
export const CRAWL_SCHEDULER_START_PATH = "/start-crawl";
export const CRAWL_SCHEDULER_COMMAND_VERSION = 1 as const;

interface QueueMessageView {
  readonly body: unknown;
}

interface QueueBatchView {
  readonly queue: string;
  readonly messages: readonly QueueMessageView[];
}

interface CrawlDeliveryBody {
  shopKey: string;
  requestedAt: string;
  jobId?: string;
  batchRunId?: string;
  lane?: string;
  collectionRunId?: string;
  continuation?: {
    sequence?: number;
    phase?: string;
    pageKey?: string;
  };
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function crawlDeliveryBody(value: unknown): CrawlDeliveryBody | null {
  if (!isRecord(value)) return null;
  if (typeof value.shopKey !== "string" || typeof value.requestedAt !== "string") return null;
  const continuation = isRecord(value.continuation)
    ? {
        ...(typeof value.continuation.sequence === "number"
          ? { sequence: value.continuation.sequence }
          : {}),
        ...(typeof value.continuation.phase === "string"
          ? { phase: value.continuation.phase }
          : {}),
        ...(typeof value.continuation.pageKey === "string"
          ? { pageKey: value.continuation.pageKey }
          : {}),
      }
    : undefined;
  return {
    shopKey: value.shopKey,
    requestedAt: value.requestedAt,
    ...(typeof value.jobId === "string" ? { jobId: value.jobId } : {}),
    ...(typeof value.batchRunId === "string" ? { batchRunId: value.batchRunId } : {}),
    ...(typeof value.lane === "string" ? { lane: value.lane } : {}),
    ...(typeof value.collectionRunId === "string"
      ? { collectionRunId: value.collectionRunId }
      : {}),
    ...(continuation ? { continuation } : {}),
  };
}

function selectedShops(value: string | null | undefined): ReadonlySet<string> {
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function selectedCrawlDoShadowShops(value: string | null | undefined): ReadonlySet<string> {
  return selectedShops(value);
}

export function selectedCrawlDoCanaryShops(value: string | null | undefined): ReadonlySet<string> {
  return selectedShops(value);
}

export function shouldObserveCrawlWithDurableObject(
  configuredShops: string | null | undefined,
  shopKey: string,
): boolean {
  return selectedCrawlDoShadowShops(configuredShops).has(shopKey);
}

export function shouldExecuteCrawlWithDurableObject(
  configuredShops: string | null | undefined,
  shopKey: string,
): boolean {
  return selectedCrawlDoCanaryShops(configuredShops).has(shopKey);
}

/**
 * Phase 3 removes workload size from the eligibility decision. Large direct collectors use the
 * same one-step-per-Alarm executor as the Phase 2 canary; page count and historical "heavy" lane
 * classification are rollout metadata only and must never change correctness routing.
 *
 * Shops that still perform additional seller HTTP outside the ordinary page fetch path remain
 * excluded until that secondary traffic is explicitly placed under the same Alarm pacing authority.
 * Relay transports remain Phase 4/5 work because they require the PREPARE/FETCH permit protocol.
 */
export function isCrawlDoCanaryEligible(shopKey: string): boolean {
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return false;
  const transport = plugin.capabilities.transport?.kind || "direct";
  return (
    transport === "direct" &&
    !plugin.capabilities.inventoryRecheck &&
    !plugin.capabilities.detailCategoryEvidence
  );
}

export function buildCrawlSchedulerObserveCommand(
  body: Pick<CrawlDeliveryBody, "shopKey" | "requestedAt" | "jobId" | "collectionRunId">,
): CrawlSchedulerObserveCommand {
  return {
    schemaVersion: CRAWL_SCHEDULER_COMMAND_VERSION,
    type: "observe_checkpoint",
    shopKey: body.shopKey,
    requestedAt: body.requestedAt,
    jobId: body.jobId || crawlDispatchToken(body.shopKey, body.requestedAt),
    runId: body.collectionRunId || crawlDispatchToken(body.shopKey, body.requestedAt),
  };
}

function logBaselineDelivery(queue: string, body: CrawlDeliveryBody): void {
  console.log(
    JSON.stringify({
      event: "crawl_queue_baseline_delivery",
      queue,
      shopKey: body.shopKey,
      requestedAt: body.requestedAt,
      jobId: body.jobId || crawlDispatchToken(body.shopKey, body.requestedAt),
      batchRunId: body.batchRunId || null,
      lane: body.lane || null,
      collectionRunId: body.collectionRunId || null,
      continuation: Boolean(body.continuation),
      continuationSequence: body.continuation?.sequence ?? null,
      continuationPhase: body.continuation?.phase ?? null,
      continuationPageKey: body.continuation?.pageKey ?? null,
    }),
  );
}

async function scheduleShadowObservation(env: Env, body: CrawlDeliveryBody): Promise<void> {
  if (body.continuation) return;
  // The authoritative canary and the Phase 1 observer must never compete for one shop object.
  if (shouldExecuteCrawlWithDurableObject(env.CRAWL_DO_CANARY_SHOPS, body.shopKey)) return;
  if (!shouldObserveCrawlWithDurableObject(env.CRAWL_DO_SHADOW_SHOPS, body.shopKey)) return;

  const command = buildCrawlSchedulerObserveCommand(body);
  try {
    const id = env.CRAWL_SCHEDULER.idFromName(body.shopKey);
    const stub = env.CRAWL_SCHEDULER.get(id);
    const response = await stub.fetch(
      `https://crawl-scheduler.internal${CRAWL_SCHEDULER_OBSERVE_PATH}`,
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
        event: "crawl_do_shadow_scheduled",
        shopKey: body.shopKey,
        requestedAt: body.requestedAt,
        jobId: command.jobId,
        runId: command.runId,
      }),
    );
  } catch (error) {
    // Phase 1 is observation-only. The Queue path remains authoritative and must not fail because
    // the shadow control-plane probe is unavailable.
    console.warn(
      JSON.stringify({
        event: "crawl_do_shadow_schedule_failed",
        shopKey: body.shopKey,
        requestedAt: body.requestedAt,
        jobId: command.jobId,
        runId: command.runId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Delivers an immutable dispatch identity to exactly one control-plane transport. Phase 2/3
 * selected shops use their per-shop Durable Object; every other shop stays on its existing Queue
 * lane. The decision is an explicit allowlist only — workload lane, Queue quota and runtime cost
 * never alter correctness routing.
 */
export async function deliverCrawlDispatch(
  env: Env,
  message: CrawlQueueMessage,
  queue: Pick<Queue<CrawlQueueMessage>, "send">,
): Promise<"durable_object" | "queue"> {
  if (!shouldExecuteCrawlWithDurableObject(env.CRAWL_DO_CANARY_SHOPS, message.shopKey)) {
    await queue.send(message);
    return "queue";
  }
  if (!isCrawlDoCanaryEligible(message.shopKey)) {
    throw new Error(`crawl DO canary shop is not eligible: ${message.shopKey}`);
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
      event: "crawl_do_canary_dispatched",
      shopKey: message.shopKey,
      requestedAt: message.requestedAt,
      jobId: message.jobId || crawlDispatchToken(message.shopKey, message.requestedAt),
      batchRunId: message.batchRunId || null,
      lane: message.lane || null,
    }),
  );
  return "durable_object";
}

/**
 * Phase 0/1 observation hook.
 *
 * Every crawl Queue delivery emits one baseline event. Initial deliveries for explicitly selected
 * shops are also mirrored to the per-shop Durable Object, which wakes by Alarm and reads the
 * authoritative D1 checkpoint without mutating crawl lifecycle state. Phase 2/3 selected deliveries
 * do not enter Queue at all, so they are intentionally absent from this baseline hook.
 */
export async function observeCrawlQueueDelivery(batch: QueueBatchView, env: Env): Promise<void> {
  if (!isCrawlQueueName(batch.queue)) return;
  for (const message of batch.messages) {
    const body = crawlDeliveryBody(message.body);
    if (!body) continue;
    logBaselineDelivery(batch.queue, body);
    await scheduleShadowObservation(env, body);
  }
}
