import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { TEST_ADMIN_PRINCIPAL } from "./helpers/admin-principal.js";
import { database, AT } from "./helpers/d1-write-budget.js";
import { parseAiAdminCommand } from "../src/http/admin-ai-catalog.js";
import { parseKnowledgeCatalogAdminCreate } from "../src/http/knowledge-catalog-admin.js";
import adminEntry, { handleAuthenticatedAdminEntryRequest } from "../src/admin/entry.js";
import { adminAiCatalog, aiCatalogDetail } from "../src/ai-suggestions/admin.js";
import { insertAiJob, reviewAiJob } from "../src/db/ai-catalog-repository.js";
import { loadAiCatalogSnapshot } from "../src/db/ai-catalog-snapshot.js";
import { aiSnapshotFingerprint } from "../src/ai-suggestions/contract.js";
import { assertAiCatalogVerification } from "../src/db/ai-catalog-verification.js";
import { accountReads } from "../src/db/read-accounting.js";
import {
  verifyKnowledgeCatalogAdminCandidate,
  createKnowledgeCatalogAdminProduct,
} from "../src/db/knowledge-catalog-admin-operations.js";
import type { QueryableDatabase } from "../src/db/types.js";

const now = new Date(AT);
const input = {
  manufacturerId: "tad",
  canonicalModel: "D-1000MK2",
  canonicalName: "TAD D-1000MK2",
  primaryCategoryId: "SRC.DISC",
  lifecycleStatus: "unknown" as const,
  sourceUrl: "https://example.test/manual-source",
};
async function seed(db: QueryableDatabase) {
  await db
    .prepare(`INSERT INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
    VALUES('tad','TAD',?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(AT, AT)
    .run();
  await db
    .prepare(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
    VALUES(101,'tad','D-1000MK2','D1000MK2','TAD D-1000MK2',?,?)`)
    .bind(AT, AT)
    .run();
  await db
    .prepare(
      "INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary) VALUES(101,'SRC.DISC',1)",
    )
    .run();
  await db
    .prepare(`INSERT INTO knowledge_catalog_candidates(id,manufacturer_id,normalized_model,observed_model,sample_title,raw_model_variants,candidate_category_ids,active_listing_count,verification_status,last_verification_at,last_reviewed_at,created_at,updated_at)
    VALUES(1,'tad','D1000MK2','D-1000 MK2','TAD D-1000 MK2','["D-1000 MK2"]','["SRC.DISC"]',1,'not_found',?,?,?,?)`)
    .bind(AT, AT, AT, AT)
    .run();
  const snapshot = await loadAiCatalogSnapshot(db, 1);
  assert.ok(snapshot);
  const id = await aiSnapshotFingerprint(snapshot);
  await insertAiJob(db, id, snapshot, now);
  await db
    .prepare("UPDATE ai_catalog_jobs SET status='suggested',result_json=? WHERE id=?")
    .bind(
      JSON.stringify({ decision: "suggestion", catalogProductId: 101, evidence: ["D-1000 MK2"] }),
      id,
    )
    .run();
  return id;
}

test("operator commands constrain budget evidence and cannot select a model or auto-apply", () => {
  assert.equal(parseAiAdminCommand({ action: "apply", id: "a".repeat(64) }), null);
  assert.equal(parseAiAdminCommand({ action: "prepare", candidateId: -1 }), null);
  assert.equal(parseAiAdminCommand({ action: "detail", id: "../x" }), null);
  assert.equal(
    parseAiAdminCommand({
      action: "grant",
      allowanceNeurons: 1001,
      evidence: "checked",
      checkedAt: AT,
      otherConsumersAccountedFor: true,
    }),
    null,
  );
  assert.equal(
    parseAiAdminCommand({
      action: "grant",
      allowanceNeurons: 1000,
      evidence: "checked",
      checkedAt: AT,
      otherConsumersAccountedFor: false,
    }),
    null,
  );
  assert.deepEqual(
    parseAiAdminCommand({
      action: "prepare",
      candidateId: 1,
      model: "unapproved",
      actor: "forged",
    }),
    { action: "prepare", candidateId: 1 },
  );
  assert.equal(parseKnowledgeCatalogAdminCreate({ ...input, aiSuggestionId: "invalid" }), null);
});

