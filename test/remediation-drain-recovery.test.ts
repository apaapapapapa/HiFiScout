import assert from "node:assert/strict";
import test from "node:test";
import {
  claimDataQualityRemediationBatch,
  dataQualityRemediationQueueMetrics,
  enqueueDataQualityRemediation,
  retryOrFailDataQualityRemediationJob,
} from "../src/db/data-quality-remediation-queue-repository.js";
import {
  EXHAUSTED_LEASE_RECOVERY_SOURCE_MARKER,
  recoverExpiredExhaustedAutomaticRemediationJobs,
} from "../scripts/lib/remediation-drain-recovery.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

test("administrative drain grants an exhausted automatic lease exactly one extra attempt", async () => {
  const { sqlite, db } = migratedSqlite();
  const t0 = "2026-08-16T00:00:00.000Z";
  const recoveredAt = "2026-08-16T00:01:01.000Z";

  await enqueueDataQualityRemediation(db, {
    workKey: "auto:resolve_manufacturer:listing:42:manufacturer:2:model:2:category:3:identity:1",
    workType: "resolve_manufacturer",
    reason: "test exhausted automatic lease",
    source: "scheduled_sweep",
    maxAttempts: 1,
    now: t0,
  });

  const [first] = await claimDataQualityRemediationBatch(db, {
    claimedAt: t0,
    leaseSeconds: 60,
  });
  assert.ok(first);
  assert.equal(first.attemptCount, 1);
  assert.equal(first.maxAttempts, 1);

  const recovered = await recoverExpiredExhaustedAutomaticRemediationJobs(db, recoveredAt);
  assert.equal(recovered, 1);

  const row = sqlite
    .prepare(`
      SELECT status, attempt_count, max_attempts, source, claimed_at, lease_expires_at
      FROM data_quality_remediation_queue
      WHERE id = ?
    `)
    .get(first.id) as {
    status: string;
    attempt_count: number;
    max_attempts: number;
    source: string;
    claimed_at: string | null;
    lease_expires_at: string | null;
  };
  assert.equal(row.status, "pending");
  assert.equal(row.attempt_count, 1, "attempt history must be preserved");
  assert.equal(row.max_attempts, 2, "recovery grants one and only one extra attempt");
  assert.match(row.source, new RegExp(EXHAUSTED_LEASE_RECOVERY_SOURCE_MARKER));
  assert.equal(row.claimed_at, null);
  assert.equal(row.lease_expires_at, null);

  assert.equal(
    await recoverExpiredExhaustedAutomaticRemediationJobs(db, recoveredAt),
    0,
    "the persistent source marker prevents an unbounded recovery loop",
  );

  const [second] = await claimDataQualityRemediationBatch(db, {
    claimedAt: recoveredAt,
    leaseSeconds: 60,
  });
  assert.ok(second);
  assert.equal(second.id, first.id);
  assert.equal(second.attemptCount, 2);
  assert.equal(second.maxAttempts, 2);

  const status = await retryOrFailDataQualityRemediationJob(db, second.id, "still broken", {
    updatedAt: "2026-08-16T00:01:02.000Z",
  });
  assert.equal(status, "failed", "a real failure on the recovered attempt remains terminal");
  assert.equal(
    await recoverExpiredExhaustedAutomaticRemediationJobs(db, "2026-08-16T01:00:00.000Z"),
    0,
  );

  const metrics = await dataQualityRemediationQueueMetrics(db);
  assert.equal(metrics.processing, 0);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.backlog, 0);
});

test("manual exhausted jobs are not rewritten by the resolver replay recovery", async () => {
  const { db } = migratedSqlite();
  const t0 = "2026-08-16T00:00:00.000Z";

  await enqueueDataQualityRemediation(db, {
    workKey: "manual:listing:42",
    workType: "reprocess_listing",
    reason: "manual work must retain normal retry semantics",
    source: "manual",
    maxAttempts: 1,
    now: t0,
  });
  const [job] = await claimDataQualityRemediationBatch(db, { claimedAt: t0, leaseSeconds: 60 });
  assert.ok(job);

  assert.equal(
    await recoverExpiredExhaustedAutomaticRemediationJobs(
      db,
      "2026-08-16T00:01:01.000Z",
    ),
    0,
  );
  const metrics = await dataQualityRemediationQueueMetrics(db);
  assert.equal(metrics.processing, 1);
  assert.equal(metrics.failed, 0);
});
