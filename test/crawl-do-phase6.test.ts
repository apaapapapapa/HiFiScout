import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

test("direct origin pacing survives non-fetch transitions before detail preparation", () => {
  const scheduler = readFileSync(
    new URL("../src/crawler/crawl-scheduler-do.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    scheduler,
    /const nextOriginNotBeforeMs = directPermit[\s\S]*?: activeExecution\.nextOriginNotBeforeMs;/,
  );
  assert.match(
    scheduler,
    /Date\.now\(\) < execution\.nextOriginNotBeforeMs[\s\S]*?setAlarm\(alarmAt\(execution\.nextOriginNotBeforeMs\)\)/,
  );
});
