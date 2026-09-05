import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const convergenceScriptPath = "scripts/wait-for-active-crawl-convergence.sh";
const workflowPath = ".github/workflows/production-operational-health.yml";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("active crawl convergence gate is valid bash", () => {
  execFileSync("bash", ["-n", convergenceScriptPath], { stdio: "pipe" });
});

test("active crawl convergence gate waits only for identity gaps owned by active crawl sessions", () => {
  const script = read(convergenceScriptPath);

  assert.match(script, /s\.status IN \('collecting', 'finalizing'\)/);
  assert.match(script, /p\.shop_key = s\.shop_key/);
  assert.match(script, /p\.is_active = 1/);
  assert.match(script, /r\.listing_product_id IS NULL/);
  assert.match(script, /ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS:-480/);
  assert.match(script, /continuing to the strict health checks/);
  assert.doesNotMatch(script, /exit 1\s*#.*convergence/i);
});

test("production operational health runs convergence gate before strict checks", () => {
  const workflow = read(workflowPath);
  const waitIndex = workflow.indexOf("bash scripts/wait-for-active-crawl-convergence.sh");
  const strictIndex = workflow.indexOf("bash scripts/production-operational-health.sh");

  assert.ok(waitIndex >= 0, "workflow must invoke the active-crawl convergence gate");
  assert.ok(strictIndex > waitIndex, "strict production health must run after convergence wait");
  assert.match(workflow, /data-platform:[\s\S]*?timeout-minutes: 35/);
});

test("consecutive operational checks share one cron wait and then recheck without sleeping again", () => {
  const directory = mkdtempSync(join(tmpdir(), "projection-window-"));
  const clock = join(directory, "clock");
  const sleeps = join(directory, "sleeps");
  const deadline = join(directory, "deadline");
  try {
    writeFileSync(clock, "100\n");
    writeFileSync(sleeps, "");
    writeFileSync(join(directory, "date"), '#!/bin/sh\ncat "$TEST_CLOCK"\n', { mode: 0o755 });
    writeFileSync(
      join(directory, "sleep"),
      '#!/bin/sh\necho "$1" >> "$TEST_SLEEPS"\nnow=$(cat "$TEST_CLOCK")\necho "$((now + $1))" > "$TEST_CLOCK"\n',
      { mode: 0o755 },
    );
    const run = () =>
      execFileSync("bash", [resolve(convergenceScriptPath), "--projection-grace"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          TEST_CLOCK: clock,
          TEST_SLEEPS: sleeps,
          PROJECTION_CONVERGENCE_STATE_FILE: deadline,
          GENERAL_CRON_INTERVAL_SECONDS: "300",
          PROJECTION_REPAIR_GRACE_SECONDS: "45",
        },
      });
    run();
    run();
    run();
    assert.equal(readFileSync(deadline, "utf8"), "345\n");
    assert.equal(readFileSync(sleeps, "utf8"), "245\n");
    writeFileSync(deadline, "invalid\n");
    assert.throws(run, /Invalid shared projection convergence deadline/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
