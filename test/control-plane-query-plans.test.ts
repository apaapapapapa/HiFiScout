import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import {
  dataQualityRemediationActiveQueueMetrics,
  dataQualityRemediationQueueMetrics,
} from "../src/db/data-quality-remediation-queue-repository.js";
import {
  knowledgeCatalogVerificationQueueStatus,
  latestKnowledgeCatalogVerificationRunId,
} from "../src/db/knowledge-catalog-verification-queue-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  assertNoGrowingTableScans,
  assertNoSortBeforeLimit,
  queryPlan,
  readsThroughIndex,
  recordingDatabase,
  selects,
} from "./helpers/query-plan.js";
import type { ExecutedStatement, ScanAllowance } from "./helpers/query-plan.js";

/**
 * What the control plane costs to look at.
 *
 * The work itself is bounded now -- selectors are indexed, claims are limited, sweeps handle a
 * handful of jobs. The queries that report on that work were not. Both of these ran on scheduled
 * paths and aggregated their table's entire retained history to answer a question about the
 * present, so watching the queue cost more than draining it, and the cost grew with every job that
 * had ever finished.
 *
 * These are the same growing tables the remediation plans guard, checked the same way: run the real
 * repository function against the migrated schema, capture what it issued, explain each statement.
 * A future rewrite that reaches for one convenient `CASE` aggregate over the whole table fails here
 * rather than in production.
 */

const AT = "2026-09-03T00:00:00.000Z";

/**
 * `latestKnowledgeCatalogVerificationRunId` walks the rowid backwards and stops at the first row.
 *
 * SQLite calls that a `SCAN`, and it is the one shape where a `LIMIT` genuinely bounds one: the
 * table's own order is the order asked for, so there is nothing to sort and nothing to visit past
 * the first row. The accompanying `assertNoSortBeforeLimit` is what keeps that true -- a `SCAN` that
 * has to sort before it can honour a `LIMIT` reads everything, and this allowance would otherwise
 * excuse it.
 */
const ROWID_TAIL_LOOKUP: ScanAllowance = {
  tables: ["knowledge_catalog_verification_jobs"],
  when: /ORDER BY id DESC\s+LIMIT 1/u,
  reason:
    "reverse rowid walk stopping at the first row; the LIMIT bounds it because nothing sorts first",
};

interface Fixture {
  sqlite: DatabaseSync;
  db: ReturnType<typeof recordingDatabase>["db"];
  executed: ExecutedStatement[];
}

/**
 * A queue whose terminal history dwarfs its outstanding work, which is the steady state both of
 * these report on: a few jobs in flight behind everything that has ever finished.
 */
function fixture(terminalHistory: number, { pending = 2, processing = 1 } = {}): Fixture {
  const { sqlite, db: inner } = migratedSqlite();
  const remediation = sqlite.prepare(`
    INSERT INTO data_quality_remediation_queue
      (work_key, work_type, reason, status, available_at, resolved_at, created_at, updated_at)
    VALUES (?, 'reprocess_listing', 'seed', ?, ?, ?, ?, ?)
  `);
  const reviewRun = sqlite.prepare(
    "INSERT INTO knowledge_catalog_review_runs (started_at, status) VALUES (?, ?)",
  );
  const verificationJob = sqlite.prepare(`
    INSERT INTO knowledge_catalog_verification_jobs
      (run_id, job_key, job_type, status, manufacturer_id, enqueued_at, created_at, updated_at)
    VALUES (?, ?, 'candidate', ?, 'm', ?, ?, ?)
  `);

  reviewRun.run(AT, "success");
  reviewRun.run(AT, "running");
  sqlite.exec("BEGIN");
  for (let i = 0; i < terminalHistory; i += 1) {
    remediation.run(`resolved-${i}`, "resolved", AT, AT, AT, AT);
    verificationJob.run(1, `history-${i}`, "completed", AT, AT, AT);
  }
  for (let i = 0; i < pending; i += 1) {
    remediation.run(`pending-${i}`, "pending", AT, null, AT, AT);
  }
  for (let i = 0; i < processing; i += 1) {
    remediation.run(`processing-${i}`, "processing", AT, null, AT, AT);
  }
  remediation.run("failed-0", "failed", AT, null, AT, AT);
  for (let i = 0; i < 3; i += 1) verificationJob.run(2, `current-${i}`, "queued", AT, AT, AT);
  sqlite.exec("COMMIT");

  const recording = recordingDatabase(inner);
  return { sqlite, db: recording.db, executed: recording.executed };
}

