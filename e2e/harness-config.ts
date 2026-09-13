import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReporterDescription } from "@playwright/test";

export const harnessUi = process.env.HARNESS_UI === "1";
export const uiOutput = (suite: string) =>
  resolve(
    process.env.HARNESS_UI_OUTPUT ?? fileURLToPath(new URL("../test-results", import.meta.url)),
    suite,
  );
export const uiReporter = (suite: string): ReporterDescription[] =>
  harnessUi
    ? [["line"], ["json", { outputFile: resolve(uiOutput(suite), "results.json") }]]
    : [[process.env.CI ? "line" : "list"]];
