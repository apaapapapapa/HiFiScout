import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { recordCostSample } from "../scripts/harness/cost.js";
import {
  claimNextKnowledgeCatalogVerificationJobForRun,
  knowledgeCatalogVerificationRunNextAvailableAt,
  knowledgeCatalogVerificationRunWakeState,
} from "../src/db/knowledge-catalog-verification-queue-repository.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { database, AT } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import { fullScans, readsThroughIndex, recordingDatabase, selects } from "./helpers/query-plan.js";
import type { ExecutedStatement, PlanStep } from "./helpers/query-plan.js";

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

const EXPIRED = "2026-09-05T23:59:59.000Z";
const PACED_UNTIL = "2026-09-06T00:00:00.500Z";
const INTERLEAVED_HOST = "'host-'||printf('%02d', i % 15)||'.test'";
const INTERLEAVED_HOSTS = Array.from(
  { length: 15 },
  (_, index) => `host-${String(index).padStart(2, "0")}.test`,
);

/**
 * A live run's waiting targets, shaped as the consumer meets them. `hostname`, `status` and
 * `availableAt` are SQL expressions of the target's index `i`, and `id` keeps dispatch's priority
 * order.
 */
interface LiveRunShape {
  name: string;
  description: string;
  hostname: string;
  status: string;
  availableAt: string;
  /** Domains the run has used before; a lease row outlives its pacing gap. */
  hosts: string[];
  /** Domains with a due target, paced after the claim so that the next claim is empty. */
  paced: string[];
  claimed: { hostname: string; targetId: number };
}

const LIVE_RUN_SHAPES: LiveRunShape[] = [
  {
    name: "interleaved",
    description: "spread evenly over 15 domains",
    hostname: INTERLEAVED_HOST,
    status: "'queued'",
    availableAt: `'${AT}'`,
    hosts: INTERLEAVED_HOSTS,
    paced: INTERLEAVED_HOSTS,
    claimed: { hostname: "host-01.test", targetId: 1 },
  },
  {
    name: "dominant",
    description: "nine in ten on one paced domain",
    hostname: "CASE WHEN i % 10 = 0 THEN 'minor-'||(i%3)||'.test' ELSE 'dominant.test' END",
    status: "'queued'",
    availableAt: `'${AT}'`,
    hosts: ["dominant.test", "minor-0.test", "minor-1.test", "minor-2.test"],
    paced: ["minor-0.test", "minor-1.test", "minor-2.test"],
    claimed: { hostname: "minor-1.test", targetId: 10 },
  },
  {
    name: "backoff",
    description: "over 15 domains, nine in ten waiting out a transient-failure backoff",
    hostname: INTERLEAVED_HOST,
    status: "CASE WHEN i % 10 = 0 THEN 'queued' ELSE 'retrying' END",
    availableAt: `CASE WHEN i % 10 = 0 THEN '${AT}'
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', '${NOW}', '+'||(60 + i)||' seconds') END`,
    hosts: INTERLEAVED_HOSTS,
    // Only these domains hold a due target; every other one waits for a retry.
    paced: ["host-00.test", "host-05.test", "host-10.test"],
    claimed: { hostname: "host-10.test", targetId: 10 },
  },
];

/** Only the run's short per-domain candidate list may be sorted, never its live jobs. */
async function assertSeeksWaitingDomains(db: QueryableDatabase, statement: ExecutedStatement) {
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .bind(...statement.binds)
    .all<PlanStep>();
  const steps = plan.results || [];
  const detail = steps.map((step) => step.detail).join("\n");
  assert.ok(
    readsThroughIndex(
      steps,
      "knowledge_catalog_verification_jobs",
      "idx_knowledge_catalog_verification_jobs_run_host_waiting",
    ),
    `the run's domains must be enumerated through the waiting-job index:\n${detail}`,
  );
  assert.deepEqual(fullScans(steps, ["run_hosts", "candidate"]), [], detail);
  const sorts = steps.filter((step) => /USE TEMP B-TREE/.test(step.detail));
  assert.ok(sorts.length <= 1, detail);
  if (sorts.length) {
    assert.match(detail, /\nSCAN candidate\n/, `only the candidate list may be sorted:\n${detail}`);
  }
}