test("the remediation sweep's queue metrics never read terminal history", async () => {
  const { sqlite, db, executed } = fixture(200);

  const metrics = await dataQualityRemediationActiveQueueMetrics(db);

  assert.equal(metrics.pending, 2);
  assert.equal(metrics.processing, 1);
  assert.equal(metrics.backlog, 3);
  assert.equal(metrics.oldestPendingAt, AT);
  assertNoGrowingTableScans(sqlite, executed, { label: "active queue metrics" });
  assertNoSortBeforeLimit(sqlite, executed, "active queue metrics");

  // Each status through its own partial index. That is the cardinality guarantee: a partial index on
  // `status = 'pending'` holds exactly the pending rows, so what the statement visits is the backlog
  // and cannot be anything else.
  const statements = selects(executed);
  assert.equal(statements.length, 2, "one statement per outstanding status");
  const indexes = ["idx_dq_remediation_queue_pending", "idx_dq_remediation_queue_processing"];
  for (const index of indexes) {
    assert.ok(
      statements.some((statement) =>
        readsThroughIndex(queryPlan(sqlite, statement), "data_quality_remediation_queue", index),
      ),
      `no statement walked ${index}; plans were:\n${statements
        .map((statement) =>
          queryPlan(sqlite, statement)
            .map((step) => step.detail)
            .join(" | "),
        )
        .join("\n")}`,
    );
  }
  for (const statement of statements) {
    assert.ok(
      !/\bstatus IN \(/u.test(statement.sql),
      `an OR across statuses cannot use either partial index:\n${statement.sql.trim()}`,
    );
  }
});

test("the admin lifetime audit reads its counts through indexes, not the table", async () => {
  // Counting retained `resolved` rows is proportional to them by definition -- that is what an exact
  // lifetime total is. What it must not do is read the table, and it must not be on a scheduled
  // path; this is the admin data-quality endpoint.
  const { sqlite, db, executed } = fixture(200);

  const metrics = await dataQualityRemediationQueueMetrics(db);

  assert.equal(metrics.resolved, 200);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.backlog, 3);
  assertNoGrowingTableScans(sqlite, executed, { label: "lifetime audit" });
  assert.equal(selects(executed).length, 4, "one statement per status");
  const plans = selects(executed).map((statement) => queryPlan(sqlite, statement));
  for (const index of ["idx_dq_remediation_queue_resolved", "idx_dq_remediation_queue_failed"]) {
    assert.ok(
      plans.some((plan) => readsThroughIndex(plan, "data_quality_remediation_queue", index)),
      `the terminal counts must walk ${index} rather than the table`,
    );
  }
});

test("the scheduler's verification-queue question costs one row", async () => {
  const { sqlite, db, executed } = fixture(200);

  const runId = await latestKnowledgeCatalogVerificationRunId(db);

  assert.equal(runId, 2, "the run the most recent job belongs to");
  assert.equal(selects(executed).length, 1);
  assertNoGrowingTableScans(sqlite, executed, {
    label: "latest verification run id",
    allowances: [ROWID_TAIL_LOOKUP],
  });
  assertNoSortBeforeLimit(sqlite, executed, "latest verification run id");
});

test("verification queue status is scoped to the run in progress", async () => {
  const { sqlite, db, executed } = fixture(200);

  const status = await knowledgeCatalogVerificationQueueStatus(db);

  // The current run's three queued jobs, not the two hundred completed ones behind them.
  assert.equal(status.latestRunId, 2);
  assert.equal(status.queued, 3);
  assert.equal(status.processing, 0);
  assert.equal(status.retrying, 0);
  assert.equal(status.deadLetter, 0);
  assert.equal(status.oldestPendingAt, AT);
  assert.equal(status.latestRun?.targetJobs, 3);

  assertNoGrowingTableScans(sqlite, executed, {
    label: "verification queue status",
    allowances: [ROWID_TAIL_LOOKUP],
  });
  assertNoSortBeforeLimit(sqlite, executed, "verification queue status");
  const scoped = selects(executed).filter((statement) =>
    /COUNT\(\*\) AS target_jobs/u.test(statement.sql),
  );
  assert.equal(scoped.length, 1, "the counters come from one run-scoped aggregate");
  // A seek on `run_id`, which is the bound that matters: what it visits is this run's jobs. It is
  // not a *covering* read, because the backlog age reads `enqueued_at` and no run index carries it.
  // That costs a row lookup per job in the current run and buys one statement instead of two --
  // worth it only because the set is the run rather than the history.
  assert.ok(
    readsThroughIndex(
      queryPlan(sqlite, scoped[0]!),
      "knowledge_catalog_verification_jobs",
      "idx_knowledge_catalog_verification_jobs_run_claim",
    ),
    `the run-scoped aggregate must seek on run_id, got:\n${queryPlan(sqlite, scoped[0]!)
      .map((step) => step.detail)
      .join("\n")}`,
  );
});

