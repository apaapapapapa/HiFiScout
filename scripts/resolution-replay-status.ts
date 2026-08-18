import { appendFile } from "node:fs/promises";
import { resolutionReplayStatus, type ResolutionReplayStatus } from "../src/db/resolution-replay-status-repository.js";
import { createD1RestDatabase } from "./lib/d1-rest-database.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function markdown(status: ResolutionReplayStatus): string {
  const rows = [
    ["manufacturer", status.stages.manufacturer],
    ["model", status.stages.model],
    ["category", status.stages.category],
    ["identity", status.stages.identity],
  ] as const;
  const lines = [
    "## Resolver Replay Status",
    "",
    `Checked: ${status.checkedAt}`,
    "",
    `Overall: **${status.overall.upToDateListings}/${status.activeListings} (${status.overall.progressPercent}%)** active listings converged`,
    `Stale listings: **${status.overall.staleListings}** / stale signals: **${status.overall.staleSignals}**`,
    `Complete: **${status.overall.complete}** / blocked: **${status.overall.blocked}**`,
    "",
    "| Stage | Target version | Up to date | Stale | Progress |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows.map(
      ([name, value]) =>
        `| ${name} | ${value.targetVersion} | ${value.upToDate} | ${value.stale} | ${value.progressPercent}% |`,
    ),
    "",
    `Projection dirty: **${status.stages.projection.dirty}**`,
    "",
    "| Queue | Count |",
    "| --- | ---: |",
    `| pending | ${status.queue.pending} |`,
    `| processing | ${status.queue.processing} |`,
    `| resolved | ${status.queue.resolved} |`,
    `| failed | ${status.queue.failed} |`,
    "",
  ];
  return lines.join("\n");
}

const database = createD1RestDatabase({
  accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
  databaseId: requiredEnv("D1_DATABASE_ID"),
  apiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
});
const status = await resolutionReplayStatus(database);
const summary = markdown(status);
console.log(JSON.stringify(status, null, 2));
console.log("\n" + summary);

const githubStepSummary = process.env.GITHUB_STEP_SUMMARY?.trim();
if (githubStepSummary) await appendFile(githubStepSummary, `${summary}\n`, "utf8");
