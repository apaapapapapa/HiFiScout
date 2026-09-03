import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { test } from "vite-plus/test";

test("detail enrichment DB usage is emitted once across finalization retries", async () => {
  const source = await readFile(
    new URL("../src/crawler/crawl-scheduler-do.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /detailDbUsageLogged\?: boolean;/);

  const completionStart = source.indexOf("if (!targetUrl) {");
  const nextBranchStart = source.indexOf(
    "if (execution.detailTargetUrl && execution.detailTargetUrl !== targetUrl)",
    completionStart,
  );

  assert.ok(completionStart >= 0, "detail-plan completion branch must exist");
  assert.ok(nextBranchStart > completionStart, "detail-plan completion branch must be bounded");

  const completionBranch = source.slice(completionStart, nextBranchStart);
  const retryGuardIndex = completionBranch.indexOf(
    "if (execution.detailDbUsageLogged) return false;",
  );
  const clearIndex = completionBranch.indexOf("execution.detailDbUsage = undefined;");
  const markLoggedIndex = completionBranch.indexOf("execution.detailDbUsageLogged = true;");
  const persistIndex = completionBranch.indexOf(
    "await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, execution);",
  );
  const metricIndex = completionBranch.indexOf('event: "detail_enrichment_db_usage"');

  assert.ok(retryGuardIndex >= 0, "already-emitted completion metrics must be skipped on retry");
  assert.ok(clearIndex > retryGuardIndex, "the first completion must clear accumulated usage");
  assert.ok(markLoggedIndex > clearIndex, "the first completion must set the durable emitted marker");
  assert.ok(persistIndex > markLoggedIndex, "the emitted marker must be persisted before logging");
  assert.ok(metricIndex > persistIndex, "metric must be emitted only after persisted consumption");
});
