import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { runRetentionCleanup } from "../src/maintenance.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { queryPlan, readsThroughIndex, recordingDatabase } from "./helpers/query-plan.js";
import type { ExecutedStatement } from "./helpers/query-plan.js";

/**
 * The retention drain's plan, checked the way `remediation-query-plans.test.ts` checks the hot path.
 *
 * Retention used to be one capped statement per table per day, where a full read was affordable
 * whatever it cost. The remediation queue's drain is not that: it pages, so its selection runs once
 * per batch, and an unindexed predicate there is multiplied by the number of pages. That turns the
 * change meant to bound this table into the largest single burst of the maintenance invocation,
 * which is precisely the failure being fixed.
 */

/** The queue's settled rows, which the drain pages through. */
const RESOLVED_RETENTION_INDEX = "idx_dq_remediation_queue_resolved";

/** The inner selection is what gets planned; the delete wraps it in `WHERE id IN (...)`. */
function remediationDrainSelect(executed: readonly ExecutedStatement[]): ExecutedStatement {
  const statement = executed.find((candidate) =>
    /DELETE FROM data_quality_remediation_queue/.test(candidate.sql),
  );
  assert.ok(statement, "expected the retention cleanup to page the remediation queue");
  const inner = /SELECT[\s\S]*?LIMIT \?/.exec(statement.sql);
  assert.ok(inner, "expected the drain to select the rows it deletes");
  return { sql: inner[0], binds: statement.binds };
}

test("the remediation retention drain pages through an index instead of rescanning", async () => {
  const { sqlite, db } = migratedSqlite();
  const recording = recordingDatabase(db);

  await runRetentionCleanup({ DB: recording.db }, { now: new Date("2026-08-28T00:00:00.000Z") });

  const plan = queryPlan(sqlite, remediationDrainSelect(recording.executed));

  // Reading through *some* index is not enough. Before this index existed the planner reached for
  // `idx_dq_remediation_queue_listing` and then sorted into a temp b-tree — a full read plus a sort,
  // once per page.
  assert.ok(
    readsThroughIndex(plan, "data_quality_remediation_queue", RESOLVED_RETENTION_INDEX),
    `expected the drain to use ${RESOLVED_RETENTION_INDEX}, got:\n  ${plan
      .map((step) => step.detail)
      .join("\n  ")}`,
  );
  assert.ok(
    !plan.some((step) => /TEMP B-TREE/.test(step.detail)),
    "the index has to deliver the drain's order, or every page pays for a sort",
  );
});
