import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { assessHarnessReport, reportExitCode } from "./harness/report.js";

export async function runHarness(args: string[]): Promise<number> {
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
      "usage: vp run harness report <report.json> | delivery <owner/repo> <PR> <output-dir> | checkpoint <task.json> <report.json> <state.json> <revision> | resume <state.json> | replay <output-dir> [vitest-reports...] | compare-replay <before.json> <after.json>",
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
