import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { repositoryArtifact } from "./artifacts.js";
import { isRecord } from "../../src/types.js";
import { requireSha, requireText, requireTimestamp } from "./report.js";
import { assessHarnessReport } from "./report.js";
import { readCheckout } from "./checkpoint.js";
import { LOAD_SAMPLE_BUDGETS } from "./load-contracts.js";
const initialCheckout = process.env.HARNESS_COST_OUTPUT ? readCheckout() : null;

const METRICS = {
  rowsRead: "rows",
  rowsWritten: "rows",
  sqlStatements: "statements",
  doAlarms: "calls",
  doStorageWrites: "calls",
  queueSends: "messages",
  queueRetries: "messages",
  cpuUs: "microseconds",
  cpuRelative: "ratio",
  d1Calls: "calls",
  scheduledInvocations: "calls",
  crawlDispatches: "calls",
  plannedPages: "pages",
} as const;
export type CostMetric = keyof typeof METRICS;
export type CostMetrics = Partial<Record<CostMetric, number | null>>;
export function assessCostBudget(metrics: CostMetrics, limits: CostMetrics) {
  const keys = Object.keys(limits) as CostMetric[];
  if (
    !keys.length ||
    keys.some(
      (key) => typeof limits[key] !== "number" || !Number.isFinite(limits[key]) || limits[key]! < 0,
    )
  ) {
    throw new Error("invalid_cost_budget");
  }
  if (
    keys.some(
      (key) =>
        typeof metrics[key] !== "number" || !Number.isFinite(metrics[key]) || metrics[key]! < 0,
    )
  )
    return "unknown";
  return keys.some((key) => metrics[key]! > limits[key]!) ? "fail" : "pass";
}
type CostEnvironment = "local-workerd" | "local-mock" | "local-node";
export interface CostSample {
  schemaVersion: 1;
  kind: "cost-sample";
  id: string;
  sourceSha: string;
  checkoutClean: boolean;
  recordedAt: string;
  profileHash: string;
  environment: CostEnvironment;
  metrics: CostMetrics;
  notes: string[];
  queryPlans: string[];
}

export function parseCostSample(value: unknown): CostSample {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "cost-sample" ||
    !isRecord(value.metrics) ||
    !Array.isArray(value.notes) ||
    !Array.isArray(value.queryPlans) ||
    !["local-workerd", "local-mock", "local-node"].includes(String(value.environment)) ||
    typeof value.profileHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.profileHash)
  )
    throw new Error("invalid_cost_sample");
  if (typeof value.checkoutClean !== "boolean") throw new Error("invalid_cost_checkout");
  const metrics: CostMetrics = {};
  for (const [key, measurement] of Object.entries(value.metrics)) {
    if (
      !Object.hasOwn(METRICS, key) ||
      (measurement !== null &&
        (typeof measurement !== "number" || !Number.isFinite(measurement) || measurement < 0))
    )
      throw new Error("invalid_cost_metric");
    metrics[key as CostMetric] = measurement;
  }
  if (!Object.keys(metrics).length) throw new Error("missing_cost_metrics");
  const id = requireText(value.id, "cost_id");
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) throw new Error("invalid_cost_id");
  return {
    schemaVersion: 1,
    kind: "cost-sample",
    id,
    sourceSha: requireSha(value.sourceSha),
    checkoutClean: value.checkoutClean,
    recordedAt: requireTimestamp(value.recordedAt),
    profileHash: value.profileHash,
    environment: value.environment as CostEnvironment,
    metrics,
    notes: value.notes.map((note) => requireText(note, "cost_note")),
    queryPlans: value.queryPlans.map((plan) => requireText(plan, "query_plan")),
  };
}

