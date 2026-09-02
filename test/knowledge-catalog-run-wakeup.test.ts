import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  claimKnowledgeCatalogVerificationJob,
  claimNextKnowledgeCatalogVerificationJobForRun,
  createKnowledgeCatalogVerificationJobs,
} from "../src/db/knowledge-catalog-verification-queue-repository.js";
import { consumeKnowledgeCatalogVerificationMessage } from "../src/knowledge-catalog/consumer.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { queueBinding, queueEnv, runWakeMessage } from "./helpers/knowledge-queue.js";
import type { KnowledgeCatalogVerificationJobSpec } from "../src/db/types.js";
import type { KnowledgeCatalogJobPayload } from "../src/knowledge-catalog/types.js";

const STARTED_AT = "2026-09-02T00:00:00.000Z";

function createRun() {
  const migrated = migratedSqlite();
  const result = migrated.sqlite
    .prepare("INSERT INTO knowledge_catalog_review_runs(started_at, status) VALUES (?, 'running')")
    .run(STARTED_AT);
  return { ...migrated, runId: Number(result.lastInsertRowid) };
}

function payload(targetId?: number): string {
  return JSON.stringify({
    mode: "daily_candidates",
    preferRetries: false,
    verifierVersion: 0,
    ...(targetId
      ? {
          target: {
            id: targetId,
            manufacturerId: "luxman",
            normalizedModel: `L${targetId}`,
            observedModel: `L-${targetId}`,
          },
        }
      : {}),
  } satisfies KnowledgeCatalogJobPayload);
}

function specs(runId: number, count: number): KnowledgeCatalogVerificationJobSpec[] {
  const jobs: KnowledgeCatalogVerificationJobSpec[] = Array.from({ length: count }, (_, index) => {
    const targetId = index + 1;
    return {
      jobKey: `knowledge-catalog:${runId}:candidate:${targetId}`,
      jobType: "candidate",
      targetId,
      manufacturerId: "luxman",
      hostname: "www.luxman.co.jp",
      payloadJson: payload(targetId),
    };
  });
  jobs.push({
    jobKey: `knowledge-catalog:${runId}:finalize`,
    jobType: "finalize",
    targetId: null,
    manufacturerId: "",
    hostname: "",
    payloadJson: payload(),
  });
  return jobs;
}

test("duplicate claims cannot take a processing job or an early finalizer", async () => {
  const { db, runId } = createRun();
  const jobs = await createKnowledgeCatalogVerificationJobs(db, runId, specs(runId, 2), STARTED_AT);
  const first = await claimNextKnowledgeCatalogVerificationJobForRun(db, runId, STARTED_AT, 900);
  assert.equal(first?.jobType, "candidate");

  assert.equal(
    await claimKnowledgeCatalogVerificationJob(db, first?.id || 0, STARTED_AT, 900),
    null,
    "a duplicate wake cannot claim the lease already held by the first wake",
  );

  const second = await claimNextKnowledgeCatalogVerificationJobForRun(db, runId, STARTED_AT, 900);
  assert.equal(second?.jobType, "candidate");
  assert.notEqual(second?.id, first?.id);
  assert.notEqual(second?.id, jobs.at(-1)?.id, "the finalizer waits for every target to settle");
});

test("one wake processes a bounded slice and redelivery skips terminal jobs", async () => {
  const { sqlite, db, runId } = createRun();
  const jobs = await createKnowledgeCatalogVerificationJobs(db, runId, specs(runId, 4), STARTED_AT);
  const targetIds = jobs.filter((job) => job.jobType !== "finalize").map((job) => job.id);
  sqlite
    .prepare(
      `UPDATE knowledge_catalog_verification_jobs
       SET payload_json = '{invalid', delivery_attempts = 2
       WHERE job_type <> 'finalize'`,
    )
    .run();

  const queue = queueBinding();
  const env = queueEnv(db, queue.binding, {
    KNOWLEDGE_CATALOG_QUEUE_WAKE_MAX_JOBS: "2",
    KNOWLEDGE_CATALOG_QUEUE_WAKE_WALL_BUDGET_MS: "25000",
    KNOWLEDGE_CATALOG_QUEUE_TRANSIENT_MAX_ATTEMPTS: "1",
  });
  const firstWake = runWakeMessage(runId);
  const first = await consumeKnowledgeCatalogVerificationMessage(env, firstWake.message);

  assert.equal(first.status, "continued");
  assert.ok("processedJobs" in first);
  assert.equal(first.processedJobs, 2);
  assert.equal(firstWake.acks.length, 1);
  assert.equal(firstWake.retries.length, 0);
  assert.equal(queue.sent.length, 1, "one successor wake replaces one message per remaining job");
  assert.equal(
    Number(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM knowledge_catalog_verification_jobs WHERE status = 'dead_letter'",
        )
        .get()?.count || 0,
    ),
    2,
  );

  const attemptsAfterFirst = targetIds.map((id) =>
    Number(
      sqlite
        .prepare("SELECT delivery_attempts FROM knowledge_catalog_verification_jobs WHERE id = ?")
        .get(id)?.delivery_attempts || 0,
    ),
  );
  const duplicateWake = runWakeMessage(runId);
  const second = await consumeKnowledgeCatalogVerificationMessage(env, duplicateWake.message);

  assert.ok("processedJobs" in second);
  assert.equal(second.processedJobs, 2);
  assert.deepEqual(
    targetIds
      .slice(0, 2)
      .map((id) =>
        Number(
          sqlite
            .prepare(
              "SELECT delivery_attempts FROM knowledge_catalog_verification_jobs WHERE id = ?",
            )
            .get(id)?.delivery_attempts || 0,
        ),
      ),
    attemptsAfterFirst.slice(0, 2),
    "redelivery advances from D1 and never repeats the already-terminal slice",
  );
});
