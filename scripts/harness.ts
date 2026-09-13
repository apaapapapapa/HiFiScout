import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { assessHarnessReport, reportExitCode } from "./harness/report.js";

export async function runHarness(args: string[]): Promise<number> {
  if (args[0] !== "report" || args.length !== 2) {
    throw new Error("usage: vp run harness report <report.json>");
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
