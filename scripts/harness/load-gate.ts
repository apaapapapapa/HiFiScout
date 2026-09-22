import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord } from "../../src/types.js";
import {
  assessCostBudget,
  compareCosts,
  parseCostSample,
  readCostSamples,
  REQUIRED_COST_SAMPLES,
} from "./cost.js";
import type { CostSample } from "./cost.js";
import { LOAD_CONTRACTS } from "./load-contracts.js";
import { comparePairedCpu, readPairedCpu } from "./load-cpu.js";
import type { LoadContract } from "./load-contracts.js";
import { collectReplayCases } from "./replay.js";
import { readCheckout } from "./checkpoint.js";
import { repositoryArtifact } from "./artifacts.js";
import { requireSha, reportExitCode } from "./report.js";

export interface LoadReview {
  id: string;
  baseSha: string;
  beforeDigest: string;
  afterDigest: string;
  reason: string;
  evidence: string[];
}

/** The review binds observations/profiles/ceilings, never a mutable branch name or a blanket waiver. */
export function loadDigest(value: unknown): string {
  function sorted(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sorted);
    if (isRecord(v))
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sorted(v[k])]),
      );
    return v;
  }
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}

export function sampleReviewDigest(
  sample: CostSample | undefined,
  contracts: LoadContract[],
): string {
  if (!sample) return loadDigest(null);
  const limits =
    contracts.flatMap((c) => Object.entries(c.samples)).find(([id]) => id === sample.id)?.[1]
      .limits ?? null;
  // CPU values vary; the profile still seals the benchmark source and its absolute CPU gate.
  return loadDigest({
    id: sample.id,
    profileHash: sample.profileHash,
    environment: sample.environment,
    limits,
    metrics: sample.id.startsWith("cpu-")
      ? "relative_cpu_measured_with_existing_noise_gate"
      : sample.metrics,
  });
}

export function parseLoadReviews(value: unknown): LoadReview[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.reviews))
    throw new Error("invalid_load_reviews");
  const result = value.reviews.map((r): LoadReview => {
    if (
      !isRecord(r) ||
      typeof r.id !== "string" ||
      typeof r.reason !== "string" ||
      r.reason.trim().length < 30 ||
      typeof r.beforeDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(r.beforeDigest) ||
      typeof r.afterDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(r.afterDigest) ||
      !Array.isArray(r.evidence) ||
      !r.evidence.length ||
      r.evidence.some(
        (e) =>
          typeof e !== "string" ||
          !/^https:\/\/github\.com\/apaapapapapa\/HiFiScout\/(actions\/runs|pull|blob)\//.test(e),
      )
    )
      throw new Error("invalid_load_review");
    return {
      id: r.id,
      baseSha: requireSha(r.baseSha),
      beforeDigest: r.beforeDigest,
      afterDigest: r.afterDigest,
      reason: r.reason,
      evidence: r.evidence as string[],
    };
  });
  if (new Set(result.map((r) => `${r.baseSha}/${r.id}`)).size !== result.length)
    throw new Error("duplicate_load_review");
  return result;
}

