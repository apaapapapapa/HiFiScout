import { parseArgs } from "node:util";
import { SqlObservationClient } from "./lib/d1-sql-observation-client.js";
import {
  observationHours,
  summarizeObservations,
  SqlObservationError,
  type SqlObservation,
} from "./lib/d1-sql-observation.js";

try {
  const { values } = parseArgs({
    options: {
      hours: { type: "string", default: "6" },
      at: { type: "string" },
      "database-id": { type: "string" },
    },
  });
  const client = new SqlObservationClient({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  });
  // An explicit archived database ID keeps analysis usable after the Worker/binding is removed.
  const databaseId = values["database-id"] ?? (await client.activeTarget()).databaseId;
  const hours = observationHours(
    values.at ? new Date(values.at) : new Date(),
    Number(values.hours),
  );
  const archives: SqlObservation[] = [];
  const missingHours: string[] = [];
  for (const hour of hours) {
    const archive = await client.load(databaseId, hour);
    if (archive) archives.push(archive);
    else missingHours.push(hour);
  }
  console.log(JSON.stringify({ ...summarizeObservations(archives), missingHours }, null, 2));
  if (archives.length === 0) process.exitCode = 1;
} catch (error) {
  console.error(
    error instanceof SqlObservationError
      ? error.message
      : "SQL archive analysis failed; no response bodies or credentials were logged.",
  );
  process.exitCode = 1;
}