for (const shape of LIVE_RUN_SHAPES) {
  test(`claims and waits stay bounded as a ${shape.name} run's live jobs grow`, async () => {
    const { db, dispose } = await database();
    const fixture = ["test/knowledge-catalog-verification-claim-budget.test.ts"];
    const pace = (hostnames: string[], leasedUntil: string) =>
      db.batch(
        hostnames.map((hostname) =>
          db
            .prepare(`UPDATE knowledge_catalog_verification_domain_leases
              SET job_id = 0, leased_until = ? WHERE hostname = ?`)
            .bind(leasedUntil, hostname),
        ),
      );
    try {
      await db
        .prepare(`INSERT INTO knowledge_catalog_review_runs(id,started_at,status)
          VALUES (1,?,'success'),(2,?,'running')`)
        .bind(AT, AT)
        .run();
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 2000)
          INSERT INTO knowledge_catalog_verification_jobs(run_id,job_key,job_type,target_id,hostname,
            status,enqueued_at,available_at,created_at,updated_at)
          SELECT 1,'history-'||i,'candidate',i,${shape.hostname},'completed',?,NULL,?,? FROM n`)
        .bind(AT, AT, AT)
        .run();
      await db
        .prepare(`INSERT INTO knowledge_catalog_verification_jobs(run_id,job_key,job_type,status,
            enqueued_at,available_at,created_at,updated_at)
          VALUES (2,'finalize-2','finalize','queued',?,?,?,?)`)
        .bind(AT, AT, AT, AT)
        .run();
      await db.batch(
        shape.hosts.map((hostname) =>
          db
            .prepare(`INSERT INTO knowledge_catalog_verification_domain_leases(hostname,job_id,
                leased_until,updated_at) VALUES (?,0,?,?)`)
            .bind(hostname, EXPIRED, AT),
        ),
      );
      // Pacing holds a skewed run's dominant domain between requests, as it does for most claims.
      if (shape.name === "dominant") await pace(["dominant.test"], PACED_UNTIL);

      let previous = 0;
      const costs: string[] = [];
      for (const size of [50, 200, 800]) {
        await db
          .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < ?)
            INSERT INTO knowledge_catalog_verification_jobs(run_id,job_key,job_type,target_id,hostname,
              status,enqueued_at,available_at,created_at,updated_at)
            SELECT 2,'live-'||i,'candidate',i,${shape.hostname},${shape.status},?,${shape.availableAt},
              ?,? FROM n`)
          .bind(previous + 1, size, AT, AT, AT)
          .run();
        previous = size;

        const sample = `catalog-verification-live-claim-${shape.name}-${size}`;
        const boundary = measureD1Cost(db);
        const recorded = recordingDatabase(boundary.db);
        const claimed = await claimNextKnowledgeCatalogVerificationJobForRun(
          recorded.db,
          2,
          NOW,
          60,
        );
        // Every domain with a due job is now paced: the next claim is empty and the consumer asks
        // when to try again, which is what most production claims and wake-state reads were.
        await pace(shape.paced, PACED_UNTIL);
        const empty = await claimNextKnowledgeCatalogVerificationJobForRun(recorded.db, 2, NOW, 60);
        const next = await knowledgeCatalogVerificationRunNextAvailableAt(recorded.db, 2, NOW);
        const cost = boundary.metrics();
        await recordCostSample(sample, "local-workerd", cost, fixture, [
          `A claim, an empty claim and its wait with ${size} live jobs ${shape.description}.`,
        ]);
        console.log(JSON.stringify({ sample, ...cost }));
        assert.equal(
          claimed?.hostname,
          shape.claimed.hostname,
          "the earliest job of a free domain",
        );
        assert.equal(claimed?.targetId, shape.claimed.targetId);
        assert.equal(empty, null, "every domain with a due job is paced");
        assert.equal(next, PACED_UNTIL);
        assert.equal(cost.sqlStatements, 5);
        assert.equal(
          cost.rowsWritten !== null && cost.rowsWritten <= 10,
          true,
          JSON.stringify(cost),
        );
        costs.push(JSON.stringify(cost));
        const selectors = selects(recorded.executed).filter((statement) =>
          statement.sql.includes("WITH RECURSIVE"),
        );
        assert.equal(selectors.length, 3, "two claim selections and one wait");
        for (const statement of selectors) await assertSeeksWaitingDomains(db, statement);

        // The once-per-invocation summary still reports the exact outstanding count: one index
        // entry per live job, and nothing per finished one.
        const summary = measureD1Cost(db);
        assert.deepEqual(await knowledgeCatalogVerificationRunWakeState(summary.db, 2, NOW), {
          outstandingJobs: size + 1,
          nextAvailableAt: PACED_UNTIL,
        });
        const summaryRows = summary.metrics().rowsRead;
        assert.ok(summaryRows !== null && summaryRows <= size + 120, `${size}: ${summaryRows}`);

        // Return the claimed target and lift the pacing (setup, not measured).
        await db
          .prepare(`UPDATE knowledge_catalog_verification_jobs
            SET status='queued', delivery_attempts=0, claimed_at=NULL, lease_expires_at=NULL
            WHERE run_id=2 AND status='processing'`)
          .run();
        await pace(shape.paced, EXPIRED);
      }
      assert.equal(new Set(costs).size, 1, `cost must not grow with live jobs: ${costs}`);
    } finally {
      await dispose();
    }
  }, 60_000);
}

