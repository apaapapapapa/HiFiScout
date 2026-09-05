import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { invocationBudget, InvocationBudgetExceeded } from "../src/db/invocation-budget.js";
import { KNOWLEDGE_CATALOG_VERIFIER_VERSION } from "../src/catalog/knowledge-verification/verifier.js";
import { accountReads } from "../src/db/read-accounting.js";
import {
  enqueueMaintenance,
  pendingMaintenance,
} from "../src/db/scheduled-maintenance-repository.js";
import {
  dispatchKnowledgeCatalogDailyVerification,
  dispatchKnowledgeCatalogMonthlyRecheck,
} from "../src/knowledge-catalog/dispatch.js";
import { bootstrapKnowledgeCatalogReview, runPendingMaintenance } from "../src/scheduled.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { queueBinding, queueEnv } from "./helpers/knowledge-queue.js";

const AT = new Date("2030-01-01T18:20:00Z");
const LATER = new Date(AT.getTime() + 5 * 60_000);
const RESERVE = 5;
const MODES = [
  ["daily_catalog_verification", dispatchKnowledgeCatalogDailyVerification],
  ["knowledge_catalog_monthly_recheck", dispatchKnowledgeCatalogMonthlyRecheck],
] as const;

function fixture() {
  const database = migratedSqlite();
  database.sqlite.exec(`
    DELETE FROM knowledge_catalog_products;
    INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id, canonical_name, created_at, updated_at)
    VALUES ('luxman', 'Luxman', '2020-01-01', '2020-01-01');
    INSERT INTO products(shop_key, source_id, title, manufacturer, canonical_manufacturer_id, model,
                         source_url, first_seen_at, last_seen_at, last_changed_at, is_active)
    VALUES ('shop', '1', 'LUXMAN L-507', 'LUXMAN', 'luxman', 'L-507',
            'https://example.test/1', '2020-01-01', '2020-01-01', '2020-01-01', 1);
    INSERT INTO knowledge_catalog_products
      (id, manufacturer_id, canonical_model, normalized_model, canonical_name,
       verification_status, review_status, created_at, updated_at)
    VALUES (1, 'luxman', 'L-509', 'l509', 'Luxman L-509', 'verified', 'due', '2020-01-01', '2020-01-01');
    INSERT INTO knowledge_catalog_sources(product_id, source_type, source_url, created_at, updated_at)
    VALUES (1, 'manufacturer_official', 'https://www.luxman.co.jp/product/l-509', '2020-01-01', '2020-01-01');
    INSERT INTO knowledge_catalog_verifier_state(version, status, started_at)
    VALUES (1, 'running', '2020-01-01');
  `);
  return database;
}

async function dispatchCost(dispatch: (typeof MODES)[number][1]): Promise<number> {
  const { db } = fixture();
  const budget = invocationBudget(db);
  const result = await dispatch(queueEnv(budget.db), { now: AT });
  assert.equal(result.durableJobs, 2, "both a target and its finalizer must be persisted");
  return budget.metrics().d1Calls;
}

test("a recovery run claimed just before a yield is closed before dispatch takes ownership", async () => {
  const { db, sqlite } = fixture();
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO knowledge_catalog_verifier_state(version, status, started_at) VALUES (?, 'success', ?)",
    )
    .run(KNOWLEDGE_CATALOG_VERIFIER_VERSION, AT.toISOString());
  sqlite
    .prepare(
      "INSERT INTO knowledge_catalog_review_runs(started_at, status, message) VALUES (?, 'failed', 'previous_dispatch_failed')",
    )
    .run(AT.toISOString());
  // Version claim, three status lookups, then the atomic recovery-run insert.
  const budget = invocationBudget(db, { maxCalls: 5 + RESERVE, finalizationReserve: RESERVE });
  const queue = queueBinding();
  await assert.rejects(
    bootstrapKnowledgeCatalogReview(queueEnv(budget.db, queue.binding) as Env, AT),
    InvocationBudgetExceeded,
  );
  assert.equal(queue.sent.length, 0);
  assert.deepEqual(
    sqlite
      .prepare("SELECT status FROM knowledge_catalog_review_runs ORDER BY id")
      .all()
      .map((row) => row.status),
    ["failed", "failed"],
  );
  assert.equal(budget.metrics().d1Calls, 6);
});

