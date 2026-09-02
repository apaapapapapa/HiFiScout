/**
 * Queue routing for the non-crawl workloads that intentionally remain on Cloudflare Queues.
 */

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
import type { KnowledgeCatalogExportQueueMessage } from "./knowledge-catalog-export/types.js";
import type { KnowledgeCatalogQueueMessage } from "./knowledge-catalog/types.js";
import type { ProductAuditExportQueueMessage } from "./product-audit-export/types.js";

export type WorkerQueueMessage =
  | KnowledgeCatalogQueueMessage
  | KnowledgeCatalogExportQueueMessage
  | ProductAuditExportQueueMessage;

function isKnowledgeCatalogBatch(
  batch: MessageBatch<WorkerQueueMessage>,
): batch is MessageBatch<KnowledgeCatalogQueueMessage> {
  return batch.messages.every(
    (message) =>
      isRecord(message.body) &&
      typeof message.body.runId === "number" &&
      (message.body.kind === "knowledge_catalog_run_wakeup" ||
        (typeof message.body.jobId === "number" && typeof message.body.jobType === "string")),
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

  console.error(JSON.stringify({ event: "unknown_queue", queue: batch.queue }));
  for (const message of batch.messages) message.retry();
}
