import test from "node:test";
import assert from "node:assert/strict";

import {
  latestKnowledgeCatalogReviewRunState,
  startKnowledgeCatalogRecoveryReviewRun,
} from "../src/db/knowledge-catalog-review-repository.js";
import { deadLetterOutstandingKnowledgeCatalogVerificationJobsForRun } from "../src/db/knowledge-catalog-verification-queue-repository.js";
import { queueDatabase } from "./helpers/knowledge-queue.js";

test("failed review recovery is claimed by one atomic successor insert", async () => {
  const db = queueDatabase((sql) => {
    if (sql.includes("SELECT id, status, message")) {
      return { row: { id: 13, status: "failed", message: "finalizer exhausted" } };
    }
    if (sql.includes("INSERT INTO knowledge_catalog_review_runs")) {
      return { changes: 1, lastRowId: 14 };
    }
    return {};
  });
  assert.deepEqual(await latestKnowledgeCatalogReviewRunState(db), {
    id: 13,
    status: "failed",
    message: "finalizer exhausted",
  });
  assert.equal(
    await startKnowledgeCatalogRecoveryReviewRun(db, 13, "2026-08-18T12:00:00.000Z"),
    14,
  );
  const insert = db.ran("INSERT INTO knowledge_catalog_review_runs")[0];
  assert.ok(insert.sql.includes("NOT EXISTS"));
  assert.deepEqual(insert.binds.slice(-2), [13, 13]);
});

test("failed review recovery closes every stranded non-terminal queue row", async () => {
  const db = queueDatabase((sql) =>
    sql.includes("status IN ('queued', 'processing', 'retrying')") ? { changes: 3 } : {},
  );
  const count = await deadLetterOutstandingKnowledgeCatalogVerificationJobsForRun(
    db,
    13,
    "2026-08-18T12:00:00.000Z",
    "abandoned_after_failed_run:13",
  );
  assert.equal(count, 3);
  const update = db.ran("status IN ('queued', 'processing', 'retrying')")[0];
  assert.equal(update.binds.at(-1), 13);
  assert.ok(update.sql.includes("status = 'dead_letter'"));
  assert.ok(update.sql.includes("lease_expires_at = NULL"));
});
