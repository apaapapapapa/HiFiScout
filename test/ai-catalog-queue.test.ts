import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database, AT } from "./helpers/d1-write-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import {
  grantAiBudget,
  insertAiJob,
  loadAiBudget,
  loadAiJob,
  reserveAiAttempt,
  finishAiAttempt,
  setAiJobStatus,
} from "../src/db/ai-catalog-repository.js";
import { loadAiCatalogSnapshot } from "../src/db/ai-catalog-snapshot.js";
import {
  aiCatalogEnabled,
  maintainAiCatalogJobs,
  prepareAiCatalogJob,
  processAiCatalogJob,
  recordAiCatalogReview,
} from "../src/ai-suggestions/service.js";
import { AI_CATALOG_POLICY_KEY } from "../src/ai-suggestions/policy.js";
import { aiSnapshotFingerprint } from "../src/ai-suggestions/contract.js";
import { aiCatalogEvaluationCases } from "./fixtures/ai-catalog-evaluation.js";
import type { AiCatalogEnv } from "../src/ai-suggestions/types.js";
import type { QueryableDatabase } from "../src/db/types.js";

const now = new Date(AT);
const grant = (db: QueryableDatabase, at = now, allowanceMilli = 1000000) =>
  grantAiBudget(
    db,
    { allowanceMilli, evidence: "test account reservation", actor: "test-admin" },
    at,
  );
async function seed(db: QueryableDatabase) {
  await db
    .prepare(`INSERT INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
    VALUES ('tad','TAD',?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(AT, AT)
    .run();
  await db
    .prepare(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
    VALUES (101,'tad','D-1000MK2','D1000MK2','TAD D-1000MK2',?,?)`)
    .bind(AT, AT)
    .run();
  await db
    .prepare(
      "INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary) VALUES(101,'SRC.DISC',1)",
    )
    .run();
  await db
    .prepare(`INSERT INTO knowledge_catalog_candidates(id,manufacturer_id,normalized_model,observed_model,sample_title,raw_model_variants,candidate_category_ids,active_listing_count,verification_status,last_verification_at,last_reviewed_at,created_at,updated_at)
    VALUES(1,'tad','D1000MK2','D-1000 MK2','TAD D-1000 MK2 中古','["D-1000 MK2"]','["SRC.DISC"]',1,'not_found',?,?,?,?)`)
    .bind(AT, AT, AT, AT)
    .run();
}
function enabled(db: QueryableDatabase, run: () => Promise<unknown>): AiCatalogEnv {
  return {
    DB: db,
    AI: { run } as unknown as Ai,
    AI_CATALOG_QUEUE: { send: async () => {} } as unknown as Queue,
    AI_CATALOG_ENABLED: "true",
    AI_CATALOG_EVALUATION_POLICY: AI_CATALOG_POLICY_KEY,
  };
}

