import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isRecord } from "../../src/types.js";
import { readCheckout } from "./checkpoint.js";
import { repositoryArtifact } from "./artifacts.js";
import { assessHarnessReport, requireSha, requireText, type CheckStatus } from "./report.js";

/** Reuse incident regressions and their real assertions; never replace them with model scoring. */
export const REPLAY_SUITES: Record<string, string> = {
  "test/parser.test.ts": "extraction",
  "test/product-data-audit-parser-regressions.test.ts": "extraction",
  "test/model-resolver-shop-inputs.test.ts": "normalization",
  "test/decision-quality.test.ts": "classification",
  "test/product-identity.test.ts": "identity",
  "test/product-identity-versioning.test.ts": "identity",
  "test/model-color-variant-grouping.test.ts": "identity",
  "test/remediation-search-integration.test.ts": "search",
  "test/manufacturer-text-search.test.ts": "search",
  "test/product-presentation-color-override.test.ts": "admin-override",
  "test/manual-category-override-budget.test.ts": "admin-override",
};

export interface ReplayCase {
  id: string;
  stage: string;
  status: CheckStatus;
  failures: string[];
}

export interface ReplayResult {
  schemaVersion: 1;
  kind: "product-replay";
  sourceSha: string;
  corpusHash: string;
  environment: "local-test";
  cases: ReplayCase[];
  missingSuites: string[];
  checkoutStable: boolean;
}