test("claims and waits cost a few index reads per waiting domain", async () => {
  const { db, dispose } = await database();
  const fixture = ["test/knowledge-catalog-verification-claim-budget.test.ts"];
  const host = (index: number) => `spread-${String(index).padStart(2, "0")}.test`;
  const pace = (count: number, leasedUntil: string) =>
    db
      .prepare(`UPDATE knowledge_catalog_verification_domain_leases
        SET job_id = 0, leased_until = ? WHERE hostname < ?`)
      .bind(leasedUntil, host(count));
  try {
    await db
      .prepare(`INSERT INTO knowledge_catalog_review_runs(id,started_at,status)
        VALUES (1,?,'success'),(2,?,'running')`)
      .bind(AT, AT)
      .run();
    await db
      .prepare(`INSERT INTO knowledge_catalog_verification_jobs(run_id,job_key,job_type,status,
          enqueued_at,available_at,created_at,updated_at)
        VALUES (2,'finalize-2','finalize','queued',?,?,?,?)`)
      .bind(AT, AT, AT, AT)
      .run();

    // The least favourable shape: one due target on each domain, so no domain is read for more
    // than one job. The registry's sources span about twenty domains; sixty is the adverse case.
    const rows: number[] = [];
    let previous = 0;
    for (const domains of [20, 60]) {
      await db.batch(
        Array.from({ length: domains - previous }, (_, offset) => previous + offset).flatMap(
          (index) => [
            db
              .prepare(`INSERT INTO knowledge_catalog_verification_jobs(run_id,job_key,job_type,
                  target_id,hostname,status,enqueued_at,available_at,created_at,updated_at)
                VALUES (2,?,'candidate',?,?,'queued',?,?,?,?)`)
              .bind(`spread-${index}`, index + 1, host(index), AT, AT, AT, AT),
            db
              .prepare(`INSERT INTO knowledge_catalog_verification_domain_leases(hostname,job_id,
                  leased_until,updated_at) VALUES (?,0,?,?)`)
              .bind(host(index), EXPIRED, AT),
          ],
        ),
      );
      previous = domains;

      const sample = `catalog-verification-live-claim-spread-${domains}`;
      const boundary = measureD1Cost(db);
      const claimed = await claimNextKnowledgeCatalogVerificationJobForRun(boundary.db, 2, NOW, 60);
      await pace(domains, PACED_UNTIL).run();
      const empty = await claimNextKnowledgeCatalogVerificationJobForRun(boundary.db, 2, NOW, 60);
      const next = await knowledgeCatalogVerificationRunNextAvailableAt(boundary.db, 2, NOW);
      const cost = boundary.metrics();
      await recordCostSample(sample, "local-workerd", cost, fixture, [
        `A claim, an empty claim and its wait with one live job on each of ${domains} domains.`,
      ]);
      console.log(JSON.stringify({ sample, ...cost }));
      assert.equal(claimed?.hostname, host(0));
      assert.equal(empty, null, "every domain with a due job is paced");
      assert.equal(next, PACED_UNTIL);
      assert.equal(cost.sqlStatements, 5);
      assert.ok(cost.rowsRead !== null, JSON.stringify(cost));
      rows.push(cost.rowsRead);

      await db
        .prepare(`UPDATE knowledge_catalog_verification_jobs
          SET status='queued', delivery_attempts=0, claimed_at=NULL, lease_expires_at=NULL
          WHERE run_id=2 AND status='processing'`)
        .run();
      await pace(domains, EXPIRED).run();
    }
    // Two claim selections and one wait each enumerate every waiting domain once.
    const perDomain = (rows[1] - rows[0]) / 40;
    assert.ok(perDomain <= 18, `${perDomain} rows per waiting domain: ${rows}`);
  } finally {
    await dispose();
  }
}, 60_000);
