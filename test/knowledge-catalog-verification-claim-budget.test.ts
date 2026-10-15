import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { recordCostSample } from "../scripts/harness/cost.js";
import {
  claimNextKnowledgeCatalogVerificationJobForRun,
  knowledgeCatalogVerificationRunWakeState,
} from "../src/db/knowledge-catalog-verification-queue-repository.js";
import { database, AT } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";

const NOW = "2026-09-06T00:00:00.000Z";

test("claiming a verification job stays bounded as the run's finished jobs grow", async () => {
  const { db, dispose } = await database();
  const fixture = ["test/knowledge-catalog-verification-claim-budget.test.ts"];
  const insertJobs = (runId: number, prefix: string, from: number, to: number, status: string) =>
    db
      .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < ?)
        INSERT INTO knowledge_catalog_verification_jobs(run_id,job_key,job_type,target_id,hostname,
          status,enqueued_at,created_at,updated_at)
        SELECT ?,?||i,'candidate',i,'source-'||(i%7)||'.test',?,?,?,? FROM n`)
      .bind(from, to, runId, prefix, status, AT, AT, AT)
      .run();
  try {
    await db
      .prepare(`INSERT INTO knowledge_catalog_review_runs(id,started_at,status)
        VALUES (1,?,'success'),(2,?,'running')`)
      .bind(AT, AT)
      .run();
    // An earlier run's history and the current run's live targets plus its hidden finalizer.
    await insertJobs(1, "history-", 1, 2000, "completed");
    await insertJobs(2, "live-", 1, 5, "queued");
    await db
      .prepare(`INSERT INTO knowledge_catalog_verification_jobs(run_id,job_key,job_type,status,
          enqueued_at,created_at,updated_at) VALUES (2,'finalize-2','finalize','queued',?,?,?)`)
      .bind(AT, AT, AT)
      .run();

    let previous = 0;
    const costs: string[] = [];
    for (const size of [100, 1000, 10000]) {
      // Finished targets accumulate as a run drains; each claim used to re-read all of them.
      await insertJobs(2, "done-", previous + 1, size, "completed");
      previous = size;

      const boundary = measureD1Cost(db);
      const claimed = await claimNextKnowledgeCatalogVerificationJobForRun(boundary.db, 2, NOW, 60);
      const wake = await knowledgeCatalogVerificationRunWakeState(boundary.db, 2, NOW);
      const cost = boundary.metrics();
      await recordCostSample(`catalog-verification-claim-${size}`, "local-workerd", cost, fixture, [
        `Claim plus wake state with ${size} finished jobs in the run and 2,000 in an older run.`,
      ]);
      assert.equal(claimed?.jobType, "candidate", "the finalizer stays hidden behind live targets");
      assert.equal(claimed?.status, "processing");
      assert.deepEqual(wake, { outstandingJobs: 6, nextAvailableAt: NOW });
      assert.equal(cost.rowsWritten !== null && cost.rowsWritten <= 10, true, JSON.stringify(cost));
      assert.equal(cost.sqlStatements, 4);
      assert.ok(cost.rowsRead !== null && cost.rowsRead <= 100, JSON.stringify(cost));
      costs.push(JSON.stringify(cost));
      console.log(JSON.stringify({ sample: `catalog-verification-claim-${size}`, ...cost }));

      // Return the claimed target so every size measures the same live set (setup, not measured).
      await db
        .prepare(`UPDATE knowledge_catalog_verification_jobs
          SET status='queued', delivery_attempts=0, claimed_at=NULL, lease_expires_at=NULL
          WHERE run_id=2 AND status='processing'`)
        .run();
    }
    assert.equal(new Set(costs).size, 1, `cost must not grow with finished jobs: ${costs}`);
  } finally {
    await dispose();
  }
}, 60_000);
