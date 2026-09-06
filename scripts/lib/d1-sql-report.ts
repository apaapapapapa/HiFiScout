import type { loadSqlObservations } from "./d1-sql-observation-client.js";
import {
  checkedIdentifier,
  summarizeObservations,
  type ObservedSql,
  type SqlStats,
} from "./d1-sql-observation.js";

const OPERATIONS = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "WITH",
  "REPLACE",
  "PRAGMA",
  "CREATE",
  "ALTER",
  "DROP",
]);

// Explicit fields are intentional: decoded archives can carry unknown properties.
const publicStats = (stats?: SqlStats) => ({
  count: stats?.count ?? null,
  rowsRead: stats?.rowsRead ?? null,
  rowsWritten: stats?.rowsWritten ?? null,
  rowsReturned: stats?.rowsReturned ?? null,
  durationMs: stats?.durationMs ?? null,
});

function publicQuery(row: ObservedSql) {
  const operation = row.sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "";
  return {
    fingerprint: row.fingerprint,
    operation: OPERATIONS.has(operation) ? operation : "OTHER",
    ...publicStats(row),
    variants: row.variants,
    sqlTruncated: row.sqlTruncated,
  };
}

/** Publish only allowlisted metadata/metrics, never SQL, literals, errors or arbitrary archive fields. */
export function buildSqlLoadReport(
  input: Awaited<ReturnType<typeof loadSqlObservations>>,
  {
    generatedAt = new Date(),
    sourceCommit = null,
  }: { generatedAt?: Date; sourceCommit?: string | null } = {},
) {
  const summary = summarizeObservations(input.archives);
  return {
    schemaVersion: 1,
    source: "r2-d1-sql-observations",
    includesSqlText: false,
    fullExecutionLog: false,
    generatedAt: generatedAt.toISOString(),
    sourceCommit: sourceCommit && /^[a-f0-9]{40}$/.test(sourceCommit) ? sourceCommit : null,
    databaseId: checkedIdentifier(input.databaseId, "database"),
    requestedHours: input.requestedHours,
    missingHours: input.missingHours,
    archiveAvailability:
      summary.hours.length === 0 ? "none" : input.missingHours.length ? "partial" : "complete",
    // An entirely absent archive is unknown, not a zero-load observation.
    observedTotals: publicStats(summary.hours.length ? summary.totals : undefined),
    hours: summary.hours.map((hour) => ({
      windowStart: hour.windowStart,
      windowEnd: new Date(hour.windowEnd).toISOString(),
      collectedAt: new Date(hour.collectedAt).toISOString(),
      // A closed hour can still have only a provisional snapshot in R2.
      provisional: Date.parse(hour.collectedAt) < Date.parse(hour.windowEnd),
      totals: publicStats(hour.totals),
      coverage: {
        sampling: "cloudflare-adaptive",
        fullExecutionLog: false,
        groupLimit: hour.coverage.groupLimit,
        limitHitBy: [...hour.coverage.limitHitBy],
        inconsistentGroups: hour.coverage.inconsistentGroups,
        sourceQueryGroups: hour.coverage.sourceQueryGroups,
        omittedQueryGroups: hour.coverage.omittedQueryGroups,
      },
    })),
    topReads: summary.topReads.map(publicQuery),
    topWrites: summary.topWrites.map(publicQuery),
    topTime: summary.topTime.map(publicQuery),
    topCount: summary.topCount.map(publicQuery),
  };
}