test("a status with no run at all reports empty rather than failing", async () => {
  const { sqlite, db, executed } = fixture(0, { pending: 0, processing: 0 });
  sqlite.exec("DELETE FROM knowledge_catalog_verification_jobs");

  const status = await knowledgeCatalogVerificationQueueStatus(db);

  assert.equal(status.latestRunId, null);
  assert.equal(status.latestRun, null);
  assert.equal(status.queued, 0);
  assert.equal(status.oldestPendingAt, null);
  assertNoGrowingTableScans(sqlite, executed, {
    label: "empty verification queue",
    allowances: [ROWID_TAIL_LOOKUP],
  });
});

test("an empty remediation queue reports zero without a scan", async () => {
  const { sqlite, db, executed } = fixture(0, { pending: 0, processing: 0 });
  sqlite.exec("DELETE FROM data_quality_remediation_queue");

  const metrics = await dataQualityRemediationActiveQueueMetrics(db);

  assert.equal(metrics.pending, 0);
  assert.equal(metrics.processing, 0);
  assert.equal(metrics.backlog, 0);
  assert.equal(metrics.oldestPendingAt, null);
  assertNoGrowingTableScans(sqlite, executed, { label: "empty queue" });
});

test("a processing lease and a failed job do not disturb the backlog age", async () => {
  const { sqlite, db } = fixture(50, { pending: 0, processing: 2 });
  sqlite
    .prepare(
      `UPDATE data_quality_remediation_queue SET created_at = ?
       WHERE work_key = 'processing-1'`,
    )
    .run("2026-09-01T00:00:00.000Z");

  const metrics = await dataQualityRemediationActiveQueueMetrics(db);

  assert.equal(metrics.pending, 0);
  assert.equal(metrics.processing, 2);
  assert.equal(
    metrics.oldestPendingAt,
    "2026-09-01T00:00:00.000Z",
    "a claimed job is still outstanding work, and the older of the two states wins",
  );
});

/**
 * The cardinality property, measured rather than argued.
 *
 * The query-plan assertions above prove *which* index each statement walks, and a partial index on
 * one status holds exactly that status's rows -- which is the real guarantee. This adds the
 * end-to-end check the plan cannot give: run the same function against two databases whose terminal
 * history differs by 10x and compare.
 *
 * The local SQLite double reports no `rows_read`, so time is the observable. It is self-calibrating
 * -- both measurements come from the same process, so machine speed cancels -- and the bound is
 * deliberately loose: the implementation this replaced grew about 10x across this step, so 4x fails
 * a genuine regression to a full scan while leaving room for a noisy runner.
 */
async function medianMs(run: () => Promise<unknown>, iterations = 21): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    await run();
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

test("hot-path control-plane reads do not grow with terminal history", async () => {
  const small = fixture(1_000);
  const large = fixture(10_000);

  const remediationSmall = await medianMs(() => dataQualityRemediationActiveQueueMetrics(small.db));
  const remediationLarge = await medianMs(() => dataQualityRemediationActiveQueueMetrics(large.db));
  const verificationSmall = await medianMs(() => latestKnowledgeCatalogVerificationRunId(small.db));
  const verificationLarge = await medianMs(() => latestKnowledgeCatalogVerificationRunId(large.db));

  // A floor keeps a sub-microsecond measurement from turning scheduler jitter into a ratio.
  const ratio = (large: number, small: number) => large / Math.max(small, 0.005);
  assert.ok(
    ratio(remediationLarge, remediationSmall) < 4,
    `remediation metrics grew with history: ${remediationSmall}ms at 1k, ${remediationLarge}ms at 10k`,
  );
  assert.ok(
    ratio(verificationLarge, verificationSmall) < 4,
    `verification lookup grew with history: ${verificationSmall}ms at 1k, ${verificationLarge}ms at 10k`,
  );

  // Statement counts are exact, so they are asserted as equality rather than as a ratio.
  assert.equal(selects(small.executed).length, selects(large.executed).length);
});