// Each case boots real workerd and applies the full migration chain, as the D1 budget suites do.
test("daily grant cannot reset reservations; duplicate claims are atomic and indexed", async () => {
  const { db, dispose } = await database();
  try {
    const snapshot = aiCatalogEvaluationCases[0].snapshot;
    const id = await aiSnapshotFingerprint(snapshot);
    await insertAiJob(db, id, snapshot, now);
    assert.equal(
      await reserveAiAttempt(db, id, now),
      null,
      "unknown account allowance fails closed",
    );
    await grant(db);
    await db
      .prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500)
    INSERT INTO ai_catalog_jobs(id,candidate_id,snapshot_json,status,created_at,updated_at)
    SELECT 'unrelated-'||x,x,'{}','reviewed',?,? FROM n`)
      .bind(AT, AT)
      .run();
    const measured = accountReads(db);
    const claims = await Promise.all([
      reserveAiAttempt(measured.db, id, now),
      reserveAiAttempt(measured.db, id, now),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.ok(measured.rowsRead() < 100, `indexed claims read ${measured.rowsRead()}`);
    assert.ok(measured.rowsWritten() < 40, `claims wrote ${measured.rowsWritten()}`);
    assert.equal(measured.statementCount(), 6);
    assert.equal((await loadAiBudget(db, AT.slice(0, 10)))?.reserved_milli, 18393);
    await grant(db);
    assert.equal((await loadAiBudget(db, AT.slice(0, 10)))?.reserved_milli, 18393);
    const repeated = accountReads(db);
    assert.equal(await insertAiJob(repeated.db, id, snapshot, now), false);
    assert.equal(repeated.rowsWritten(), 0);
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN SELECT id FROM ai_catalog_jobs
    WHERE status = 'queued' AND updated_at < ? ORDER BY updated_at,id LIMIT 5`)
      .bind(AT)
      .all<{ detail: string }>();
    assert.match(
      plan.results.map((row: { detail: string }) => row.detail).join(" "),
      /idx_ai_catalog_jobs_work/u,
    );
    console.log(
      JSON.stringify({
        event: "ai_budget_test_measurement",
        rowsRead: measured.rowsRead(),
        rowsWritten: measured.rowsWritten(),
        statements: measured.statementCount(),
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);

test("25 distinct jobs per UTC day and two total attempts, including old-job retries", async () => {
  const { db, dispose } = await database();
  try {
    await grant(db);
    const ids: string[] = [];
    for (let n = 1; n <= 26; n++) {
      const snapshot = structuredClone(aiCatalogEvaluationCases[0].snapshot);
      snapshot.target.candidateId = n;
      const id = await aiSnapshotFingerprint(snapshot);
      ids.push(id);
      await insertAiJob(db, id, snapshot, now);
      assert.equal(Boolean(await reserveAiAttempt(db, id, now)), n <= 25);
    }
    await setAiJobStatus(db, ids[0], "processing", "queued", "retry", now);
    assert.ok(await reserveAiAttempt(db, ids[0], now));
    await setAiJobStatus(db, ids[0], "processing", "queued", "retry", now);
    assert.equal(await reserveAiAttempt(db, ids[0], now), null);
    const tomorrow = new Date(now.getTime() + 86400000);
    await grant(db, tomorrow);
    await setAiJobStatus(db, ids[1], "processing", "queued", "retry", tomorrow);
    assert.ok(await reserveAiAttempt(db, ids[1], tomorrow));
    assert.equal((await loadAiBudget(db, tomorrow.toISOString().slice(0, 10)))?.started_jobs, 1);
  } finally {
    await dispose();
  }
}, 30_000);

test("changed seller/catalog evidence makes a suggestion stale without canonical writes", async () => {
  const { db, dispose } = await database();
  try {
    await seed(db);
    await grant(db);
    let calls = 0;
    const env = enabled(db, async () => {
      calls++;
      return {
        response: { decision: "suggestion", catalogProductId: 101, evidence: ["D-1000 MK2"] },
        usage: { prompt_tokens: 350, completion_tokens: 40, total_tokens: 390 },
      };
    });
    const job = await prepareAiCatalogJob(env, 1, now);
    assert.ok(job);
    await processAiCatalogJob(env, job.id, now);
    await processAiCatalogJob(env, job.id, now);
    assert.equal(calls, 1);
    assert.equal((await loadAiJob(db, job.id))?.status, "suggested");
    const same = await loadAiCatalogSnapshot(db, 1);
    assert.ok(same);
    await db
      .prepare(
        "UPDATE knowledge_catalog_candidates SET updated_at = ?,last_seen_at = ? WHERE id = 1",
      )
      .bind("new crawl", "new crawl")
      .run();
    assert.equal(await aiSnapshotFingerprint((await loadAiCatalogSnapshot(db, 1))!), job.id);
    await db
      .prepare(
        "UPDATE knowledge_catalog_candidates SET sample_title = 'D-1000 MK2 専用リモコン' WHERE id = 1",
      )
      .run();
    await assert.rejects(recordAiCatalogReview(env, job.id, "useful", "operator"), /stale/);
    assert.equal((await loadAiJob(db, job.id))?.status, "stale");
    assert.equal(
      (
        await db
          .prepare("SELECT review_status FROM knowledge_catalog_candidates WHERE id = 1")
          .first<{ review_status: string }>()
      )?.review_status,
      "pending",
    );
    assert.equal(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_aliases")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await dispose();
  }
}, 30_000);

test("unknown usage blocks the allowance; late completion cannot overwrite another lease", async () => {
  const { db, dispose } = await database();
  try {
    await seed(db);
    await grant(db);
    const env = enabled(db, async () => ({ response: "{}" }));
    const job = await prepareAiCatalogJob(env, 1, now);
    assert.ok(job);
    await processAiCatalogJob(env, job.id, now);
    assert.equal((await loadAiBudget(db, AT.slice(0, 10)))?.blocked, 1);
    assert.equal((await loadAiJob(db, job.id))?.error_code, "usage_unverified");
    await finishAiAttempt(db, {
      jobId: job.id,
      token: "wrong-token",
      status: "suggested",
      result: null,
      error: "",
      inputTokens: 1,
      outputTokens: 1,
      actualMilli: 1,
      latencyMs: 1,
    });
    assert.equal((await loadAiJob(db, job.id))?.status, "invalid");
    assert.equal(aiCatalogEnabled({ ...env, AI_CATALOG_EVALUATION_POLICY: "older-policy" }), false);
  } finally {
    await dispose();
  }
}, 30_000);

test("retention still runs with inference disabled", { timeout: 30_000 }, async () => {
  const { db, dispose } = await database();
  try {
    const snapshot = aiCatalogEvaluationCases[0].snapshot;
    const id = await aiSnapshotFingerprint(snapshot);
    await insertAiJob(db, id, snapshot, new Date("2025-01-01T00:00:00Z"));
    await maintainAiCatalogJobs({ DB: db }, now);
    assert.equal(await loadAiJob(db, id), null);
  } finally {
    await dispose();
  }
});

test("a lost invocation is deferred and its day's allowance is blocked even after disable", async () => {
  const { db, dispose } = await database();
  try {
    const snapshot = aiCatalogEvaluationCases[0].snapshot;
    const id = await aiSnapshotFingerprint(snapshot);
    await insertAiJob(db, id, snapshot, now);
    await grant(db);
    assert.ok(await reserveAiAttempt(db, id, now));
    await maintainAiCatalogJobs({ DB: db }, new Date(now.getTime() + 11 * 60 * 1000));
    assert.equal((await loadAiJob(db, id))?.status, "deferred");
    assert.equal((await loadAiBudget(db, AT.slice(0, 10)))?.blocked, 1);
    assert.equal((await loadAiBudget(db, AT.slice(0, 10)))?.reserved_milli, 18393);
  } finally {
    await dispose();
  }
}, 30_000);
