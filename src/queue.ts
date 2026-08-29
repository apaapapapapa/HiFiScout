/**
 * Queue routing.
 *
 * One Worker consumes multiple queues, and Cloudflare delivers them all through the same handler, so
 * each batch is identified by queue name *and* by a body shape guard before it is dispatched. An
 * unrecognised batch is retried rather than acked, so a misrouted message is never silently lost.
 */

import {
  consumeResumableCrawlMessage,
  type ResumableCrawlQueueMessage,
} from "./crawler/resumable-queue-consumer.js";
import { isCrawlDeadLetterQueueName, isCrawlQueueName } from "./crawler/queue-lanes.js";
import { crawlDispatchToken, releaseShopDispatch } from "./db/shop-state-repository.js";
import { getSyncHealth, logSyncHealth } from "./health.js";
import {
  consumeKnowledgeCatalogVerificationBatch,
  consumeKnowledgeCatalogVerificationDeadLetterBatch,
} from "./knowledge-catalog/consumer.js";
import {
  consumeKnowledgeCatalogExportBatch,
  consumeKnowledgeCatalogExportDeadLetterBatch,
} from "./knowledge-catalog-export/consumer.js";
import {
  KNOWLEDGE_CATALOG_VERIFICATION_DLQ,
  KNOWLEDGE_CATALOG_VERIFICATION_QUEUE,
} from "./knowledge-catalog/queue-names.js";
import {
  consumeProductAuditExportBatch,
  consumeProductAuditExportDeadLetterBatch,
} from "./product-audit-export/consumer.js";
import {
  PRODUCT_AUDIT_EXPORT_DLQ,
  PRODUCT_AUDIT_EXPORT_QUEUE,
} from "./product-audit-export/queue-names.js";
import { isProductAuditExportQueueMessage } from "./product-audit-export/types.js";
import { isKnowledgeCatalogExportQueueMessage } from "./knowledge-catalog-export/types.js";
import { isRecord } from "./types.js";
import type { CrawlQueueMessage } from "./crawler/types.js";
import type { KnowledgeCatalogExportQueueMessage } from "./knowledge-catalog-export/types.js";
import type { KnowledgeCatalogQueueMessage } from "./knowledge-catalog/types.js";
import type { ProductAuditExportQueueMessage } from "./product-audit-export/types.js";

/** Kept as an export while the pre-lane production queue drains. */
export const CRAWL_QUEUE = "hifiscout-crawl";

export type WorkerQueueMessage =
  | CrawlQueueMessage
  | KnowledgeCatalogQueueMessage
  | KnowledgeCatalogExportQueueMessage
  | ProductAuditExportQueueMessage;

function isCrawlBatch(
  batch: MessageBatch<WorkerQueueMessage>,
): batch is MessageBatch<CrawlQueueMessage> {
  return batch.messages.every(
    (message) =>
      isRecord(message.body) &&
      typeof message.body.shopKey === "string" &&
      typeof message.body.requestedAt === "string",
  );
}

function isKnowledgeCatalogBatch(
  batch: MessageBatch<WorkerQueueMessage>,
): batch is MessageBatch<KnowledgeCatalogQueueMessage> {
  return batch.messages.every(
    (message) =>
      isRecord(message.body) &&
      typeof message.body.jobId === "number" &&
      typeof message.body.runId === "number" &&
      typeof message.body.jobType === "string",
  );
}

function isProductAuditExportBatch(
  batch: MessageBatch<WorkerQueueMessage>,
): batch is MessageBatch<ProductAuditExportQueueMessage> {
  return batch.messages.every((message) => isProductAuditExportQueueMessage(message.body));
}

function isKnowledgeCatalogExportBatch(
  batch: MessageBatch<WorkerQueueMessage>,
): batch is MessageBatch<KnowledgeCatalogExportQueueMessage> {
  return batch.messages.every((message) => isKnowledgeCatalogExportQueueMessage(message.body));
}

function queueWaitMs(requestedAt: string, receivedAtMs: number): number | null {
  const requestedAtMs = new Date(requestedAt).getTime();
  if (!Number.isFinite(requestedAtMs)) return null;
  return Math.max(0, receivedAtMs - requestedAtMs);
}

/**
 * Crawl collection is deliberately one durable unit per invocation. A continuation that was
 * successfully enqueued is acked immediately; only single-flight/contention is retried in-place.
 * Shop failures are still terminal because the consumer has already persisted their backoff.
 */
