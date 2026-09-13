import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isRecord } from "../../src/types.js";
import { readCheckout } from "./checkpoint.js";
import { repositoryArtifact } from "./artifacts.js";
import { assessHarnessReport, type CheckStatus } from "./report.js";

export function playwrightOutcome(value: unknown): CheckStatus {
  if (!isRecord(value) || !isRecord(value.stats) || !Array.isArray(value.errors)) return "unknown";
  const { expected, unexpected, skipped, flaky } = value.stats;
  if (
    ![expected, unexpected, skipped, flaky].every(
      (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    )
  )
    return "unknown";
  if (value.errors.length || Number(unexpected)) return "fail";
  if (Number(skipped) || (!Number(expected) && !Number(flaky))) return "unknown";
  return "pass";
}

/** Runs only the existing loopback suites; E2E_BASE_URL is deliberately irrelevant. */
export async function runUi(directory: string) {
  const output = resolve(directory);
  repositoryArtifact(resolve(output, "ui-report.json"));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Require a fresh directory: stale screenshots/reports cannot prove success.
  const startedAt = new Date().toISOString(),
    checkout = readCheckout();
  const env = { ...process.env, HARNESS_UI: "1", HARNESS_UI_OUTPUT: output };
  const execute = async (id: string, args: string[]) => {
    const result = spawnSync("vp", args, {
      env,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    await writeFile(resolve(output, `${id}.log`), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return result.error || result.signal ? null : result.status;
  };
  const build = await execute("build-admin", ["run", "build:frontend:admin"]);
  const checks = [];
  for (const suite of ["components", "admin"]) {
    const exit =
      suite === "admin" && build !== 0
        ? null
        : await execute(suite, [
            "exec",
            "playwright",
            "test",
            "--config",
            `e2e/playwright.${suite}.config.ts`,
          ]);
    let status: CheckStatus = "unknown";
    try {
      status = playwrightOutcome(
        JSON.parse(await readFile(resolve(output, suite, "results.json"), "utf8")),
      );
    } catch {
      /* A missing report cannot establish success. The runner log retains the error. */
    }
    if (exit === null) status = "unknown";
    else if (exit !== 0) status = "fail";
    const current = readCheckout();
    if (checkout.dirty || current.dirty || checkout.sourceSha !== current.sourceSha)
      status = "unknown";
    checks.push({
      id: `ui/${suite}`,
      scope: "source",
      required: true,
      status,
      reason: "isolated local browser suite; inspect results.json and per-test evidence",
      evidence: [
        {
          uri: repositoryArtifact(resolve(output, suite, "results.json")),
          sourceSha: checkout.sourceSha,
        },
      ],
    });
  }
  const report = assessHarnessReport({
    schemaVersion: 1,
    runId: `ui-${checkout.sourceSha}`,
    sourceSha: checkout.sourceSha,
    baselineSha: null,
    deploymentSha: null,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  });
  await writeFile(resolve(output, "ui-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
