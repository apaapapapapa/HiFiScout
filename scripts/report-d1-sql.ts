import { parseAdminSqlSnapshot } from "../src/admin/operations.js";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadSqlObservations, SqlObservationClient } from "./lib/d1-sql-observation-client.js";
import { SqlObservationError } from "./lib/d1-sql-observation.js";
import { buildSqlLoadReport } from "./lib/d1-sql-report.js";

try {
  const { values } = parseArgs({
    options: {
      hours: { type: "string", default: "24" },
      at: { type: "string" },
      "database-id": { type: "string" },
      output: { type: "string" },
      publish: { type: "boolean", default: false },
    },
  });
  const client = new SqlObservationClient({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  });
  const input = await loadSqlObservations(client, {
    at: values.at ? new Date(values.at) : new Date(),
    hours: Number(values.hours),
    databaseId: values["database-id"],
  });
  const report = buildSqlLoadReport(input, { sourceCommit: process.env.GITHUB_SHA ?? null });
  if (values.publish) await client.saveAdminSnapshot("sql-load", parseAdminSqlSnapshot(report));
  const json = JSON.stringify(report);
  if (values.output) await writeFile(values.output, `${json}\n`, { mode: 0o600 });
  // One stable, machine-readable line lets authenticated GitHub tools read the report without ZIP support.
  console.log(`D1_SQL_LOAD_REPORT ${json}`);
  if (report.archiveAvailability === "none") process.exitCode = 1;
} catch (error) {
  console.error(
    error instanceof SqlObservationError
      ? error.message
      : "SQL load report failed; no response bodies, SQL or credentials were logged.",
  );
  process.exitCode = 1;
}
