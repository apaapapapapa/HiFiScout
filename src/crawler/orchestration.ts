import { crawlDispatchToken } from "../db/shop-state-repository.js";
import { isCrawlQueueName } from "./queue-lanes.js";

export const CRAWL_SCHEDULER_OBSERVE_PATH = "/observe-checkpoint";
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

export function selectedCrawlDoShadowShops(value: string | null | undefined): ReadonlySet<string> {
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function shouldObserveCrawlWithDurableObject(
  configuredShops: string | null | undefined,
  shopKey: string,
): boolean {
  return selectedCrawlDoShadowShops(configuredShops).has(shopKey);
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
 * Phase 0/1 observation hook.
 *
 * Every crawl Queue delivery emits one baseline event. Initial deliveries for explicitly selected
 * shops are also mirrored to the per-shop Durable Object, which wakes by Alarm and reads the
 * authoritative D1 checkpoint without mutating crawl lifecycle state. The existing Queue consumer
 * remains the only executor until the Phase 2 canary deliberately changes that boundary.
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
