import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  claimKnowledgeCatalogVerificationJob,
  claimNextKnowledgeCatalogVerificationJobForRun,
  createKnowledgeCatalogVerificationJobs,
} from "../src/db/knowledge-catalog-verification-queue-repository.js";
import {
  consumeKnowledgeCatalogVerificationBatch,
  consumeKnowledgeCatalogVerificationMessage,
} from "../src/knowledge-catalog/consumer.js";
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

test("source requests share an invocation budget and interrupted candidates are not published", async () => {
  const { sqlite, db, runId } = await createCandidateRun(8);
  let requests = 0;
  const rawFetch: typeof fetch = async () => {
    requests += 1;
    if (requests > 50) throw new Error("Too many subrequests by single Worker invocation");
    return new Response("", { status: 404 });
  };
  const { createVerifier } = await import("../src/knowledge-catalog/verifier.js");
  const queue = queueBinding();
  const env = queueEnv(db, queue.binding, { KNOWLEDGE_CATALOG_SOURCE_REQUEST_DELAY_MS: "0" });
  const result = await consumeKnowledgeCatalogVerificationMessage(
    env,
    runWakeMessage(runId).message,
    {
      fetchImpl: rawFetch,
      createVerifier: (settings, transport = rawFetch) => createVerifier(settings, transport),
    },
  );
  assert.ok(requests <= 40, `one invocation issued ${requests} raw requests`);
  assert.equal(result.status, "continued");
  const interrupted = sqlite
    .prepare(
      "SELECT target_id FROM knowledge_catalog_verification_jobs WHERE status = 'retrying' LIMIT 1",
    )
    .get();
  assert.ok(interrupted, "the incomplete target must be retried, not completed/not_found");
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM knowledge_catalog_verification_attempts WHERE candidate_id = ?",
      )
      .get(interrupted.target_id)?.n,
    0,
  );
  assert.equal(
    sqlite
      .prepare("SELECT verification_status FROM knowledge_catalog_candidates WHERE id = ?")
      .get(interrupted.target_id)?.verification_status,
    "unverified",
  );
  assert.equal(queue.sent.length, 1);
  // The next invocation gets a fresh budget; durable terminal jobs must not be fetched again.
  sqlite
    .prepare(
      "UPDATE knowledge_catalog_verification_jobs SET available_at = ? WHERE status = 'retrying'",
    )
    .run(STARTED_AT);
  requests = 0;
  await consumeKnowledgeCatalogVerificationMessage(env, runWakeMessage(runId).message, {
    fetchImpl: rawFetch,
    createVerifier: (settings, transport = rawFetch) => createVerifier(settings, transport),
  });
  assert.ok(requests <= 40);
  assert.equal(
    sqlite
      .prepare("SELECT status FROM knowledge_catalog_verification_jobs WHERE target_id = ?")
      .get(interrupted.target_id)?.status,
    "completed",
  );
});

test("a whole Queue batch shares the raw-fetch budget, including robots and redirects", async () => {
  const { sqlite, db, runId } = await createCandidateRun(12);
  const messages = [runWakeMessage(runId), runWakeMessage(runId)];
  let requests = 0;
  let robots = 0;
  let redirects = 0;
  const rawFetch: typeof fetch = async (input, init) => {
    requests += 1;
    assert.equal(init?.redirect, "manual");
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") {
      robots += 1;
      return new Response("", { status: 404 });
    }
    if (!url.search) {
      redirects += 1;
      return new Response(null, { status: 302, headers: { location: `${url}?redirected=1` } });
    }
    return new Response("", { status: 404 });
  };
  await consumeKnowledgeCatalogVerificationBatch(
    queueEnv(db, undefined, {
      KNOWLEDGE_CATALOG_SOURCE_REQUEST_DELAY_MS: "0",
    }),
    { messages: messages.map((m) => m.message) } as unknown as MessageBatch<never>,
    { fetchImpl: rawFetch },
  );
  assert.equal(requests, 40);
  assert.ok(robots > 0 && redirects > 0);
  assert.deepEqual(messages[1].retries, [{ delaySeconds: 1 }]);
  assert.equal(messages[1].acks.length, 0);
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM knowledge_catalog_verification_jobs WHERE status = 'completed' AND outcome = 'error'",
      )
      .get()?.n,
    0,
  );
});

test("an oversized single target is bounded by delivery retries without publishing a false answer", async () => {
  const { sqlite, db, runId } = await createCandidateRun(1);
  const env = queueEnv(db, undefined, {
    KNOWLEDGE_CATALOG_SOURCE_REQUEST_DELAY_MS: "0",
    KNOWLEDGE_CATALOG_QUEUE_TRANSIENT_MAX_ATTEMPTS: "1",
  });
  let requests = 0;
  const options = {
    fetchImpl: (async () => {
      requests += 1;
      return new Response("", { status: 404 });
    }) as typeof fetch,
    createVerifier: (_env: unknown, transport = globalThis.fetch): KnowledgeSourceVerifier => ({
      definitions: new Map(),
      async verifyCandidate() {
        // Simulate a strategy which discards transport failures and returns its placeholder.
        for (let i = 0; i < 45; i += 1) await transport("https://example.test/").catch(() => null);
        return {
          status: "not_found",
          sourceUrl: "",
          sourceType: "manufacturer_official",
          httpStatus: null,
          message: "placeholder",
        };
      },
      verifyStoredSource: async () => {
        throw new Error("unexpected recheck");
      },
    }),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    requests = 0;
    await consumeKnowledgeCatalogVerificationMessage(env, runWakeMessage(runId).message, options);
    assert.equal(requests, 40);
    sqlite
      .prepare(
        "UPDATE knowledge_catalog_verification_jobs SET available_at = ? WHERE status = 'retrying'",
      )
      .run(STARTED_AT);
  }
  assert.equal(
    sqlite
      .prepare(
        "SELECT status FROM knowledge_catalog_verification_jobs WHERE job_type = 'candidate'",
      )
      .get()?.status,
    "dead_letter",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_verification_attempts").get()?.n,
    0,
  );
  assert.equal(
    sqlite
      .prepare("SELECT verification_status FROM knowledge_catalog_candidates WHERE id = 1")
      .get()?.verification_status,
    "unverified",
  );
});
