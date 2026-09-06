import { pathToFileURL } from "node:url";
import { STALLED_CRAWL_RUNS_SQL } from "../src/db/crawl-run-repository.js";
import { deleteInactiveOfferSql } from "../src/db/product-search-entity-sql.js";
import { createD1RestDatabase } from "./lib/d1-rest-database.js";
import { SqlObservationClient } from "./lib/d1-sql-observation-client.js";

/** Only the single, explicit D1 error may defer deployment; mixed/unknown failures stay fatal. */
export function isMaintenanceD1QuotaError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(?:Cloudflare D1 API request failed with HTTP \d{3}: )?7500: [^;\n]*exceeded D1's free tier daily row (?:read|write) limit[^;\n]*$/.test(
      error.message,
    )
  );
}

// Deployment-owned read-only check: EXPLAIN never executes the DELETE. Only the indexed,
// five-row running-work probe touches application rows; no full health audit is resumed.
async function main() {
  let phase = "resolve_active_binding";
  try {
    const credentials = {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
    };
    const { databaseId, deploymentVersions } = await new SqlObservationClient(
      credentials,
    ).activeTarget();
    const db = createD1RestDatabase({ ...credentials, databaseId });
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const explain = async (sql: string, binds: (number | string)[]) => {
      const result = await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...binds)
        .all<{ detail: string }>();
      return (result.results || []).map((row) => row.detail);
    };
    phase = "explain_original_recovery";
    const originalPlan = await explain(
      STALLED_CRAWL_RUNS_SQL.replace(" INDEXED BY idx_crawl_runs_running_started_at", ""),
      [cutoff, 5],
    );
    phase = "explain_indexed_recovery";
    const runningPlan = await explain(STALLED_CRAWL_RUNS_SQL, [cutoff, 5]);
    if (!runningPlan.some((line) => line.includes("idx_crawl_runs_running_started_at"))) {
      throw new Error("Running-work index is not used");
    }
    phase = "explain_scoped_deletion";
    const deletionPlan = await explain(deleteInactiveOfferSql(), [1]);
    if (
      !["p", "product_search_entity_offers"].every((table) =>
        deletionPlan.some((line) => line.startsWith(`SEARCH ${table} USING INTEGER PRIMARY KEY`)),
      )
    ) {
      throw new Error("Scoped deletion is missing a primary-key lookup");
    }
    phase = "probe_indexed_recovery";
    const probe = await db.prepare(STALLED_CRAWL_RUNS_SQL).bind(cutoff, 5).all();
    console.log(
      JSON.stringify({
        event: "maintenance_access_paths",
        databaseId,
        deploymentVersions,
        originalPlan,
        runningPlan,
        deletionPlan,
        runningProbe: {
          rowsRead: probe.meta.rows_read,
          rowsWritten: probe.meta.rows_written,
          returned: probe.results?.length ?? 0,
        },
      }),
    );
  } catch (error) {
    if (isMaintenanceD1QuotaError(error)) {
      console.error("Maintenance access-path verification deferred by D1 daily row quota (7500).");
      process.exitCode = 75;
    } else {
      console.error(
        `Maintenance access-path verification failed at ${phase}; no row data or credentials logged.`,
      );
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
