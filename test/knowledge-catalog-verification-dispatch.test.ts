import { test } from "vitest";
import assert from "node:assert/strict";

import {
  dispatchKnowledgeCatalogDailyVerification,
  dispatchKnowledgeCatalogMonthlyRecheck,
} from "../src/knowledge-catalog/dispatch.js";
import {
  knowledgeJobRow,
  queueBinding,
  queueDatabase,
  queueEnv,
} from "./helpers/knowledge-queue.js";

/**
 * The two dispatch modes exist because the work they queue is mutually exclusive: the daily run
 * verifies pending candidates, and the monthly run re-reads the sources of already-verified
 * products. Queuing the wrong set either burns the day's request budget on rechecks or lets
 * verified categories silently rot.
 */

const RUN_ID = 42;

function dispatchDatabase() {
  return queueDatabase((sql) => {
    if (sql.includes("INSERT INTO knowledge_catalog_review_runs")) return { lastRowId: RUN_ID };
    if (sql.includes("FROM knowledge_catalog_verification_jobs") && sql.includes("ORDER BY id")) {
      return {
        rows: [
          knowledgeJobRow({
            id: 900,
            run_id: RUN_ID,
            job_key: `knowledge-catalog:${RUN_ID}:finalize`,
            job_type: "finalize",
            target_id: null,
            manufacturer_id: "",
            hostname: "",
            status: "queued",
          }),
        ],
      };
    }
    return {};
  });
}

test("the daily run queues candidate verification and does not mark products due", async () => {
  const db = dispatchDatabase();
  const queue = queueBinding();

  const result = await dispatchKnowledgeCatalogDailyVerification(queueEnv(db, queue.binding));

  assert.equal(result.status, "queued");
  assert.equal(result.mode, "daily_candidates");
  assert.equal(result.runId, RUN_ID);
  assert.equal(
    db.ran("SET review_status = 'due'").length,
    0,
    "marking products due is the monthly run's job",
  );
  assert.equal(db.ran("FROM knowledge_catalog_candidates").length > 0, true);
});

test("the monthly run marks verified products due and queues their rechecks", async () => {
  const db = dispatchDatabase();
  const queue = queueBinding();

  const result = await dispatchKnowledgeCatalogMonthlyRecheck(queueEnv(db, queue.binding));

  assert.equal(result.status, "queued");
  assert.equal(result.mode, "monthly_recheck");
  assert.equal(db.ran("SET review_status = 'due'").length, 1);
  assert.equal(db.ran("FROM knowledge_catalog_products kp").length, 1);
});

test("the finalizer is enqueued behind its targets so it observes their outcomes", async () => {
  const db = dispatchDatabase();
  const queue = queueBinding();

  await dispatchKnowledgeCatalogDailyVerification(queueEnv(db, queue.binding));

  const finalizer = queue.sent.find((entry) => entry.body.jobType === "finalize");
  assert.ok(finalizer, "a run with no targets still needs a finalizer to close it out");
  assert.equal(finalizer.options?.delaySeconds, 60);
  assert.equal(finalizer.body.runId, RUN_ID);
});

test("a run records its classification baseline before any verification is queued", async () => {
  const db = dispatchDatabase();

  await dispatchKnowledgeCatalogDailyVerification(queueEnv(db));

  const baseline = db.ran("active_products_before = ?");
  assert.equal(baseline.length, 1, "the finalizer compares against this baseline to report impact");
  assert.equal(baseline[0].binds.at(-1), RUN_ID);
});

test("a pre-created recovery run is populated without inserting a duplicate review row", async () => {
  const db = dispatchDatabase();
  const queue = queueBinding();
  const result = await dispatchKnowledgeCatalogDailyVerification(queueEnv(db, queue.binding), {
    runId: RUN_ID,
    preferRetries: true,
  });
  assert.equal(result.runId, RUN_ID);
  assert.equal(db.ran("INSERT INTO knowledge_catalog_review_runs").length, 0);
});

test("dispatch refuses to start when the queue binding is missing", async () => {
  const db = dispatchDatabase();

  await assert.rejects(
    () => dispatchKnowledgeCatalogDailyVerification({ DB: db } as never),
    /knowledge_catalog_queue_binding_missing/,
    "starting a run whose jobs cannot be enqueued would leave it running forever",
  );
  assert.equal(db.ran("INSERT INTO knowledge_catalog_review_runs").length, 0);
});
