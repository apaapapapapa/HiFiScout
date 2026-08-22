/**
 * Queue routing.
 *
 * One Worker consumes three queues, and Cloudflare delivers them all through the same handler, so
 * each batch is identified by queue name *and* by a body shape guard before it is dispatched. An
 * unrecognised batch is retried rather than acked, so a misrouted message is never silently lost.
 */

import { consumeCrawlMessage } from "./crawler/dispatch.js";
import { getSyncHealth, logSyncHealth } from "./health.js";
import {
  consumeKnowledgeCatalogVerificationBatch,
  consumeKnowledgeCatalogVerificationDeadLetterBatch,
} from "./knowledge-catalog/consumer.js";
import {
  KNOWLEDGE_CATALOG_VERIFICATION_DLQ,
  KNOWLEDGE_CATALOG_VERIFICATION_QUEUE,
} from "./knowledge-catalog/queue-names.js";
import { isRecord } from "./types.js";
import type { CrawlQueueMessage } from "./crawler/types.js";
import type { KnowledgeCatalogQueueMessage } from "./knowledge-catalog/types.js";

export const CRAWL_QUEUE = "hifiscout-crawl";

export type WorkerQueueMessage = CrawlQueueMessage | KnowledgeCatalogQueueMessage;

function isCrawlBatch(
  batch: MessageBatch<WorkerQueueMessage>,
): batch is MessageBatch<CrawlQueueMessage> {
  return batch.messages.every((message) => isRecord(message.body) && "shopKey" in message.body);
}

function isKnowledgeCatalogBatch(
  batch: MessageBatch<WorkerQueueMessage>,
): batch is MessageBatch<KnowledgeCatalogQueueMessage> {
  return batch.messages.every((message) => isRecord(message.body) && "jobId" in message.body);
}

function queueWaitMs(requestedAt: string, receivedAtMs: number): number | null {
  const requestedAtMs = new Date(requestedAt).getTime();
  if (!Number.isFinite(requestedAtMs)) return null;
  return Math.max(0, receivedAtMs - requestedAtMs);
}

/**
 * A crawl job is acked whether it succeeded or failed: a failed crawl has already recorded its
 * failure in `shop_sync_state`, and retrying it here would re-fetch the shop immediately.
 *
 * The structured timing fields are intentionally attached to the existing completion/failure
 * events so Cloudflare Observability can group queue wait and crawl wall time by `shopKey` without
 * a second log join.
 */
async function consumeCrawlBatch(batch: MessageBatch<CrawlQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const receivedAtMs = Date.now();
    const queueReceivedAt = new Date(receivedAtMs).toISOString();
    const result = await consumeCrawlMessage(env, message.body);
    const completedAtMs = Date.now();
    const timing = {
      requestedAt: message.body.requestedAt,
      queueReceivedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      queueWaitMs: queueWaitMs(message.body.requestedAt, receivedAtMs),
      crawlDurationMs: Math.max(0, completedAtMs - receivedAtMs),
    };
    if (result.status === "failed") {
      console.error(JSON.stringify({ event: "crawl_queue_job_failed", ...result, ...timing }));
    } else {
      console.log(JSON.stringify({ event: "crawl_queue_job_completed", ...result, ...timing }));
    }
    const health = await getSyncHealth(env);
    logSyncHealth(health);
    message.ack();
  }
}

export async function handleQueue(
  batch: MessageBatch<WorkerQueueMessage>,
  env: Env,
): Promise<void> {
  if (batch.queue === KNOWLEDGE_CATALOG_VERIFICATION_QUEUE && isKnowledgeCatalogBatch(batch)) {
    return consumeKnowledgeCatalogVerificationBatch(env, batch);
  }
  if (batch.queue === KNOWLEDGE_CATALOG_VERIFICATION_DLQ && isKnowledgeCatalogBatch(batch)) {
    return consumeKnowledgeCatalogVerificationDeadLetterBatch(env, batch);
  }
  if (batch.queue === CRAWL_QUEUE && isCrawlBatch(batch)) return consumeCrawlBatch(batch, env);

  console.error(JSON.stringify({ event: "unknown_queue", queue: batch.queue }));
  for (const message of batch.messages) message.retry();
}