async function consumeCrawlBatch(batch: MessageBatch<CrawlQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const receivedAtMs = Date.now();
    const queueReceivedAt = new Date(receivedAtMs).toISOString();
    const body = message.body as ResumableCrawlQueueMessage;
    const result = await consumeResumableCrawlMessage(env, body);
    const completedAtMs = Date.now();
    const timing = {
      requestedAt: body.requestedAt,
      queueReceivedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      queueWaitMs: queueWaitMs(body.requestedAt, receivedAtMs),
      crawlDurationMs: Math.max(0, completedAtMs - receivedAtMs),
    };
    const job = {
      queue: batch.queue,
      jobId: body.jobId || crawlDispatchToken(body.shopKey, body.requestedAt),
      batchRunId: body.batchRunId || null,
      lane: body.lane || null,
      collectionRunId: body.collectionRunId || result.runId || null,
      continuation: body.continuation || null,
    };

    if (result.kind === "retry") {
      const retryAfterSeconds = Math.max(1, result.retryAfterSeconds || 60);
      console.log(
        JSON.stringify({
          event: "crawl_queue_job_deferred",
          ...job,
          ...result,
          ...timing,
          retryAfterSeconds,
        }),
      );
      message.retry({ delaySeconds: retryAfterSeconds });
      continue;
    }

    if (result.kind === "continued") {
      console.log(
        JSON.stringify({ event: "crawl_queue_job_continued", ...job, ...result, ...timing }),
      );
      message.ack();
      continue;
    }

    const crawlResult = result.result;
    if (crawlResult.status === "failed") {
      console.error(
        JSON.stringify({ event: "crawl_queue_job_failed", ...job, ...crawlResult, ...timing }),
      );
    } else {
      console.log(
        JSON.stringify({ event: "crawl_queue_job_completed", ...job, ...crawlResult, ...timing }),
      );
    }
    const health = await getSyncHealth(env);
    logSyncHealth(health);
    message.ack();
  }
}

/**
 * A child that exhausts Queue retries must release only its own reservation. The next scheduler
 * sweep can then create a fresh child job; other shops and any newer reservation are untouched.
 */
async function consumeCrawlDeadLetterBatch(
  batch: MessageBatch<CrawlQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const { shopKey, requestedAt } = message.body;
    const jobId = message.body.jobId || crawlDispatchToken(shopKey, requestedAt);
    await releaseShopDispatch(env.DB, shopKey, crawlDispatchToken(shopKey, requestedAt));
    console.error(
      JSON.stringify({
        event: "crawl_queue_job_dead_lettered",
        queue: batch.queue,
        shopKey,
        requestedAt,
        jobId,
        batchRunId: message.body.batchRunId || null,
        lane: message.body.lane || null,
      }),
    );
    message.ack();
  }
}

export async function handleQueue(
  batch: MessageBatch<WorkerQueueMessage>,
  env: Env,
): Promise<void> {
  if (batch.queue === PRODUCT_AUDIT_EXPORT_QUEUE && isProductAuditExportBatch(batch)) {
    return consumeProductAuditExportBatch(env, batch);
  }
  if (batch.queue === PRODUCT_AUDIT_EXPORT_QUEUE && isKnowledgeCatalogExportBatch(batch)) {
    return consumeKnowledgeCatalogExportBatch(env, batch);
  }
  if (batch.queue === PRODUCT_AUDIT_EXPORT_DLQ && isProductAuditExportBatch(batch)) {
    return consumeProductAuditExportDeadLetterBatch(env, batch);
  }
  if (batch.queue === PRODUCT_AUDIT_EXPORT_DLQ && isKnowledgeCatalogExportBatch(batch)) {
    return consumeKnowledgeCatalogExportDeadLetterBatch(env, batch);
  }
  if (batch.queue === KNOWLEDGE_CATALOG_VERIFICATION_QUEUE && isKnowledgeCatalogBatch(batch)) {
    return consumeKnowledgeCatalogVerificationBatch(env, batch);
  }
  if (batch.queue === KNOWLEDGE_CATALOG_VERIFICATION_DLQ && isKnowledgeCatalogBatch(batch)) {
    return consumeKnowledgeCatalogVerificationDeadLetterBatch(env, batch);
  }
  if (isCrawlQueueName(batch.queue) && isCrawlBatch(batch)) return consumeCrawlBatch(batch, env);
  if (isCrawlDeadLetterQueueName(batch.queue) && isCrawlBatch(batch)) {
    return consumeCrawlDeadLetterBatch(batch, env);
  }

  console.error(JSON.stringify({ event: "unknown_queue", queue: batch.queue }));
  for (const message of batch.messages) message.retry();
}
