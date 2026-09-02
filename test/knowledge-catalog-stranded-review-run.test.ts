import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { knowledgeCatalogReviewRunLiveness } from "../src/db/knowledge-catalog-verification-queue-repository.js";
import { bootstrapKnowledgeCatalogReview } from "../src/scheduled.js";
import { queueDatabase } from "./helpers/knowledge-queue.js";

const NOW = new Date("2026-09-02T00:00:00.000Z");
const LONG_AGO = "2026-09-01T16:44:20.627Z";
const JUST_NOW = "2026-09-01T23:55:00.000Z";

/**
 * The scheduler reads the verifier claim, the verifier state, the queue status and the latest
 * review before it decides anything, so every case has to answer all four the same way: the version
 * is already claimed and the latest review is `running`.
 */
function scheduler(liveness: { live_jobs: number; total_jobs: number; last_activity_at: string }) {
  const db = queueDatabase((sql) => {
    if (sql.includes("INSERT OR IGNORE INTO knowledge_catalog_verifier_state")) {
      return { changes: 0 };
    }
    // The successor claim loses, which stops the case short of a full queue dispatch. What this
    // fixture is for is whether the claim is reached at all, not what dispatch then does with it.
    if (sql.includes("INSERT INTO knowledge_catalog_review_runs")) return { changes: 0 };
    if (sql.includes("live_jobs")) return { row: liveness };
    if (sql.includes("FROM knowledge_catalog_verifier_state")) {
      return { row: { version: 5, status: "success" } };
    }
    if (sql.includes("SELECT id, status, message")) {
      return { row: { id: 39, status: "running", message: "queue dispatch started" } };
    }
    return {};
  });
  return { db, env: { DB: db } as unknown as Env };
}

test("review run liveness counts the finalizer, not only the target jobs", async () => {
  const db = queueDatabase(() => ({
    row: { live_jobs: 0, total_jobs: 201, last_activity_at: LONG_AGO },
  }));

  const liveness = await knowledgeCatalogReviewRunLiveness(db, 39);

  assert.deepEqual(liveness, { liveJobs: 0, totalJobs: 201, lastActivityAt: LONG_AGO });
  const [statement] = db.ran("live_jobs");
  assert.ok(
    !statement.sql.includes("job_type <> 'finalize'"),
    "a dead finalizer is exactly the job this query exists to notice",
  );
  assert.deepEqual(statement.binds, [39]);
});

test("a running review run still holding live jobs is left to finish", async () => {
  const { db, env } = scheduler({ live_jobs: 3, total_jobs: 201, last_activity_at: JUST_NOW });

  const result = await bootstrapKnowledgeCatalogReview(env, NOW);

  assert.deepEqual(result, { status: "skipped", reason: "knowledge_catalog_review_in_progress" });
  assert.deepEqual(db.ran("SET finished_at = ?, status = 'failed'"), []);
});

test("a running review run whose jobs just went terminal is not failed yet", async () => {
  const { db, env } = scheduler({ live_jobs: 0, total_jobs: 201, last_activity_at: JUST_NOW });

  const result = await bootstrapKnowledgeCatalogReview(env, NOW);

  assert.deepEqual(result, { status: "skipped", reason: "knowledge_catalog_review_in_progress" });
  assert.deepEqual(
    db.ran("SET finished_at = ?, status = 'failed'"),
    [],
    "a finalizer between states must never be failed out from under itself",
  );
});

test("a running review run nothing can finish is failed and recovered in one tick", async () => {
  const { db, env } = scheduler({ live_jobs: 0, total_jobs: 201, last_activity_at: LONG_AGO });

  const result = await bootstrapKnowledgeCatalogReview(env, NOW);

  const [failure] = db.ran("SET finished_at = ?, status = 'failed'");
  assert.ok(failure, "the stranded run is what blocks every later tick");
  assert.deepEqual(failure.binds, [
    NOW.toISOString(),
    "knowledge_catalog_review_run_stranded_without_live_jobs",
    39,
  ]);
  // The bootstrap is hourly. Failing the run and then waiting for the next tick to recover it
  // would cost the catalog a second idle hour it does not need.
  const [recovery] = db.ran("INSERT INTO knowledge_catalog_review_runs");
  assert.ok(recovery, "the successor run is claimed in the same tick that failed the stranded one");
  assert.deepEqual(recovery.binds.slice(-2), [39, 39]);
  assert.deepEqual(result, {
    status: "skipped",
    reason: "knowledge_catalog_recovery_already_claimed",
  });
});

test("a running review run that has not created its jobs yet is still dispatching", async () => {
  const { db, env } = scheduler({ live_jobs: 0, total_jobs: 0, last_activity_at: "" });

  const result = await bootstrapKnowledgeCatalogReview(env, NOW);

  assert.deepEqual(result, { status: "skipped", reason: "knowledge_catalog_review_in_progress" });
  assert.deepEqual(db.ran("SET finished_at = ?, status = 'failed'"), []);
});
