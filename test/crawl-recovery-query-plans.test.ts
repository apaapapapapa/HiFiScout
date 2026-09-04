import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { listResumableCrawlRuns } from "../src/db/crawl-run-continuation-repository.js";
import { listStalledCrawlRuns } from "../src/db/crawl-run-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  assertNoGrowingTableScans,
  assertNoSortBeforeLimit,
  queryPlan,
  readsThroughIndex,
  recordingDatabase,
  selects,
} from "./helpers/query-plan.js";

const AT = "2026-09-03T00:00:00.000Z";
const OLD = "2026-09-01T00:00:00.000Z";
const CUTOFF = "2026-09-02T00:00:00.000Z";

function seedRuns(terminalHistory: number, { resumable = 2, running = 2 } = {}) {
  const { sqlite, db: inner } = migratedSqlite();
  const insertRun = sqlite.prepare(`
    INSERT INTO crawl_runs (shop_key, started_at, finished_at, status, generation)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertStage = sqlite.prepare(`
    INSERT INTO crawl_run_stages (crawl_run_id, stage, ordinal, status, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  sqlite.exec("BEGIN");
  for (let i = 0; i < terminalHistory; i += 1) {
    insertRun.run(`history-${i}`, OLD, AT, "success", `g-history-${i}`);
  }
  const resumableIds: number[] = [];
  for (let i = 0; i < resumable; i += 1) {
    const result = insertRun.run(`resume-${i}`, OLD, null, "success", `g-resume-${i}`);
    const id = Number(result.lastInsertRowid);
    resumableIds.push(id);
    // Two pending stages deliberately prove that the selector emits one row per run rather than one
    // row per outstanding stage.
    insertStage.run(id, "search_projection", 0, "pending", AT);
    insertStage.run(id, "identity_resolution", 1, "pending", AT);
  }
  const runningIds: number[] = [];
  for (let i = 0; i < running; i += 1) {
    const result = insertRun.run(`running-${i}`, OLD, null, "running", "");
    runningIds.push(Number(result.lastInsertRowid));
  }
  // A recent running row is in the partial index but must be excluded by the cutoff range.
  insertRun.run("running-recent", AT, null, "running", "");
  sqlite.exec("COMMIT");

  const recording = recordingDatabase(inner);
  return { sqlite, db: recording.db, executed: recording.executed, resumableIds, runningIds };
}

test("resumable recovery is driven by pending stage work, not crawl history", async () => {
  const { sqlite, db, executed, resumableIds } = seedRuns(10_000);

  const rows = await listResumableCrawlRuns(db, 10);

  assert.deepEqual(
    rows.map((row) => row.crawlRunId),
    resumableIds,
    "multiple pending stages from one run must not duplicate that run",
  );
  assert.equal(selects(executed).length, 1);
  assertNoGrowingTableScans(sqlite, executed, { label: "resumable crawl recovery" });
  assertNoSortBeforeLimit(sqlite, executed, "resumable crawl recovery");

  const plan = queryPlan(sqlite, selects(executed)[0]!);
  assert.ok(
    readsThroughIndex(plan, "s", "idx_crawl_run_stages_pending") ||
      readsThroughIndex(plan, "crawl_run_stages", "idx_crawl_run_stages_pending"),
    `pending stages must drive the selector:\n${plan.map((step) => step.detail).join("\n")}`,
  );
  assert.ok(
    !plan.some((step) => /^SCAN r\b/u.test(step.detail) || /^SCAN crawl_runs\b/u.test(step.detail)),
    `crawl_runs history became the driving scan:\n${plan.map((step) => step.detail).join("\n")}`,
  );
});

test("zero pending work does not inspect terminal crawl history", async () => {
  const { sqlite, db, executed } = seedRuns(10_000, { resumable: 0, running: 0 });

  assert.deepEqual(await listResumableCrawlRuns(db, 10), []);
  assertNoGrowingTableScans(sqlite, executed, { label: "empty resumable crawl recovery" });
  assertNoSortBeforeLimit(sqlite, executed, "empty resumable crawl recovery");

  const plan = queryPlan(sqlite, selects(executed)[0]!);
  assert.ok(
    readsThroughIndex(plan, "s", "idx_crawl_run_stages_pending") ||
      readsThroughIndex(plan, "crawl_run_stages", "idx_crawl_run_stages_pending"),
    `empty recovery must still enter through the pending-only index:\n${plan
      .map((step) => step.detail)
      .join("\n")}`,
  );
});

test("stalled recovery walks only the running partial index", async () => {
  const { sqlite, db, executed, runningIds } = seedRuns(10_000, { resumable: 0, running: 2 });

  const rows = await listStalledCrawlRuns(db, { startedBefore: CUTOFF, limit: 10 });

  assert.deepEqual(
    rows.map((row) => row.id),
    runningIds,
  );
  assertNoGrowingTableScans(sqlite, executed, { label: "stalled crawl recovery" });
  assertNoSortBeforeLimit(sqlite, executed, "stalled crawl recovery");
  const plan = queryPlan(sqlite, selects(executed)[0]!);
  assert.ok(
    readsThroughIndex(plan, "crawl_runs", "idx_crawl_runs_running_started_at"),
    `stalled recovery must use the running-only index:\n${plan
      .map((step) => step.detail)
      .join("\n")}`,
  );
});

test("crawl recovery access paths stay current-work sized at 100, 1k and 10k history", async () => {
  for (const terminalHistory of [100, 1_000, 10_000]) {
    const fixture = seedRuns(terminalHistory, { resumable: 1, running: 1 });

    const resumable = await listResumableCrawlRuns(fixture.db, 1);
    const stalled = await listStalledCrawlRuns(fixture.db, { startedBefore: CUTOFF, limit: 1 });

    assert.equal(
      resumable.length,
      1,
      `${terminalHistory}: resumable LIMIT must stop at current work`,
    );
    assert.equal(stalled.length, 1, `${terminalHistory}: stalled LIMIT must stop at current work`);
    assert.equal(
      selects(fixture.executed).length,
      2,
      `${terminalHistory}: statement count drifted`,
    );
    assertNoGrowingTableScans(fixture.sqlite, fixture.executed, {
      label: `${terminalHistory} terminal crawl rows`,
    });
    assertNoSortBeforeLimit(
      fixture.sqlite,
      fixture.executed,
      `${terminalHistory} terminal crawl rows`,
    );

    // Partial-index cardinality is the cost invariant that elapsed-time assertions cannot make
    // deterministic in CI. Terminal history is absent from both access paths by construction.
    const pendingIndexRows = Number(
      fixture.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM crawl_run_stages INDEXED BY idx_crawl_run_stages_pending WHERE status = 'pending'",
        )
        .get()?.count ?? 0,
    );
    const runningIndexRows = Number(
      fixture.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM crawl_runs INDEXED BY idx_crawl_runs_running_started_at WHERE status = 'running'",
        )
        .get()?.count ?? 0,
    );
    assert.equal(
      pendingIndexRows,
      2,
      `${terminalHistory}: pending index grew with terminal history`,
    );
    assert.equal(
      runningIndexRows,
      2,
      `${terminalHistory}: running index grew with terminal history`,
    );
  }
});
