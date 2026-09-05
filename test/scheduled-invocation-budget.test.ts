import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  invocationBudget,
  InvocationBudgetExceeded,
  withinD1Budget,
  withD1Finalization,
} from "../src/db/invocation-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import {
  enqueueMaintenance,
  pendingMaintenance,
  claimMaintenance,
  completeMaintenance,
} from "../src/db/scheduled-maintenance-repository.js";
import { runPendingMaintenance } from "../src/scheduled.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { asQueryableDatabase } from "./helpers/d1.js";

test("one invocation budget counts all D1 terminal calls, including failures and batched SQL", async () => {
  const { db, sqlite } = migratedSqlite();
  const budget = invocationBudget(db, { maxCalls: 4 });
  await budget.db.prepare("SELECT 1").first();
  await assert.rejects(budget.db.prepare("SELECT * FROM missing_table").all());
  await budget.db.batch([
    budget.db.prepare("CREATE TABLE budget_writes(n INTEGER)"),
    budget.db.prepare("INSERT INTO budget_writes VALUES (1)"),
  ]);
  await budget.db.prepare("SELECT 1").all();
  await assert.rejects(
    budget.db.prepare("INSERT INTO budget_writes VALUES (2)").run(),
    InvocationBudgetExceeded,
  );
  assert.equal(budget.metrics().d1Calls, 4);
  assert.equal(budget.metrics().sqlStatements, 5);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM budget_writes").get()?.n, 1);

  let rawCalls = 0;
  const raw = invocationBudget(
    asQueryableDatabase({
      prepare: () => ({
        raw: async () => {
          rawCalls += 1;
          return [[1]];
        },
      }),
    }),
    { maxCalls: 1 },
  );
  assert.deepEqual(await raw.db.prepare("SELECT 1").raw(), [[1]]);
  await assert.rejects(raw.db.prepare("SELECT 1").raw(), InvocationBudgetExceeded);
  assert.equal(rawCalls, 1);
});

