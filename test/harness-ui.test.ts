import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { playwrightOutcome } from "../scripts/harness/ui.js";

test("browser completion requires final Playwright results including teardown and discovery errors", () => {
  const success = { stats: { expected: 10, unexpected: 0, skipped: 0, flaky: 0 }, errors: [] };
  assert.equal(playwrightOutcome(success), "pass");
  assert.equal(
    playwrightOutcome({ ...success, errors: [{ message: "server teardown failed" }] }),
    "fail",
  );
  assert.equal(
    playwrightOutcome({ ...success, stats: { ...success.stats, unexpected: 1 } }),
    "fail",
  );
  assert.equal(
    playwrightOutcome({ ...success, stats: { ...success.stats, skipped: 1 } }),
    "unknown",
  );
  assert.equal(
    playwrightOutcome({ ...success, stats: { ...success.stats, expected: 0 } }),
    "unknown",
  );
  assert.equal(playwrightOutcome({ stats: success.stats }), "unknown");
});