/** Opt-in artifact output from existing tests/benchmark; no production reads or new executions. */
export async function recordCostSample(
  id: string,
  environment: CostEnvironment,
  metrics: CostMetrics,
  fixturePaths: string[],
  notes: string[] = [],
  queryPlans: string[] = [],
) {
  const directory = process.env.HARNESS_COST_OUTPUT;
  if (!directory) return;
  const paths = execFileSync("git", ["ls-files", "-z", "test/helpers", "test/fixtures"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const hash = createHash("sha256")
    .update("cost-profile-v2\0")
    .update(JSON.stringify([environment, process.version, process.platform, process.arch]));
  for (const path of [...new Set([...paths, ...fixturePaths, "package-lock.json"])].sort())
    hash
      .update(path)
      .update("\0")
      .update(await readFile(path))
      .update("\0");
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sample = parseCostSample({
    schemaVersion: 1,
    kind: "cost-sample",
    id,
    sourceSha,
    checkoutClean:
      initialCheckout?.sourceSha === sourceSha && !initialCheckout.dirty && !readCheckout().dirty,
    recordedAt: new Date().toISOString(),
    profileHash: hash.digest("hex"),
    environment,
    metrics,
    notes,
    queryPlans,
  });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${sample.id}.json`), `${JSON.stringify(sample, null, 2)}\n`);
}

export async function readCostSamples(directory: string, { allowEmpty = false } = {}) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (!allowEmpty || !isRecord(error) || error.code !== "ENOENT") throw error;
    names = [];
  }
  const samples = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(async (name) => {
        const sample = parseCostSample(JSON.parse(await readFile(join(directory, name), "utf8")));
        if (name !== `${sample.id}.json`) throw new Error("cost_sample_filename_mismatch");
        return sample;
      }),
  );
  if (
    (!allowEmpty && !samples.length) ||
    new Set(samples.map((sample) => sample.id)).size !== samples.length
  )
    throw new Error("missing_or_duplicate_cost_samples");
  if (samples.length && new Set(samples.map((sample) => sample.sourceSha)).size !== 1)
    throw new Error("mixed_cost_source_shas");
  return samples;
}

export function compareCosts(beforeValues: unknown[], afterValues: unknown[]) {
  const before = beforeValues.map(parseCostSample),
    after = afterValues.map(parseCostSample);
  for (const samples of [before, after]) {
    if (
      !samples.length ||
      new Set(samples.map((sample) => sample.id)).size !== samples.length ||
      new Set(samples.map((sample) => sample.sourceSha)).size !== 1
    )
      throw new Error("invalid_cost_sample_set");
  }
  const rows = [...new Set([...before, ...after].map((sample) => sample.id))]
    .sort()
    .flatMap((id) => {
      const baseline = before.find((sample) => sample.id === id),
        candidate = after.find((sample) => sample.id === id);
      const comparable =
        baseline &&
        candidate &&
        baseline.checkoutClean &&
        candidate.checkoutClean &&
        baseline.profileHash === candidate.profileHash &&
        baseline.environment === candidate.environment;
      return [
        ...new Set([
          ...Object.keys(baseline?.metrics ?? {}),
          ...Object.keys(candidate?.metrics ?? {}),
        ]),
      ].map((key) => {
        const metric = key as CostMetric;
        const old = baseline?.metrics[metric] ?? null,
          current = candidate?.metrics[metric] ?? null;
        const measured = comparable && old !== null && current !== null;
        const delta = measured ? current - old : null;
        // Absolute Node CPU is diagnostic. Relative CPU uses the existing benchmark's noise budget;
        // deterministic row/statement/message counts have no implicit allowance for an increase.
        const diagnostic = metric === "cpuUs";
        const limit = metric === "cpuRelative" ? (old ?? 0) * 0.75 + 0.5 : 0;
        const status = !measured
          ? "unknown"
          : diagnostic
            ? "skipped"
            : delta! > limit
              ? "fail"
              : "pass";
        return {
          id,
          environment: candidate?.environment ?? baseline?.environment,
          metric,
          unit: METRICS[metric],
          baseline: old,
          candidate: current,
          delta,
          ratio: measured && old !== 0 ? current / old : null,
          status,
          reason: !comparable
            ? "missing_sample_or_changed_profile"
            : !measured
              ? "measurement_unavailable"
              : diagnostic
                ? "absolute_local_cpu_is_diagnostic_only"
                : "same_profile_cost_comparison",
        };
      });
    });
  return {
    schemaVersion: 1,
    baselineSha: before[0].sourceSha,
    sourceSha: after[0].sourceSha,
    productionCpuP95Ms: null,
    productionObservation: "not_collected_by_offline_harness",
    status: rows.some((row) => row.status === "fail")
      ? ("fail" as const)
      : rows.some((row) => row.status === "unknown") || !rows.some((row) => row.status === "pass")
        ? ("unknown" as const)
        : ("pass" as const),
    rows,
  };
}

export const REQUIRED_COST_SAMPLES = [
  ...Object.keys(LOAD_SAMPLE_BUDGETS),
  "cpu-dynamic-audio-parse",
  "cpu-dynamic-audio-normalize",
  "cpu-dynamic-audio-discover",
  "cpu-hifido-parse",
  "cpu-hifido-normalize",
  "cpu-rewire-parse",
  "cpu-rewire-normalize",
  "cpu-rewire-discover",
];

export async function costReport(directory: string, outputPath: string) {
  const startedAt = new Date().toISOString(),
    checkout = readCheckout();
  repositoryArtifact(join(directory, "sample.json"));
  const samples = await readCostSamples(directory, { allowEmpty: true });
  const report = assessHarnessReport({
    schemaVersion: 1,
    runId: `cost-${checkout.sourceSha}`,
    sourceSha: checkout.sourceSha,
    baselineSha: null,
    deploymentSha: null,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks: REQUIRED_COST_SAMPLES.map((id) => {
      const sample = samples.find((item) => item.id === id);
      const budget = LOAD_SAMPLE_BUDGETS[id];
      const keys: CostMetric[] = budget
        ? (Object.keys(budget.limits) as CostMetric[])
        : id.startsWith("cpu-")
          ? ["cpuUs", "cpuRelative"]
          : id.startsWith("crawl-do-")
            ? ["doAlarms", "doStorageWrites"]
            : id.startsWith("queue-")
              ? ["queueSends", "queueRetries"]
              : ["rowsRead", "rowsWritten", "sqlStatements"];
      const complete =
        sample &&
        sample.checkoutClean &&
        !checkout.dirty &&
        sample.sourceSha === checkout.sourceSha &&
        (!budget || sample.environment === budget.environment) &&
        keys.every((key) => typeof sample.metrics[key] === "number");
      const exceeded =
        complete && budget && assessCostBudget(sample.metrics, budget.limits) === "fail";
      return {
        id: `cost/${id}`,
        required: true,
        scope: "source",
        status: exceeded ? "fail" : complete ? "pass" : "unknown",
        reason: complete
          ? `${sample.environment}: ${exceeded ? "load_budget_exceeded" : "measurement_and_registered_budget_pass"}; compare a baseline separately`
          : "missing_measurement_or_stale_or_dirty_checkout",
        evidence: sample
          ? [
              {
                uri: repositoryArtifact(join(directory, `${id}.json`)),
                sourceSha: sample.sourceSha,
              },
            ]
          : [],
      };
    }),
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
