import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  buildCrawlSchedulerObserveCommand,
  selectedCrawlDoShadowShops,
  shouldObserveCrawlWithDurableObject,
} from "../src/crawler/orchestration.js";

test("phase 1 DO selection is an explicit shop allowlist", () => {
  assert.deepEqual(
    [...selectedCrawlDoShadowShops(" home-shokai, ippinkan ,,home-shokai ")],
    ["home-shokai", "ippinkan"],
  );
  assert.equal(shouldObserveCrawlWithDurableObject("home-shokai,ippinkan", "home-shokai"), true);
  assert.equal(shouldObserveCrawlWithDurableObject("home-shokai,ippinkan", "hifido"), false);
  assert.equal(shouldObserveCrawlWithDurableObject("", "home-shokai"), false);
});

test("phase 1 DO selection does not infer routing from lane or workload", () => {
  // Only the explicit shop key list is accepted by the selector. Strings that look like the old
  // operational lane names are ordinary non-matching shop keys, so heavy/relay classification can
  // never become an orchestration boundary by accident.
  assert.equal(shouldObserveCrawlWithDurableObject("heavy,relay", "ippinkan"), false);
  assert.equal(shouldObserveCrawlWithDurableObject("ippinkan", "ippinkan"), true);
});

test("checkpoint observation command keeps a stable dispatch identity", () => {
  const command = buildCrawlSchedulerObserveCommand({
    shopKey: "home-shokai",
    requestedAt: "2026-08-30T00:00:00.000Z",
  });

  assert.equal(command.schemaVersion, 1);
  assert.equal(command.type, "observe_checkpoint");
  assert.equal(command.shopKey, "home-shokai");
  assert.equal(command.requestedAt, "2026-08-30T00:00:00.000Z");
  assert.equal(command.jobId, command.runId);
});

test("existing collection run identity is preserved for shadow observation", () => {
  const command = buildCrawlSchedulerObserveCommand({
    shopKey: "ippinkan",
    requestedAt: "2026-08-30T00:00:00.000Z",
    jobId: "dispatch-token",
    collectionRunId: "collection-run",
  });

  assert.equal(command.jobId, "dispatch-token");
  assert.equal(command.runId, "collection-run");
});