export async function replayCorpusHash(): Promise<string> {
  const files = execFileSync("git", ["ls-files", "-z", "test/fixtures", "test/helpers"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const hash = createHash("sha256").update(JSON.stringify(REPLAY_SUITES));
  for (const path of [...new Set([...files, ...Object.keys(REPLAY_SUITES)])].sort()) {
    hash
      .update(path)
      .update("\0")
      .update(await readFile(path))
      .update("\0");
  }
  return hash.digest("hex");
}

export function collectReplayCases(
  reports: unknown[],
  suites: Record<string, string> = REPLAY_SUITES,
) {
  const cases: ReplayCase[] = [];
  const seenSuites = new Set<string>();
  for (const report of reports) {
    if (!isRecord(report) || !Array.isArray(report.testResults))
      throw new Error("invalid_test_report");
    for (const suite of report.testResults) {
      if (!isRecord(suite) || typeof suite.name !== "string") throw new Error("invalid_test_suite");
      const normalized = suite.name.replaceAll("\\", "/");
      const file = Object.keys(suites).find(
        (path) => normalized === path || normalized.endsWith(`/${path}`),
      );
      if (!file) continue;
      if (seenSuites.has(file)) throw new Error(`duplicate_replay_suite: ${file}`);
      if (!Array.isArray(suite.assertionResults)) throw new Error("invalid_test_assertions");
      if (suite.assertionResults.length) seenSuites.add(file);
      // Suite setup/teardown can fail after every assertion passed. Keep that outcome too.
      cases.push({
        id: `${file}::<suite>`,
        stage: suites[file],
        status: suite.status === "failed" ? "fail" : suite.status === "passed" ? "pass" : "unknown",
        failures: typeof suite.message === "string" && suite.message ? [suite.message] : [],
      });
      for (const assertion of suite.assertionResults) {
        if (!isRecord(assertion) || !Array.isArray(assertion.failureMessages))
          throw new Error("invalid_test_assertion");
        const status =
          assertion.status === "passed"
            ? "pass"
            : assertion.status === "failed"
              ? "fail"
              : "unknown";
        cases.push({
          id: `${file}::${requireText(assertion.fullName, "case_name")}`,
          stage: suites[file],
          status,
          failures: assertion.failureMessages.map((message) =>
            requireText(message, "failure_message"),
          ),
        });
      }
    }
  }
  if (new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new Error("duplicate_replay_case");
  return {
    cases: cases.sort((a, b) => a.id.localeCompare(b.id)),
    missingSuites: Object.keys(suites).filter((file) => !seenSuites.has(file)),
  };
}

export function replayReport(
  result: ReplayResult,
  startedAt: string,
  finishedAt: string,
  artifactUri = "replay.json",
) {
  return assessHarnessReport({
    schemaVersion: 1,
    runId: `replay-${result.sourceSha}`,
    sourceSha: result.sourceSha,
    baselineSha: null,
    deploymentSha: null,
    startedAt,
    finishedAt,
    checks: [...new Set(Object.values(REPLAY_SUITES))].map((stage) => {
      const cases = result.cases.filter((item) => item.stage === stage);
      const missing = result.missingSuites.filter((file) => REPLAY_SUITES[file] === stage);
      const failed = cases.filter((item) => item.status === "fail").length;
      const status = !result.checkoutStable
        ? "unknown"
        : failed
          ? "fail"
          : missing.length || !cases.length || cases.some((item) => item.status !== "pass")
            ? "unknown"
            : "pass";
      return {
        id: `replay/${stage}`,
        required: true,
        scope: "source",
        status,
        reason: !result.checkoutStable
          ? "checkout_changed_or_dirty"
          : `${cases.length} assertions; ${failed} failed; ${missing.length} missing suites; local fixture behavior only`,
        evidence: [{ uri: artifactUri, sourceSha: result.sourceSha }],
      };
    }),
  });
}

function parseReplay(value: unknown): ReplayResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "product-replay" ||
    value.environment !== "local-test" ||
    !Array.isArray(value.cases) ||
    !Array.isArray(value.missingSuites) ||
    typeof value.checkoutStable !== "boolean" ||
    typeof value.corpusHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.corpusHash)
  )
    throw new Error("invalid_replay");
  const cases = value.cases.map((item): ReplayCase => {
    if (
      !isRecord(item) ||
      !["pass", "fail", "unknown", "skipped"].includes(String(item.status)) ||
      !Array.isArray(item.failures)
    )
      throw new Error("invalid_replay_case");
    const id = requireText(item.id, "case_id");
    const file = id.split("::")[0];
    if (REPLAY_SUITES[file] !== item.stage) throw new Error("invalid_replay_stage");
    return {
      id,
      stage: String(item.stage),
      status: item.status as CheckStatus,
      failures: item.failures.map((message) => requireText(message, "failure_message")),
    };
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new Error("duplicate_replay_case");
  return {
    schemaVersion: 1,
    kind: "product-replay",
    sourceSha: requireSha(value.sourceSha),
    corpusHash: value.corpusHash,
    environment: "local-test",
    checkoutStable: value.checkoutStable,
    cases,
    missingSuites: value.missingSuites.map((file) => requireText(file, "suite")),
  };
}

export function compareReplays(beforeValue: unknown, afterValue: unknown) {
  const before = parseReplay(beforeValue),
    after = parseReplay(afterValue);
  const previous = new Map(before.cases.map((item) => [item.id, item]));
  const complete = (value: ReplayResult) =>
    value.checkoutStable &&
    !value.missingSuites.length &&
    Object.keys(REPLAY_SUITES).every((file) =>
      value.cases.some((item) => item.id.startsWith(`${file}::`)),
    ) &&
    value.cases.every((item) => item.status === "pass" || item.status === "fail");
  const comparable =
    complete(before) &&
    complete(after) &&
    before.corpusHash === after.corpusHash &&
    previous.size === after.cases.length &&
    after.cases.every((item) => previous.has(item.id));
  const regressions = comparable
    ? after.cases.filter(
        (item) => previous.get(item.id)!.status === "pass" && item.status === "fail",
      )
    : [];
  const improvements = comparable
    ? after.cases.filter(
        (item) => previous.get(item.id)!.status === "fail" && item.status === "pass",
      )
    : [];
  return {
    baselineSha: before.sourceSha,
    sourceSha: after.sourceSha,
    status: !comparable
      ? ("unknown" as const)
      : regressions.length
        ? ("fail" as const)
        : ("pass" as const),
    comparable,
    reason: comparable
      ? "same_fixed_cases_and_corpus; pre-existing failures remain visible in candidate report"
      : "changed_or_incomplete_corpus_or_checkout",
    regressions,
    improvements,
  };
}

/** Imports only reports produced by the current CI job graph, or executes a fresh local replay. */
export async function runReplay(outputDirectory: string, reportPaths: string[] = []) {
  const startedAt = new Date().toISOString();
  const checkout = readCheckout();
  const corpusHash = await replayCorpusHash();
  const directory = resolve(outputDirectory);
  const artifactUri = repositoryArtifact(resolve(directory, "replay.json"));
  await mkdir(directory, { recursive: true });
  if (!reportPaths.length) {
    const reportPath = resolve(directory, "vitest.json");
    // A new filename prevents a failed process from reusing a prior passing report.
    const { rm } = await import("node:fs/promises");
    await rm(reportPath, { force: true });
    const execution = spawnSync(
      "vp",
      [
        "test",
        "run",
        ...Object.keys(REPLAY_SUITES),
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      { encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
    );
    await writeFile(
      resolve(directory, "runner.log"),
      `${execution.stdout ?? ""}\n${execution.stderr ?? ""}`,
    );
    if (execution.error || execution.signal || (execution.status !== 0 && execution.status !== 1))
      throw new Error("replay_process_failed; inspect runner.log");
    reportPaths = [reportPath];
  }
  const reports: unknown[] = await Promise.all(
    reportPaths.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  const current = readCheckout();
  const result: ReplayResult = {
    schemaVersion: 1,
    kind: "product-replay",
    sourceSha: checkout.sourceSha,
    corpusHash,
    environment: "local-test",
    ...collectReplayCases(reports),
    checkoutStable:
      !checkout.dirty &&
      !current.dirty &&
      checkout.sourceSha === current.sourceSha &&
      corpusHash === (await replayCorpusHash()),
  };
  const report = replayReport(result, startedAt, new Date().toISOString(), artifactUri);
  await writeFile(resolve(directory, "replay.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(resolve(directory, "replay-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