for (const [name, dispatch] of MODES) {
  test(`${name}: a yield after job persistence closes the orphan and retries on a later tick`, async () => {
    const cost = await dispatchCost(dispatch);
    const { db, sqlite } = fixture();
    await enqueueMaintenance(db, [name], AT);
    const queue = queueBinding();
    const tasks = [{ name, run: (env: Env, now: Date) => dispatch(env, { now }) }];
    // Pending lookup and claim precede dispatch. Its final call reads back the inserted jobs.
    const maxCalls = 2 + cost - 1 + RESERVE;
    const budget = invocationBudget(db, { maxCalls, finalizationReserve: RESERVE });
    await runPendingMaintenance(queueEnv(budget.db, queue.binding) as Env, AT, budget, tasks);
    assert.equal(queue.sent.length, 0);
    assert.equal(
      sqlite.prepare("SELECT status FROM knowledge_catalog_review_runs").get()?.status,
      "failed",
    );
    const jobs = sqlite.prepare("SELECT status FROM knowledge_catalog_verification_jobs").all();
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((job) => job.status === "dead_letter"));
    assert.ok(budget.metrics().d1Calls <= maxCalls);
    assert.deepEqual(await pendingMaintenance(db, LATER), [name]);

    const retry = invocationBudget(db, { finalizationReserve: RESERVE });
    await runPendingMaintenance(queueEnv(retry.db, queue.binding) as Env, LATER, retry, tasks);
    assert.deepEqual(await pendingMaintenance(db, LATER), []);
    assert.equal(queue.sent.length, 1);
    assert.deepEqual(
      sqlite
        .prepare("SELECT status FROM knowledge_catalog_review_runs ORDER BY id")
        .all()
        .map((row) => row.status),
      ["failed", "running"],
      "the successor must not hide an older running orphan",
    );
  });

  for (const boundary of ["last D1 call", "wall deadline"] as const) {
    test(`${name}: successful dispatch at the ${boundary} records completion without another wake`, async () => {
      const cost = await dispatchCost(dispatch);
      const { db, sqlite } = fixture();
      await enqueueMaintenance(db, [name], AT);
      let time = 0;
      let wakes = 0;
      const queue = {
        async send() {
          wakes += 1;
          if (boundary === "wall deadline") time = 20;
        },
      } as unknown as ReturnType<typeof queueBinding>["binding"];
      const maxCalls = 2 + cost + RESERVE;
      const budget = invocationBudget(db, {
        maxCalls: boundary === "last D1 call" ? maxCalls : 45,
        finalizationReserve: RESERVE,
        maxWallMs: 10,
        clock: () => time,
      });
      const tasks = [{ name, run: (env: Env, now: Date) => dispatch(env, { now }) }];
      await runPendingMaintenance(queueEnv(budget.db, queue) as Env, AT, budget, tasks);
      assert.equal(budget.exhausted(), true);
      assert.deepEqual(await pendingMaintenance(db, LATER), []);
      assert.equal(budget.metrics().d1Calls, cost + 3, "completion remains a metered D1 call");

      const next = invocationBudget(db, { finalizationReserve: RESERVE });
      await runPendingMaintenance(queueEnv(next.db, queue) as Env, LATER, next, tasks);
      assert.equal(wakes, 1);
      assert.equal(
        sqlite.prepare("SELECT COUNT(*) n FROM knowledge_catalog_review_runs").get()?.n,
        1,
      );
    });
  }

  test(`${name}: Queue failure at the call limit closes jobs, run and verifier state within the reserve`, async () => {
    const cost = await dispatchCost(dispatch);
    const { db, sqlite } = fixture();
    const maxCalls = cost + RESERVE;
    const budget = invocationBudget(db, { maxCalls, finalizationReserve: RESERVE });
    const accounting = accountReads(budget.db);
    const failure = new Error("daily Queue write limit exceeded");
    const queue = {
      async send() {
        throw failure;
      },
    } as unknown as ReturnType<typeof queueBinding>["binding"];
    await assert.rejects(
      dispatch(queueEnv(accounting.db, queue), { now: AT, verifierVersion: 1 }),
      (error) => error === failure,
    );
    assert.equal(budget.metrics().d1Calls, cost + 3);
    assert.ok(budget.metrics().d1Calls <= maxCalls);
    const run = sqlite.prepare("SELECT status, message FROM knowledge_catalog_review_runs").get();
    assert.equal(run?.status, "failed");
    assert.equal(run?.message, "knowledge_catalog_run_wakeup_enqueue_failed");
    assert.equal(
      sqlite.prepare("SELECT status FROM knowledge_catalog_verifier_state WHERE version = 1").get()
        ?.status,
      "failed",
    );
    assert.ok(
      sqlite
        .prepare("SELECT status FROM knowledge_catalog_verification_jobs")
        .all()
        .every((job) => job.status === "dead_letter"),
    );
  });
}
