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
import { recordingDatabase } from "./helpers/query-plan.js";
import type { ExecutedStatement } from "./helpers/query-plan.js";
import type { KnowledgeSourceVerifier } from "../src/catalog/knowledge-verification/types.js";
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

/** A run whose targets are real pending candidates on one manufacturer domain. */
async function createCandidateRun(targets: number) {
  const run = createRun();
  const insertCandidate = run.sqlite.prepare(`
    INSERT INTO knowledge_catalog_candidates
      (id, manufacturer_id, normalized_model, last_reviewed_at, created_at, updated_at)
    VALUES (?, 'luxman', ?, ?, ?, ?)`);
  const jobs: KnowledgeCatalogVerificationJobSpec[] = [];
  for (let targetId = 1; targetId <= targets; targetId += 1) {
    insertCandidate.run(targetId, `L${targetId}`, STARTED_AT, STARTED_AT, STARTED_AT);
    jobs.push({
      jobKey: `knowledge-catalog:${run.runId}:candidate:${targetId}`,
      jobType: "candidate",
      targetId,
      manufacturerId: "luxman",
      hostname: "www.luxman.co.jp",
      payloadJson: JSON.stringify({
        mode: "daily_candidates",
        preferRetries: false,
        verifierVersion: 0,
        target: {
          id: targetId,
          manufacturerId: "luxman",
          normalizedModel: `L${targetId}`,
          observedManufacturer: "LUXMAN",
          observedModel: `L-${targetId}`,
        },
      } satisfies KnowledgeCatalogJobPayload),
    });
  }
  jobs.push({
    jobKey: `knowledge-catalog:${run.runId}:finalize`,
    jobType: "finalize",
    targetId: null,
    manufacturerId: "",
    hostname: "",
    payloadJson: payload(),
  });
  await createKnowledgeCatalogVerificationJobs(run.db, run.runId, jobs, STARTED_AT);
  return run;
}

function notFoundVerifier() {
  const verification = {
    status: "not_found",
    sourceUrl: "",
    sourceType: "manufacturer_official",
    httpStatus: 404,
    message: "not listed",
  };
  return {
    async verifyCandidate() {
      return verification;
    },
    async verifyStoredSource() {
      return verification;
    },
    definitions: new Map(),
  } as unknown as KnowledgeSourceVerifier;
}

/**
 * The run reads a wake issues, in order: claims, the wait after an empty claim (the run's next
 * availability alone) and the slice summary (the exact outstanding count, with or without it).
 */
function runReads(executed: readonly ExecutedStatement[]): string[] {
  return executed.flatMap(({ sql }) => {
    if (sql.includes("ORDER BY CASE WHEN job.job_type = 'finalize'")) return ["claim"];
    if (sql.includes("AS outstanding_jobs") && sql.includes("AS next_available_at")) {
      return ["wake-state"];
    }
    if (sql.includes("AS outstanding_jobs")) return ["outstanding-count"];
    if (sql.includes("AS next_available_at")) return ["next-available"];
    return [];
  });
}

test("a paced domain is waited out inside one wake without counting the run", async () => {
  const { db, runId } = await createCandidateRun(3);
  const recording = recordingDatabase(db);
  const queue = queueBinding();
  const env = queueEnv(recording.db, queue.binding, {
    KNOWLEDGE_CATALOG_QUEUE_WAKE_MAX_JOBS: "2",
    KNOWLEDGE_CATALOG_SOURCE_REQUEST_DELAY_MS: "300",
  });

  const result = await consumeKnowledgeCatalogVerificationMessage(
    env,
    runWakeMessage(runId).message,
    { createVerifier: notFoundVerifier },
  );

  assert.equal(result.status, "continued");
  assert.ok("processedJobs" in result && "outstandingJobs" in result);
  assert.equal(result.processedJobs, 2);
  assert.equal(result.outstandingJobs, 2, "one target and the finalizer remain");
  // The second claim meets the domain's pacing gap. The wait reads only when that gap ends; the
  // exact count, one index entry per live job, is read once for the slice summary.
  assert.deepEqual(runReads(recording.executed), [
    "claim",
    "claim",
    "next-available",
    "claim",
    "wake-state",
  ]);
  assert.deepEqual(
    queue.sent.map((sent) => sent.options?.delaySeconds),
    [1],
  );
});

test("a slice that ends waiting for a retry counts the run once", async () => {
  const { sqlite, db, runId } = await createCandidateRun(1);
  sqlite
    .prepare(`UPDATE knowledge_catalog_verification_jobs SET status = 'retrying', available_at = ?
      WHERE job_type = 'candidate'`)
    .run(new Date(Date.now() + 600_000).toISOString());
  const recording = recordingDatabase(db);
  const queue = queueBinding();

  const result = await consumeKnowledgeCatalogVerificationMessage(
    queueEnv(recording.db, queue.binding),
    runWakeMessage(runId).message,
    { createVerifier: notFoundVerifier },
  );

  assert.equal(result.status, "continued");
  assert.ok("outstandingJobs" in result);
  assert.equal(result.outstandingJobs, 2);
  assert.deepEqual(runReads(recording.executed), ["claim", "next-available", "outstanding-count"]);
  const delay = Number(queue.sent[0]?.options?.delaySeconds);
  assert.ok(delay > 590 && delay <= 600, `wakes when the retry is due, not before: ${delay}`);
});

test("a wake that finds its run drained settles on an empty outstanding count", async () => {
  const { sqlite, db, runId } = await createCandidateRun(1);
  sqlite.prepare("UPDATE knowledge_catalog_verification_jobs SET status = 'completed'").run();
  const recording = recordingDatabase(db);
  const queue = queueBinding();

  const result = await consumeKnowledgeCatalogVerificationMessage(
    queueEnv(recording.db, queue.binding),
    runWakeMessage(runId).message,
    { createVerifier: notFoundVerifier },
  );

  assert.equal(result.status, "settled");
  assert.ok("outstandingJobs" in result);
  assert.equal(result.outstandingJobs, 0);
  assert.deepEqual(runReads(recording.executed), ["claim", "next-available", "outstanding-count"]);
  assert.equal(queue.sent.length, 0);
});