test("AI admin route enforces Access, JSON, same-origin, payload limits and server actor", async () => {
  let calls = 0;
  const env = {
    CATALOG_ADMIN: {
      async adminAiCatalog(command: unknown, actor: string) {
        calls++;
        // The entry point's verified subject, not a fixed placeholder standing in for everyone.
        assert.equal(actor, TEST_ADMIN_PRINCIPAL.actor);
        return command;
      },
    },
  } as unknown as Parameters<typeof handleAuthenticatedAdminEntryRequest>[1];
  const request = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://admin.example.test/api/admin/ai-catalog", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://admin.example.test",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await adminEntry.fetch(request({ action: "block" }), env)).status, 403);
  assert.equal(
    (
      await handleAuthenticatedAdminEntryRequest(
        request({ action: "block" }, { origin: "https://evil.test" }),
        env,
        TEST_ADMIN_PRINCIPAL,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleAuthenticatedAdminEntryRequest(
        request({ action: "block" }, { "content-type": "text/plain" }),
        env,
        TEST_ADMIN_PRINCIPAL,
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await handleAuthenticatedAdminEntryRequest(
        request({ action: "block", padding: "x".repeat(5000) }),
        env,
        TEST_ADMIN_PRINCIPAL,
      )
    ).status,
    413,
  );
  assert.equal(calls, 0);
  const response = await handleAuthenticatedAdminEntryRequest(
    request({ action: "block", actor: "forged" }),
    env,
    TEST_ADMIN_PRINCIPAL,
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("usefulness review has no product side effect and Verify links the review audit", async () => {
  const { db, dispose } = await database();
  try {
    const id = await seed(db);
    await assert.rejects(
      verifyKnowledgeCatalogAdminCandidate(db, 1, { ...input, aiSuggestionId: id }),
      /ai_review_required/,
    );
    await adminAiCatalog({ DB: db }, { action: "review", id, outcome: "useful" }, "operator", now);
    assert.equal(
      (
        await db
          .prepare("SELECT review_status FROM knowledge_catalog_candidates WHERE id=1")
          .first<{ review_status: string }>()
      )?.review_status,
      "pending",
    );
    const detail = await aiCatalogDetail({ DB: db }, id);
    assert.ok(detail.handoffUrl?.includes(`aiSuggestionId=${id}`));
    await assert.rejects(
      verifyKnowledgeCatalogAdminCandidate(db, 1, {
        ...input,
        canonicalModel: "D-1000TX",
        aiSuggestionId: id,
      }),
      /ai_selection_changed/,
    );
    await assert.rejects(
      createKnowledgeCatalogAdminProduct(db, { ...input, aiSuggestionId: id }),
      /ai_review_required/,
    );
    const result = await verifyKnowledgeCatalogAdminCandidate(db, 1, {
      ...input,
      aiSuggestionId: id,
    });
    assert.equal(result?.product.id, 101);
    assert.equal(result?.matchedExisting, true);
    const attempt = await db
      .prepare(
        "SELECT message FROM knowledge_catalog_verification_attempts WHERE candidate_id=1 ORDER BY id DESC LIMIT 1",
      )
      .first<{ message: string }>();
    assert.match(attempt?.message || "", new RegExp(`ai_suggestion=${id}`));
    assert.equal((await aiCatalogDetail({ DB: db }, id)).handoffUrl, null);
  } finally {
    await dispose();
  }
}, 30_000);

const concurrentMutations = [
  [
    "sale-object title",
    "UPDATE knowledge_catalog_candidates SET sample_title='D-1000 MK2 専用リモコン' WHERE id=1",
  ],
  [
    "raw model evidence",
    `UPDATE knowledge_catalog_candidates SET raw_model_variants='["D-1000 MK2 専用リモコン"]' WHERE id=1`,
  ],
  [
    "secondary accessory category",
    "INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary) VALUES(101,'ACC.PART',0)",
  ],
  [
    "new matching alternative",
    `INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
    VALUES(102,'tad','D-1000MK2','D1000MK2-BK','TAD D-1000MK2 black','${AT}','${AT}')`,
  ],
] as const;

for (const [description, mutation] of concurrentMutations)
  test(`a concurrent ${description} change rolls back candidate, aliases and audit`, async () => {
    const { db, dispose } = await database();
    try {
      const id = await seed(db);
      await reviewAiJob(db, id, "useful", "operator", now);
      let finalBatch = false;
      const concurrent: QueryableDatabase = {
        prepare(sql) {
          if (sql.includes("INSERT INTO knowledge_catalog_verification_attempts"))
            finalBatch = true;
          return db.prepare(sql);
        },
        async batch(statements) {
          if (finalBatch) {
            finalBatch = false;
            await db.prepare(mutation).run();
          }
          return db.batch(statements);
        },
      };
      await assert.rejects(
        verifyKnowledgeCatalogAdminCandidate(concurrent, 1, { ...input, aiSuggestionId: id }),
        /ai_stale/,
      );
      assert.equal(
        (
          await db
            .prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_aliases")
            .first<{ n: number }>()
        )?.n,
        0,
      );
      assert.equal(
        (
          await db
            .prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_verification_attempts")
            .first<{ n: number }>()
        )?.n,
        0,
      );
      assert.equal(
        (
          await db
            .prepare("SELECT review_status FROM knowledge_catalog_candidates WHERE id=1")
            .first<{ review_status: string }>()
        )?.review_status,
        "pending",
      );
    } finally {
      await dispose();
    }
  }, 30_000);

test("manual verification fence has bounded D1 cost and does not invalidate unchanged AI evidence", async () => {
  const { db, dispose } = await database();
  try {
    const id = await seed(db);
    await reviewAiJob(db, id, "useful", "operator", now);
    const semanticSql = "UPDATE knowledge_catalog_candidates SET sample_title=? WHERE id=1";
    const unregistered = await db.prepare(semanticSql).bind("temporary title").run();
    await db.prepare(semanticSql).bind("TAD D-1000 MK2").run();
    await db
      .prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500)
      INSERT INTO ai_catalog_revisions(manufacturer_id,revision) SELECT 'unrelated-'||x,0 FROM n`)
      .run();
    const first = accountReads(db);
    const fence = await assertAiCatalogVerification(first.db, 1, { ...input, aiSuggestionId: id });
    assert.equal(fence.revision, 0);
    assert.equal(
      first.rowsWritten(),
      2,
      "one clock row and its primary-key index are registered once",
    );
    const repeated = accountReads(db);
    assert.deepEqual(
      await assertAiCatalogVerification(repeated.db, 1, { ...input, aiSuggestionId: id }),
      fence,
    );
    assert.equal(repeated.rowsWritten(), 0, "repeated validation does not rewrite the clock");
    assert.ok(repeated.rowsRead() < 100, `point/indexed reads: ${repeated.rowsRead()}`);
    const noOp = await db.prepare(semanticSql).bind("TAD D-1000 MK2").run();
    const timestamps = await db
      .prepare(
        "UPDATE knowledge_catalog_candidates SET updated_at='new crawl',last_seen_at='new crawl' WHERE id=1",
      )
      .run();
    assert.equal(
      (await assertAiCatalogVerification(db, 1, { ...input, aiSuggestionId: id })).revision,
      0,
    );
    assert.equal(await aiSnapshotFingerprint((await loadAiCatalogSnapshot(db, 1))!), id);
    const registered = await db.prepare(semanticSql).bind("temporary title").run();
    assert.equal(
      registered.meta.rows_written,
      Number(unregistered.meta.rows_written) + 1,
      "one extra clock write for a relevant mutation",
    );
    const clock = await db
      .prepare("SELECT revision FROM ai_catalog_revisions WHERE manufacturer_id='tad'")
      .first<{ revision: number }>();
    assert.equal(clock?.revision, 1);
    const plan = await db
      .prepare(
        "EXPLAIN QUERY PLAN UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id='tad'",
      )
      .all<{ detail: string }>();
    assert.match(
      plan.results.map((r: { detail: string }) => r.detail).join(" "),
      /SEARCH.*INDEX.*manufacturer_id/u,
    );
    console.log(
      JSON.stringify({
        event: "ai_verification_fence_d1",
        registration: {
          reads: first.rowsRead(),
          writes: first.rowsWritten(),
          statements: first.statementCount(),
        },
        repeat: {
          reads: repeated.rowsRead(),
          writes: repeated.rowsWritten(),
          statements: repeated.statementCount(),
        },
        unregisteredWrites: unregistered.meta.rows_written,
        registeredWrites: registered.meta.rows_written,
        noOpWrites: noOp.meta.rows_written,
        timestampWrites: timestamps.meta.rows_written,
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);

test("budget evidence expires and an immutable daily grant cannot reset a block", async () => {
  const { db, dispose } = await database();
  try {
    const command = {
      action: "grant",
      allowanceNeurons: 500,
      evidence: "account-wide capacity reserved",
      checkedAt: AT,
      otherConsumersAccountedFor: true,
    };
    await assert.rejects(
      adminAiCatalog({ DB: db }, command, "operator", new Date(now.getTime() + 16 * 60000)),
      /expired/,
    );
    await adminAiCatalog({ DB: db }, command, "operator", now);
    await adminAiCatalog({ DB: db }, { action: "block" }, "operator", now);
    await adminAiCatalog({ DB: db }, { ...command, allowanceNeurons: 1000 }, "operator", now);
    const row = await db
      .prepare("SELECT allowance_milli,blocked FROM ai_catalog_budgets WHERE day=?")
      .bind(AT.slice(0, 10))
      .first<{ allowance_milli: number; blocked: number }>();
    assert.equal(row?.allowance_milli, 500000);
    assert.equal(row?.blocked, 1);
    const tomorrow = new Date(now.getTime() + 86400000);
    await adminAiCatalog({ DB: db }, { action: "block" }, "operator", tomorrow);
    await adminAiCatalog(
      { DB: db },
      { ...command, checkedAt: tomorrow.toISOString() },
      "operator",
      tomorrow,
    );
    const stopped = await db
      .prepare("SELECT allowance_milli,blocked FROM ai_catalog_budgets WHERE day=?")
      .bind(tomorrow.toISOString().slice(0, 10))
      .first<{ allowance_milli: number; blocked: number }>();
    assert.equal(stopped?.allowance_milli, 0);
    assert.equal(stopped?.blocked, 1);
  } finally {
    await dispose();
  }
}, 30_000);