test("work-unit admission survives accounting wrappers and yields before any write", async () => {
  const { db, sqlite } = migratedSqlite();
  sqlite.exec("CREATE TABLE unit_writes(n INTEGER)");
  const budget = invocationBudget(db, { maxCalls: 2 });
  const measured = accountReads(budget.db);
  await measured.db.prepare("SELECT 1").all();
  await assert.rejects(
    withinD1Budget(measured.db, 2, async () => {
      await measured.db.prepare("INSERT INTO unit_writes VALUES (1)").run();
      await measured.db.prepare("INSERT INTO unit_writes VALUES (2)").run();
    }),
    InvocationBudgetExceeded,
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM unit_writes").get()?.n, 0);
});

test("wall deadline yields between admitted work units, preserving a complete transition", async () => {
  const { db } = migratedSqlite();
  let time = 0;
  const budget = invocationBudget(db, { maxWallMs: 10, clock: () => time });
  await withinD1Budget(budget.db, 2, async () => {
    await budget.db.prepare("SELECT 1").all();
    time = 20;
    await budget.db.prepare("SELECT 1").all();
  });
  await assert.rejects(budget.db.prepare("SELECT 1").all(), InvocationBudgetExceeded);
  assert.equal(budget.metrics().d1Calls, 2);
  assert.equal(budget.metrics().yieldReason, "wall_time");
});

test("reserved finalization survives a yield and accounting wrappers without exceeding the total cap", async () => {
  const { db, sqlite } = migratedSqlite();
  sqlite.exec("CREATE TABLE completed_work(n INTEGER)");
  const globalAccounting = accountReads(db);
  const budget = invocationBudget(globalAccounting.db, { maxCalls: 3, finalizationReserve: 2 });
  const taskAccounting = accountReads(budget.db);
  await taskAccounting.db.prepare("SELECT 1").all();
  await assert.rejects(taskAccounting.db.prepare("SELECT 2").all(), InvocationBudgetExceeded);
  await withD1Finalization(taskAccounting.db, async () => {
    await taskAccounting.db.prepare("INSERT INTO completed_work VALUES (1)").run();
    await taskAccounting.db.prepare("INSERT INTO completed_work VALUES (2)").run();
    await assert.rejects(
      taskAccounting.db.prepare("INSERT INTO completed_work VALUES (3)").run(),
      InvocationBudgetExceeded,
    );
  });
  assert.equal(budget.metrics().d1Calls, 3);
  assert.equal(globalAccounting.statementCount(), 3);
  assert.equal(
    taskAccounting.countedStatements(),
    2,
    "SQLite supplies meta for the two cleanup writes",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM completed_work").get()?.n, 2);
  await assert.rejects(taskAccounting.db.prepare("SELECT 1").all(), InvocationBudgetExceeded);
});

test("finalization may cross the work deadline but does not reopen ordinary work", async () => {
  const { db } = migratedSqlite();
  let time = 0;
  const budget = invocationBudget(db, {
    maxCalls: 5,
    finalizationReserve: 2,
    maxWallMs: 10,
    clock: () => time,
  });
  time = 20;
  await assert.rejects(budget.db.prepare("SELECT 1").all(), InvocationBudgetExceeded);
  await withD1Finalization(budget.db, () => budget.db.prepare("SELECT 1").all());
  assert.equal(budget.metrics().d1Calls, 1);
  await assert.rejects(budget.db.prepare("SELECT 1").all(), InvocationBudgetExceeded);
});

test("budget-limited daily work resumes on later ticks and lets untouched tasks run first", async () => {
  const { db, sqlite } = migratedSqlite();
  sqlite.exec("CREATE TABLE progress(n INTEGER); INSERT INTO progress VALUES (0)");
  const at = new Date("2030-01-01T18:20:00Z");
  await enqueueMaintenance(db, ["daily_heavy", "daily_small"], at);
  let smallRuns = 0;
  const tasks = [
    {
      name: "daily_heavy",
      async run(env: Env) {
        const row = await env.DB.prepare("SELECT n FROM progress").first<{ n: number }>();
        for (let n = Number(row?.n); n < 25; n += 1)
          await env.DB.prepare("UPDATE progress SET n = n + 1").run();
      },
    },
    {
      name: "daily_small",
      async run(env: Env) {
        await env.DB.prepare("SELECT 1").all();
        smallRuns += 1;
      },
    },
  ];
  for (let tick = 0; tick < 6; tick += 1) {
    const now = new Date(at.getTime() + tick * 5 * 60_000);
    const budget = invocationBudget(db, { maxCalls: 12 });
    // Representative watchdog work shares the same budget as maintenance.
    await budget.db.prepare("SELECT 1").first();
    await runPendingMaintenance({ DB: budget.db } as unknown as Env, now, budget, tasks);
    assert.ok(budget.metrics().d1Calls <= 12);
    if (tick === 0) assert.equal(smallRuns, 0);
    if (tick === 1)
      assert.equal(
        smallRuns,
        1,
        "untouched work must not starve behind a repeatedly yielding task",
      );
  }
  assert.equal(sqlite.prepare("SELECT n FROM progress").get()?.n, 25);
  assert.equal(smallRuns, 1);
  assert.deepEqual(await pendingMaintenance(db, new Date(at.getTime() + 60 * 60_000)), []);
});

test("stale maintenance completion cannot delete a newer claim", async () => {
  const { db } = migratedSqlite();
  const at = new Date("2030-01-01T00:00:00Z");
  await enqueueMaintenance(db, ["task"], at);
  const old = await claimMaintenance(db, "task", at);
  assert.ok(old);
  assert.equal(await claimMaintenance(db, "task", at), null);
  const later = new Date(at.getTime() + 5 * 60_000);
  const current = await claimMaintenance(db, "task", later);
  assert.ok(current);
  await completeMaintenance(db, "task", old);
  assert.equal(
    (
      await db
        .prepare("SELECT claim_token FROM scheduled_maintenance_pending")
        .first<{ claim_token: string }>()
    )?.claim_token,
    current,
  );
  await completeMaintenance(db, "task", current);
  assert.deepEqual(await pendingMaintenance(db, later), []);
});
