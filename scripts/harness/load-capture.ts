import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readCheckout } from "./checkpoint.js";
import { repositoryArtifact } from "./artifacts.js";
import { costReport, REQUIRED_COST_SAMPLES } from "./cost.js";
import { LOAD_CAPTURE_SUITES, LOAD_CONTRACTS } from "./load-contracts.js";
import { reportExitCode } from "./report.js";

/** Fresh local fixtures only. No production credentials or seller calls are needed. */
export async function captureLoad(directory: string): Promise<number> {
  repositoryArtifact(join(directory, "capture.json"));
  const checkout = readCheckout();
  if (checkout.dirty) throw new Error("load_capture_requires_clean_checkout");
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory); // Never merge samples from an earlier execution.
  const samples = join(directory, "samples");
  const env = { ...process.env, HARNESS_COST_OUTPUT: resolve(samples) };
  const test = spawnSync(
    "vp",
    [
      "test",
      "run",
      ...LOAD_CAPTURE_SUITES,
      "--maxWorkers=2",
      "--reporter=dot",
      "--reporter=json",
      `--outputFile.json=${join(directory, "tests.json")}`,
    ],
    { env, encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  await writeFile(join(directory, "tests.log"), `${test.stdout ?? ""}\n${test.stderr ?? ""}`);
  const parser = spawnSync("vp", ["run", "benchmark:parser"], {
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(join(directory, "parser.log"), `${parser.stdout ?? ""}\n${parser.stderr ?? ""}`);
  const report = await costReport(samples, join(directory, "cost-report.json"));
  const after = readCheckout();
  const status =
    test.status !== 0 || parser.status !== 0
      ? "fail"
      : after.dirty || checkout.sourceSha !== after.sourceSha
        ? "unknown"
        : report.status;
  await writeFile(
    join(directory, "capture.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        sourceSha: checkout.sourceSha,
        status,
        testExit: test.status,
        parserExit: parser.status,
        recordedAt: new Date().toISOString(),
        requiredSamples: REQUIRED_COST_SAMPLES,
        contracts: LOAD_CONTRACTS,
        productionCpuP95Ms: null,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ status, sourceSha: checkout.sourceSha, directory }));
  return reportExitCode(status);
}