function matches(path: string, pattern: string): boolean {
  return new RegExp(
    `^${pattern
      .split("*")
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(path);
}

export function isLoadSensitive(path: string, source = ""): boolean {
  return (
    /^(src\/(db|crawler|knowledge-catalog|knowledge-catalog-export|product-audit-export|ai-suggestions)\/|src\/(scheduled|maintenance|config|worker)\.ts$|migrations\/|wrangler.*\.jsonc$)/.test(
      path,
    ) ||
    (path.startsWith("src/") &&
      /\.(?:prepare|batch|sendBatch|setAlarm)\s*\(|\.DB\b|\.storage\b/.test(source))
  );
}

export function loadCoverage(
  paths: string[],
  contracts: LoadContract[],
  sources: Record<string, string> = {},
) {
  const selected = new Set<string>(),
    uncovered: string[] = [];
  for (const path of paths) {
    const owners = contracts.filter(
      (c) => c.sources.some((p) => matches(path, p)) || c.suites.includes(path),
    );
    owners.forEach((c) => selected.add(c.id));
    if (!owners.length && isLoadSensitive(path, sources[path])) uncovered.push(path);
  }
  return { contracts: contracts.filter((c) => selected.has(c.id)), uncovered };
}

function suiteResult(reports: unknown[], contracts: LoadContract[], extra: string[] = []) {
  const suites = Object.fromEntries(
    [...contracts.flatMap((c) => c.suites), ...extra].map((s) => [s, "load"]),
  );
  const result = collectReplayCases(reports, suites);
  return {
    ...result,
    status: result.cases.some((c) => c.status === "fail")
      ? "fail"
      : result.missingSuites.length || result.cases.some((c) => c.status !== "pass")
        ? "unknown"
        : "pass",
  };
}

export interface LoadGateInput {
  baseSha: string;
  sourceSha: string;
  checkoutClean: boolean;
  before: unknown[];
  after: unknown[];
  beforeContracts: LoadContract[];
  afterContracts: LoadContract[];
  beforeRequired: string[];
  afterRequired: string[];
  beforeReports: unknown[];
  afterReports: unknown[];
  changedPaths: string[];
  sources?: Record<string, string>;
  reviews: LoadReview[];
  guardSuites?: string[];
  pairedCpu?: boolean;
}

export function evaluateLoadGate(input: LoadGateInput) {
  requireSha(input.baseSha);
  requireSha(input.sourceSha);
  const before = input.before.map(parseCostSample),
    after = input.after.map(parseCostSample);
  const problems: string[] = [];
  if (!input.checkoutClean) problems.push("dirty_candidate");
  for (const [samples, sha, label] of [
    [before, input.baseSha, "baseline"],
    [after, input.sourceSha, "candidate"],
  ] as const) {
    if (new Set(samples.map((s) => s.id)).size !== samples.length)
      problems.push(`${label}_duplicate_samples`);
    if (samples.some((s) => s.sourceSha !== sha || !s.checkoutClean))
      problems.push(`${label}_source_mismatch`);
  }
  const coverage = loadCoverage(input.changedPaths, input.afterContracts, input.sources);
  problems.push(...coverage.uncovered.map((p) => `unregistered_load_boundary:${p}`));
  const baselineTests = suiteResult(input.beforeReports, input.beforeContracts);
  const candidateTests = suiteResult(input.afterReports, input.afterContracts, input.guardSuites);
  if (baselineTests.status !== "pass") problems.push(`baseline_tests_${baselineTests.status}`);
  if (candidateTests.status !== "pass") problems.push(`candidate_tests_${candidateTests.status}`);
  const acceptedReviews: LoadReview[] = [];
  function reviewed(id: string, beforeDigest: string, afterDigest: string): boolean {
    const review = input.reviews.find(
      (r) =>
        r.id === id &&
        r.baseSha === input.baseSha &&
        r.beforeDigest === beforeDigest &&
        r.afterDigest === afterDigest,
    );
    if (review) acceptedReviews.push(review);
    return Boolean(review);
  }
  const oldPolicy = loadDigest(input.beforeContracts),
    newPolicy = loadDigest(input.afterContracts);
  if (oldPolicy !== newPolicy && !reviewed("load-contracts", oldPolicy, newPolicy))
    problems.push("load_policy_change_requires_evidence_review");
  const rows = [];
  for (const id of new Set([...input.beforeRequired, ...input.afterRequired])) {
    const old = before.find((s) => s.id === id),
      current = after.find((s) => s.id === id);
    const budget = input.afterContracts
      .flatMap((c) => Object.entries(c.samples))
      .find(([key]) => key === id)?.[1];
    if (!current || (!old && input.beforeRequired.includes(id))) {
      problems.push(`missing_sample:${id}`);
      continue;
    }
    if (!budget && !id.startsWith("cpu-")) problems.push(`missing_absolute_budget:${id}`);
    if (id.startsWith("cpu-") && current.environment !== "local-node")
      problems.push(`cpu_measurement_environment:${id}`);
    if (
      budget &&
      (current.environment !== budget.environment ||
        assessCostBudget(current.metrics, budget.limits) !== "pass")
    )
      problems.push(`absolute_budget_or_measurement:${id}`);
    const comparison = old
      ? input.pairedCpu && id.startsWith("cpu-")
        ? comparePairedCpu(old, current)
        : compareCosts([old], [current])
      : null;
    // Missing metrics cannot be waived. A new case can only establish a reviewed initial baseline.
    const metricKeys = [
      ...new Set([
        ...Object.keys(current.metrics),
        ...Object.keys(old?.metrics ?? {}),
        ...Object.keys(budget?.limits ?? {}),
        ...(id.startsWith("cpu-") ? ["cpuUs", "cpuRelative"] : []),
      ]),
    ];
    const complete = metricKeys.every(
      (k) =>
        typeof current.metrics[k as keyof typeof current.metrics] === "number" &&
        (!old || typeof old.metrics[k as keyof typeof old.metrics] === "number"),
    );
    if (!complete) problems.push(`missing_metric:${id}`);
    const requiresReview = !comparison || comparison.status !== "pass";
    const sameProfileCpuRegression =
      id.startsWith("cpu-") &&
      old?.profileHash === current.profileHash &&
      comparison?.status === "fail";
    const accepted =
      requiresReview &&
      complete &&
      !sameProfileCpuRegression &&
      reviewed(
        id,
        sampleReviewDigest(old, input.beforeContracts),
        sampleReviewDigest(current, input.afterContracts),
      );
    if (requiresReview && !accepted)
      problems.push(`comparison_${comparison?.status ?? "new_case"}:${id}`);
    rows.push({
      id,
      status: accepted ? "reviewed_baseline" : (comparison?.status ?? "unknown"),
      beforeDigest: sampleReviewDigest(old, input.beforeContracts),
      afterDigest: sampleReviewDigest(current, input.afterContracts),
      comparison,
    });
  }
  return {
    schemaVersion: 1,
    sourceSha: input.sourceSha,
    baselineSha: input.baseSha,
    status: problems.length ? ("fail" as const) : ("pass" as const),
    problems,
    coverage: { contracts: coverage.contracts.map((c) => c.id), uncovered: coverage.uncovered },
    baselineTests,
    candidateTests,
    rows,
    acceptedReviews,
    policyDigests: { before: oldPolicy, after: newPolicy },
    productionCpuP95Ms: null,
    productionObservation: "not_collected_by_offline_harness",
  };
}

export async function runLoadGate(
  baseSha: string,
  baselineDirectory: string,
  candidateDirectory: string,
  cpuDirectory: string,
  output: string,
  reports: string[],
) {
  requireSha(baseSha);
  repositoryArtifact(output);
  const checkout = readCheckout();
  const capture: unknown = JSON.parse(
    await readFile(join(baselineDirectory, "capture.json"), "utf8"),
  );
  if (
    !isRecord(capture) ||
    capture.schemaVersion !== 1 ||
    capture.status !== "pass" ||
    capture.sourceSha !== baseSha ||
    !Array.isArray(capture.contracts) ||
    !Array.isArray(capture.requiredSamples)
  )
    throw new Error("baseline_capture_unavailable_or_wrong_source");
  // The baseline capture is produced by the separate, pinned base checkout in this CI run.
  const beforeContracts = capture.contracts as LoadContract[];
  for (const c of beforeContracts)
    if (
      !c ||
      typeof c.id !== "string" ||
      !Array.isArray(c.sources) ||
      !Array.isArray(c.suites) ||
      !isRecord(c.samples)
    )
      throw new Error("invalid_baseline_contract");
  execFileSync("git", ["merge-base", "--is-ancestor", baseSha, "HEAD"]);
  const changedPaths = execFileSync(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", baseSha, "HEAD", "--"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const sources: Record<string, string> = {};
  for (const path of changedPaths.filter((p) => p.startsWith("src/") && p.endsWith(".ts"))) {
    try {
      sources[path] = await readFile(path, "utf8");
    } catch {
      sources[path] = execFileSync("git", ["show", `${baseSha}:${path}`], { encoding: "utf8" });
    }
  }
  const cpu = await readPairedCpu(cpuDirectory, baseSha, checkout.sourceSha);
  const originalBefore = await readCostSamples(join(baselineDirectory, "samples"), {
    allowEmpty: true,
  });
  const originalAfter = await readCostSamples(candidateDirectory, { allowEmpty: true });
  const result = evaluateLoadGate({
    pairedCpu: true,
    baseSha,
    sourceSha: checkout.sourceSha,
    checkoutClean: !checkout.dirty,
    before: [...originalBefore.filter((s) => !s.id.startsWith("cpu-")), ...cpu.before],
    after: [...originalAfter.filter((s) => !s.id.startsWith("cpu-")), ...cpu.after],
    beforeContracts,
    afterContracts: LOAD_CONTRACTS,
    beforeRequired: capture.requiredSamples as string[],
    afterRequired: REQUIRED_COST_SAMPLES,
    beforeReports: [JSON.parse(await readFile(join(baselineDirectory, "tests.json"), "utf8"))],
    afterReports: await Promise.all(
      reports.map(async (p) => JSON.parse(await readFile(p, "utf8"))),
    ),
    changedPaths,
    sources,
    reviews: parseLoadReviews(
      JSON.parse(await readFile(".github/harness/load-reviews.json", "utf8")),
    ),
    guardSuites: [
      "test/harness-cost.test.ts",
      "test/load-contracts.test.ts",
      "test/load-gate.test.ts",
      "test/load-cpu.test.ts",
    ],
  });
  const after = readCheckout();
  if (after.dirty || after.sourceSha !== checkout.sourceSha)
    throw new Error("candidate_changed_during_load_gate");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        ...result,
        cpuSampling: {
          method: cpu.method,
          rounds: cpu.rounds,
          evidence: repositoryArtifact(join(cpuDirectory, "capture.json")),
        },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      status: result.status,
      baselineSha: baseSha,
      sourceSha: result.sourceSha,
      problems: result.problems,
    }),
  );
  return reportExitCode(result.status);
}
