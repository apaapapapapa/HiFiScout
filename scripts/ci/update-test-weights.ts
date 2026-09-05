import { readFileSync, readdirSync, writeFileSync } from "node:fs";

// Run the complete unit suite with --reporter=json --outputFile=<report>, then pass that report.
const reports = process.argv.slice(2);
if (!reports.length)
  throw new Error("Pass one complete Vitest JSON report, or the reports from all shards.");
const weights = new Map<string, number>();
for (const file of reports) {
  const report = JSON.parse(readFileSync(file, "utf8")) as {
    success: boolean;
    testResults: Array<{ name: string; startTime: number; endTime: number; status: string }>;
  };
  if (!report.success) throw new Error(`Refusing timings from a failing test run: ${file}`);
  for (const result of report.testResults) {
    const normalized = result.name.replaceAll("\\", "/");
    const name = normalized.slice(normalized.lastIndexOf("/test/") + 1);
    if (!name.startsWith("test/") || result.status !== "passed")
      throw new Error(`Invalid test timing: ${name}`);
    weights.set(name, Math.max(10, Math.round((result.endTime - result.startTime) / 10) * 10));
  }
}
const discovered = readdirSync("test", { recursive: true })
  .filter((name) => /\.test\.tsx?$/u.test(String(name)))
  .map((name) => `test/${name}`);
if (discovered.some((name) => !weights.has(name)) || weights.size !== discovered.length) {
  throw new Error("Timings must cover every current test file exactly; provide all shard reports.");
}
writeFileSync(
  ".github/config/unit-test-weights.json",
  `${JSON.stringify(Object.fromEntries([...weights].sort(([a], [b]) => a.localeCompare(b, "en"))), null, 2)}\n`,
);
console.log(`Updated shard weights for ${weights.size} test files.`);
