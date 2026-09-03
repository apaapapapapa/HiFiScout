import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { test } from "vite-plus/test";

test("detail enrichment DB usage is durably consumed before metric emission", async () => {
  const source = await readFile(
    new URL("../src/crawler/crawl-scheduler-do.ts", import.meta.url),
    "utf8",
  );
  const completionStart = source.indexOf("if (!targetUrl) {");
  const nextBranchStart = source.indexOf(
    "if (execution.detailTargetUrl && execution.detailTargetUrl !== targetUrl)",
    completionStart,
  );

  assert.ok(completionStart >= 0, "detail-plan completion branch must exist");
  assert.ok(nextBranchStart > completionStart, "detail-plan completion branch must be bounded");

  const completionBranch = source.slice(completionStart, nextBranchStart);
  const clearIndex = completionBranch.indexOf("execution.detailDbUsage = undefined;");
  const persistIndex = completionBranch.indexOf(
    "await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, execution);",
  );
  const metricIndex = completionBranch.indexOf('event: "detail_enrichment_db_usage"');

  assert.ok(clearIndex >= 0, "completed detail DB usage must be cleared");
  assert.ok(persistIndex > clearIndex, "cleared detail DB usage must be persisted");
  assert.ok(metricIndex > persistIndex, "metric must be emitted only after persisted consumption");
});
