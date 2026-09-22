import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "../../src/types.js";
import { readCheckout } from "./checkpoint.js";
import { compareCosts, parseCostSample, readCostSamples } from "./cost.js";
import type { CostSample } from "./cost.js";
import { repositoryArtifact } from "./artifacts.js";
import { reportExitCode } from "./report.js";
import type { CheckStatus } from "./report.js";

const ROUNDS = 3;
const METHOD = "same-runner-alternating-median-3";

/** Fixed repetitions, never retry-until-green. Existing ceilings apply to the complete medians. */
export async function capturePairedCpu(baselineCheckout: string, directory: string) {
  repositoryArtifact(join(directory, "capture.json"));
  const roots = { baseline: resolve(baselineCheckout), candidate: process.cwd() };
  const before = { baseline: readCheckout(roots.baseline), candidate: readCheckout() };
  if (before.baseline.dirty || before.candidate.dirty)
    throw new Error("paired_cpu_requires_clean_checkouts");
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  const exits: { side: string; round: number; exit: number | null }[] = [];
  outer: for (let round = 1; round <= ROUNDS; round++) {
    const sides =
      round % 2 ? (["baseline", "candidate"] as const) : (["candidate", "baseline"] as const);
    for (const side of sides) {
      const result = spawnSync(
        "vp",
        ["exec", "node", "--import", "tsx", "scripts/parser-cpu-benchmark.ts"],
        {
          cwd: roots[side],
          env: { ...process.env, HARNESS_COST_OUTPUT: resolve(directory, side, String(round)) },
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      exits.push({ side, round, exit: result.status });
      await writeFile(
        join(directory, `${side}-${round}.log`),
        `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      );
      if (result.status !== 0) break outer;
    }
  }
  const stable = (["baseline", "candidate"] as const).every((side) => {
    const current = readCheckout(roots[side]);
    return !current.dirty && current.sourceSha === before[side].sourceSha;
  });
  const status =
    exits.length !== 2 * ROUNDS || exits.some((r) => r.exit !== 0)
      ? "fail"
      : !stable
        ? "unknown"
        : "pass";
  const capture = {
    schemaVersion: 1,
    method: METHOD,
    rounds: ROUNDS,
    status: status as CheckStatus,
    baselineSha: before.baseline.sourceSha,
    sourceSha: before.candidate.sourceSha,
    exits,
    problem: null as string | null,
  };
  await writeFile(join(directory, "capture.json"), JSON.stringify(capture, null, 2) + "\n");
  if (capture.status === "pass") {
    try {
      await readPairedCpu(directory, capture.baselineSha, capture.sourceSha);
    } catch (error) {
      capture.problem = error instanceof Error ? error.message : String(error);
      capture.status = capture.problem.startsWith("cpu_absolute_budget:") ? "fail" : "unknown";
      await writeFile(join(directory, "capture.json"), JSON.stringify(capture, null, 2) + "\n");
    }
  }
  console.log(JSON.stringify(capture));
  return reportExitCode(capture.status);
}

export function parseCpuCeilings(log: string): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const line of log.split("\n").filter((line) => line.startsWith("{"))) {
    const row: unknown = JSON.parse(line);
    if (!isRecord(row) || row.event !== "parser_cpu_benchmark") continue;
    if (
      typeof row.shopKey !== "string" ||
      typeof row.stage !== "string" ||
      typeof row.maxRelativeToReference !== "number" ||
      !Number.isFinite(row.maxRelativeToReference) ||
      row.maxRelativeToReference <= 0
    )
      throw new Error("invalid_cpu_ceiling");
    const id = `cpu-${row.shopKey}-${row.stage}`;
    if (Object.hasOwn(limits, id)) throw new Error("duplicate_cpu_ceiling");
    limits[id] = row.maxRelativeToReference;
  }
  return limits;
}

export function aggregateCpuRounds(
  values: unknown[][],
  ceilings: Record<string, number>[],
): CostSample[] {
  if (values.length !== ROUNDS || ceilings.length !== ROUNDS) throw new Error("missing_cpu_rounds");
  const rounds = values.map((samples) => samples.map(parseCostSample));
  const ids = rounds[0].map((s) => s.id).sort();
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !id.startsWith("cpu-")))
    throw new Error("invalid_cpu_sample_set");
  for (const round of rounds)
    if (JSON.stringify(round.map((s) => s.id).sort()) !== JSON.stringify(ids))
      throw new Error("missing_or_duplicate_cpu_round_sample");
  for (const limits of ceilings)
    if (
      JSON.stringify(Object.keys(limits).sort()) !== JSON.stringify(ids) ||
      ids.some(
        (id) => !Number.isFinite(limits[id]) || limits[id] <= 0 || limits[id] !== ceilings[0][id],
      )
    )
      throw new Error("missing_or_changed_cpu_ceiling");
  const median = (values: number[]) => values.sort((a, b) => a - b)[1];
  return ids.map((id) => {
    const samples = rounds.map((round) => round.find((s) => s.id === id)!);
    const first = samples[0];
    if (
      samples.some(
        (s) =>
          !s.checkoutClean ||
          s.sourceSha !== first.sourceSha ||
          s.profileHash !== first.profileHash ||
          s.environment !== "local-node" ||
          typeof s.metrics.cpuUs !== "number" ||
          typeof s.metrics.cpuRelative !== "number" ||
          s.metrics.cpuUs <= 0 ||
          s.metrics.cpuRelative <= 0,
      )
    )
      throw new Error("incomparable_cpu_rounds");
    const relative = median(samples.map((s) => s.metrics.cpuRelative!));
    if (relative > ceilings[0][id]) throw new Error(`cpu_absolute_budget:${id}`);
    return {
      ...first,
      recordedAt: new Date(Math.max(...samples.map((s) => Date.parse(s.recordedAt)))).toISOString(),
      metrics: {
        cpuUs: median(samples.map((s) => s.metrics.cpuUs!)),
        cpuRelative: relative,
      },
      notes: [...first.notes, METHOD],
    };
  });
}

/** Same host: compare work against one reference, not a ratio of two noisy control loops. */
export function comparePairedCpu(before: CostSample, after: CostSample) {
  const raw = compareCosts([before], [after]);
  const comparable =
    before.id === after.id &&
    before.profileHash === after.profileHash &&
    before.checkoutClean &&
    after.checkoutClean &&
    before.environment === "local-node" &&
    after.environment === "local-node" &&
    typeof before.metrics.cpuUs === "number" &&
    before.metrics.cpuUs > 0 &&
    typeof after.metrics.cpuUs === "number" &&
    after.metrics.cpuUs > 0 &&
    typeof before.metrics.cpuRelative === "number" &&
    before.metrics.cpuRelative > 0;
  const ratio = comparable ? after.metrics.cpuUs! / before.metrics.cpuUs! : null;
  // The existing +0.5 reference-unit allowance, expressed against the shared baseline.
  const maximumRatio = comparable ? 1.75 + 0.5 / before.metrics.cpuRelative! : null;
  const status = !comparable
    ? ("unknown" as const)
    : ratio! > maximumRatio!
      ? ("fail" as const)
      : ("pass" as const);
  return {
    ...raw,
    status,
    rows: raw.rows.map((row) => ({
      ...row,
      status: "skipped" as const,
      reason: "raw_cpu_observation_retained_for_diagnostics",
    })),
    paired: {
      metric: "cpuUsageRatio",
      unit: "ratio",
      baselineCpuUs: before.metrics.cpuUs,
      candidateCpuUs: after.metrics.cpuUs,
      ratio,
      maximumRatio,
      status,
      reason: "same_runner_medians_with_common_baseline_reference",
    },
  };
}

export async function readPairedCpu(directory: string, baseSha: string, sourceSha: string) {
  const capture: unknown = JSON.parse(await readFile(join(directory, "capture.json"), "utf8"));
  if (
    !isRecord(capture) ||
    capture.schemaVersion !== 1 ||
    capture.method !== METHOD ||
    capture.rounds !== ROUNDS ||
    capture.status !== "pass" ||
    capture.baselineSha !== baseSha ||
    capture.sourceSha !== sourceSha ||
    !Array.isArray(capture.exits) ||
    capture.exits.length !== 2 * ROUNDS
  )
    throw new Error("paired_cpu_unavailable_or_wrong_source");
  const exits: unknown[] = capture.exits;
  if (
    (["baseline", "candidate"] as const).some((side) =>
      [1, 2, 3].some(
        (round) =>
          exits.filter(
            (entry) =>
              isRecord(entry) && entry.side === side && entry.round === round && entry.exit === 0,
          ).length !== 1,
      ),
    )
  )
    throw new Error("paired_cpu_benchmark_failed_or_missing");
  const samples = await Promise.all(
    ["baseline", "candidate"].map(async (side) =>
      aggregateCpuRounds(
        await Promise.all(
          [1, 2, 3].map((round) => readCostSamples(join(directory, side, String(round)))),
        ),
        await Promise.all(
          [1, 2, 3].map(async (round) =>
            parseCpuCeilings(await readFile(join(directory, `${side}-${round}.log`), "utf8")),
          ),
        ),
      ),
    ),
  );
  return { before: samples[0], after: samples[1], method: METHOD, rounds: ROUNDS };
}
