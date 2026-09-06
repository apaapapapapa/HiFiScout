import { parseArgs } from "node:util";
import { archiveSqlObservations, SqlObservationClient } from "./lib/d1-sql-observation-client.js";
import { SqlObservationError } from "./lib/d1-sql-observation.js";

try {
  const { values } = parseArgs({
    options: { hours: { type: "string", default: "3" }, at: { type: "string" } },
  });
  const client = new SqlObservationClient({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  });
  const result = await archiveSqlObservations(client, {
    at: values.at ? new Date(values.at) : new Date(),
    hours: Number(values.hours),
    collectorCommit: process.env.GITHUB_SHA ?? null,
  });
  // Public CI logs show only counts, coverage and archive identities, never SQL or returned rows.
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    error instanceof SqlObservationError
      ? error.message
      : "SQL observation failed; no response bodies or credentials were logged.",
  );
  process.exitCode = 1;
}
