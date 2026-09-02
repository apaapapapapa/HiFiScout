import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { consumeKnowledgeCatalogVerificationDeadLetterBatch } from "../src/knowledge-catalog/consumer.js";
import {
  queueBinding,
  queueDatabase,
  queueEnv,
  runWakeMessage,
} from "./helpers/knowledge-queue.js";
import type { KnowledgeCatalogQueueMessage } from "../src/knowledge-catalog/types.js";

function deadLetterBatch(message: Message<KnowledgeCatalogQueueMessage>) {
  return { messages: [message] } as unknown as MessageBatch<KnowledgeCatalogQueueMessage>;
}

test("a duplicate run wake DLQ cannot downgrade a terminal review run", async () => {
  const db = queueDatabase((sql) => {
    if (sql.includes("SELECT status FROM knowledge_catalog_review_runs")) {
      return { row: { status: "success" } };
    }
    return {};
  });
  const queue = queueBinding();
  const { message, acks } = runWakeMessage(3);

  await consumeKnowledgeCatalogVerificationDeadLetterBatch(
    queueEnv(db, queue.binding),
    deadLetterBatch(message),
  );

  assert.equal(acks.length, 1);
  assert.equal(queue.sent.length, 0, "a terminal run needs no replacement wake");
  assert.equal(db.ran("SET status = 'dead_letter'").length, 0);
  assert.equal(db.ran("UPDATE knowledge_catalog_review_runs").length, 0);
  assert.equal(db.ran("UPDATE knowledge_catalog_verifier_state").length, 0);
});

test("a run wake DLQ re-wakes outstanding durable work instead of failing it", async () => {
  const db = queueDatabase((sql) => {
    if (sql.includes("SELECT status FROM knowledge_catalog_review_runs")) {
      return { row: { status: "running" } };
    }
    if (sql.includes("AS outstanding_jobs")) {
      return { row: { outstanding_jobs: 2, next_available_at: null } };
    }
    return {};
  });
  const queue = queueBinding();
  const { message, acks } = runWakeMessage(3);

  await consumeKnowledgeCatalogVerificationDeadLetterBatch(
    queueEnv(db, queue.binding),
    deadLetterBatch(message),
  );

  assert.equal(acks.length, 1);
  assert.deepEqual(queue.sent, [
    {
      body: { kind: "knowledge_catalog_run_wakeup", runId: 3 },
      options: { delaySeconds: 1 },
    },
  ]);
  assert.equal(db.ran("SET status = 'dead_letter'").length, 0);
  assert.equal(db.ran("UPDATE knowledge_catalog_review_runs").length, 0);
  assert.equal(db.ran("UPDATE knowledge_catalog_verifier_state").length, 0);
});
