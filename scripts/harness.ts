import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { assessHarnessReport, reportExitCode } from "./harness/report.js";

export async function runHarness(args: string[]): Promise<number> {
  if (args[0] === "load-gate" && args.length >= 6) {
    const { runLoadGate } = await import("./harness/load-gate.js");
    return runLoadGate(args[1], args[2], args[3], args[4], args.slice(5));
  }
  if (args[0] === "load-capture" && args.length === 2) {
    const { captureLoad } = await import("./harness/load-capture.js");
    return captureLoad(args[1]);
  }
  if (args[0] === "loop") {
    const { runLoopCli } = await import("./harness/loop/cli.js");
    return runLoopCli(args.slice(1));
  }
  if (args[0] === "ai-template" && args.length === 2) {
    const { aiRecordingTemplate } = await import("./harness/ai.js");
    await mkdir(dirname(args[1]), { recursive: true });
    await writeFile(args[1], `${JSON.stringify(await aiRecordingTemplate(), null, 2)}\n`, {
      flag: "wx",
    });
    return 0;
  }
  if (args[0] === "ai" && args.length === 3) {
    const { runAiHoldout } = await import("./harness/ai.js");
    const result = await runAiHoldout(args[1], args[2]);
    console.log(JSON.stringify(result, null, 2));
    return reportExitCode(result.status);
  }
  if (args[0] === "ui" && args.length === 2) {
    const { runUi } = await import("./harness/ui.js");
    const result = await runUi(args[1]);
    console.log(JSON.stringify(result, null, 2));
    return reportExitCode(result.status);
  }
  if (args[0] === "cost-report" && args.length === 3) {
    const { costReport } = await import("./harness/cost.js");
    const result = await costReport(args[1], args[2]);
    console.log(JSON.stringify(result, null, 2));
    return reportExitCode(result.status);
  }
  if (args[0] === "compare-cost" && args.length === 3) {
    const { compareCosts, readCostSamples } = await import("./harness/cost.js");
    const result = compareCosts(await readCostSamples(args[1]), await readCostSamples(args[2]));
    console.log(JSON.stringify(result, null, 2));
    return reportExitCode(result.status);
  }
  if (args[0] === "replay" && args.length >= 2) {
    const { runReplay } = await import("./harness/replay.js");
    const result = await runReplay(args[1], args.slice(2));
    console.log(JSON.stringify(result, null, 2));
    return reportExitCode(result.status);
  }
  if (args[0] === "compare-replay" && args.length === 3) {
    const { compareReplays } = await import("./harness/replay.js");
    const result = compareReplays(
      JSON.parse(await readFile(args[1], "utf8")),
      JSON.parse(await readFile(args[2], "utf8")),
    );
    console.log(JSON.stringify(result, null, 2));
    return reportExitCode(result.status);
  }
  if (args[0] === "checkpoint" && args.length === 5) {
    const { saveCheckpoint } = await import("./harness/checkpoint.js");
    const task: unknown = JSON.parse(await readFile(args[1], "utf8"));
    const report: unknown = JSON.parse(await readFile(args[2], "utf8"));
    const result = await saveCheckpoint(task, report, args[3], Number(args[4]));
    console.log(JSON.stringify(result, null, 2));
    return reportExitCode(result.status);
  }
  if (args[0] === "resume" && args.length === 2) {
    const { assessCheckpoint, readCheckout } = await import("./harness/checkpoint.js");
    const result = assessCheckpoint(JSON.parse(await readFile(args[1], "utf8")), readCheckout());
    console.log(JSON.stringify(result, null, 2));
    return reportExitCode(result.status);
  }
  if (args[0] === "delivery" && args.length === 4) {
    const { collectDelivery } = await import("./harness/github.js");
    const report = await collectDelivery(args[1], Number(args[2]), args[3]);
    console.log(JSON.stringify(report, null, 2));
    return reportExitCode(report.status);
  }
  if (args[0] !== "report" || args.length !== 2) {
    throw new Error(
      "usage: vp run harness load-capture <new-output-dir> | load-gate <base-sha> <baseline-dir> <candidate-samples> <report.json> <vitest-reports...> | report <report.json> | delivery <owner/repo> <PR> <output-dir> | checkpoint <task.json> <report.json> <state.json> <revision> | resume <state.json> | replay <output-dir> [vitest-reports...] | compare-replay <before.json> <after.json> | cost-report <samples-dir> <report.json> | compare-cost <before-dir> <after-dir> | ui <new-output-dir> | ai-template <new-recording.json> | ai <recording.json> <new-output-dir>",
    );
  }
  const input: unknown = JSON.parse(await readFile(args[1], "utf8"));
  const report = assessHarnessReport(input);
  console.log(JSON.stringify(report, null, 2));
  return reportExitCode(report.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHarness(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : "harness_failed");
      process.exitCode = 2;
    },
  );
}
