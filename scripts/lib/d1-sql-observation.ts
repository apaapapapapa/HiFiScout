import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const SQL_OBSERVATION_BUCKET = "hifiscout-d1-observations";
export const SQL_OBSERVATION_PREFIX = "sql/v1/";
export const SQL_OBSERVATION_RETENTION_DAYS = 5;
export const SQL_OBSERVATION_GROUP_LIMIT = 500;
export const SQL_OBSERVATION_MAX_BYTES = 1024 * 1024;
export const SQL_OBSERVATION_MAX_JSON_BYTES = 4 * 1024 * 1024;
const HOUR = 3_600_000;
const MAX_SQL_CHARS = 16_000;
export const SQL_SORTS = ["reads", "writes", "time", "count"] as const;
const STAT_FIELDS = ["count", "rowsRead", "rowsWritten", "rowsReturned", "durationMs"] as const;
export type SqlStats = Record<(typeof STAT_FIELDS)[number], number | null>;

export class SqlObservationError extends Error {}

export interface ObservedSql extends SqlStats {
  fingerprint: string;
  sql: string;
  sqlTruncated: boolean;
  variants: number;
}

export interface SqlObservation {
  schemaVersion: 1;
  source: "cloudflare-d1-insights";
  databaseId: string;
  worker: string;
  windowStart: string;
  windowEnd: string;
  collectedAt: string;
  collectorCommit: string | null;
  /** This is collector-time context, NOT attribution of every SQL to that Worker version. */
  deploymentVersions: string[];
  coverage: {
    sampling: "cloudflare-adaptive";
    fullExecutionLog: false;
    groupLimit: number;
    limitHitBy: string[];
    inconsistentGroups: number;
    sourceQueryGroups: number;
    omittedQueryGroups: number;
  };
  totals: SqlStats;
  queries: ObservedSql[];
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkedIdentifier(value: string, kind: "account" | "database" | "worker"): string {
  const pattern =
    kind === "account"
      ? /^[a-f0-9]{32}$/i
      : kind === "database"
        ? /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
        : /^[a-z0-9][a-z0-9-]{0,62}$/;
  if (!pattern.test(value)) throw new SqlObservationError(`Invalid ${kind} identifier.`);
  return value;
}

export function observationHours(at: Date, hours = 3): string[] {
  if (!Number.isFinite(at.getTime()) || !Number.isInteger(hours) || hours < 1 || hours > 24)
    throw new SqlObservationError("Use a valid timestamp and between 1 and 24 hours.");
  const end = Math.floor(at.getTime() / HOUR) * HOUR;
  return Array.from({ length: hours }, (_, i) =>
    new Date(end - (hours - i - 1) * HOUR).toISOString(),
  );
}

export function observationKey(databaseId: string, hour: string): string {
  checkedIdentifier(databaseId, "database");
  if (!/^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/.test(hour) || new Date(hour).toISOString() !== hour)
    throw new SqlObservationError("Archive timestamps must be valid UTC hour boundaries.");
  return `${SQL_OBSERVATION_PREFIX}${databaseId}/${hour.slice(0, 10)}/${hour.slice(11, 13)}.json.gz`;
}

/** Never persist literals, comments, or bound values. SQLite accepts double-quoted strings too,
 * so all quoted tokens (including quoted identifiers) are conservatively removed. Linear scan;
 * normalize the entire statement BEFORE truncating, including unterminated literals/comments. */
export function redactSql(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const current = sql[index]!;
    const next = sql[index + 1];
    if (current === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index++;
      output += " ";
    } else if (current === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 2;
      output += " ";
    } else if ("'\"`[".includes(current)) {
      const close = current === "[" ? "]" : current;
      index++;
      while (index < sql.length) {
        if (sql[index++] !== close) continue;
        if (current !== "[" && sql[index] === close) index++;
        else break;
      }
      output += "?";
    } else if (/[a-z_$]/i.test(current)) {
      const start = index++;
      while (index < sql.length && /[a-z0-9_$]/i.test(sql[index]!)) index++;
      const word = sql.slice(start, index);
      if (!(/^x$/i.test(word) && sql[index] === "'")) output += word;
    } else if (current === "?") {
      index++;
      while (index < sql.length && /\d/.test(sql[index]!)) index++;
      output += "?";
    } else if (/\d/.test(current) || (current === "." && next && /\d/.test(next))) {
      // SQLite permits digit separators in numeric literals, including hex/exponents.
      const literal =
        /^(?:0x[\da-f](?:_?[\da-f])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?)/i.exec(
          sql.slice(index),
        );
      index += literal?.[0].length ?? 1;
      output += "?";
    } else {
      output += current;
      index++;
    }
  }
  return output.replace(/\s+/g, " ").trim();
}

function metric(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new SqlObservationError("D1 Insights returned invalid metrics.");
  return value;
}

export function sumStats(rows: SqlStats[]): SqlStats {
  return Object.fromEntries(
    STAT_FIELDS.map((field) => [
      field,
      rows.reduce<number | null>(
        (total, row) => (total === null || row[field] === null ? null : total + row[field]),
        0,
      ),
    ]),
  ) as SqlStats;
}

export function observationQuery(databaseId: string, hour: string): string {
  observationKey(databaseId, hour);
  // Use an inline filter, as in Cloudflare's D1 GraphQL examples, to avoid declaring a variable
  // with another dataset's nominal input type. Only validated identifiers/timestamps are embedded.
  const filter = `{databaseId: ${JSON.stringify(databaseId)}, datetimeHour_geq: ${JSON.stringify(hour)}, datetimeHour_leq: ${JSON.stringify(hour)}}`;
  const order = {
    reads: "sum_rowsRead_DESC",
    writes: "sum_rowsWritten_DESC",
    time: "sum_queryDurationMs_DESC",
    count: "count_DESC",
  };
  return `query HiFiScoutD1SqlObservation($accountTag: string!) {
    viewer { accounts(filter: { accountTag: $accountTag }) {
      ${SQL_SORTS.map(
        (
          sort,
        ) => `${sort}: d1QueriesAdaptiveGroups(limit: ${SQL_OBSERVATION_GROUP_LIMIT}, filter: ${filter}, orderBy: [${order[sort]}]) {
        count sum { rowsRead rowsWritten rowsReturned queryDurationMs } dimensions { query }
      }`,
      ).join("\n")}
    } }
  }`;
}

/** Four cost rankings improve coverage, but their overlap must never quadruple the billed rows. */
export function parseObservation(
  payload: unknown,
  context: Pick<
    SqlObservation,
    | "databaseId"
    | "worker"
    | "windowStart"
    | "collectedAt"
    | "collectorCommit"
    | "deploymentVersions"
  >,
): SqlObservation {
  if (!object(payload) || (Array.isArray(payload.errors) && payload.errors.length > 0))
    throw new SqlObservationError(
      "D1 Insights GraphQL failed; check Analytics permissions and schema. Response bodies are not logged.",
    );
  const data = object(payload.data) ? payload.data : {};
  const viewer = object(data.viewer) ? data.viewer : {};
  const accounts = viewer.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1 || !object(accounts[0]))
    throw new SqlObservationError("D1 Insights did not return the requested account.");
  const account = accounts[0];
  const unique = new Map<string, SqlStats>();
  const limitHitBy: string[] = [];
  let inconsistentGroups = 0;
  for (const sort of SQL_SORTS) {
    const rows = account[sort];
    if (!Array.isArray(rows) || rows.length > SQL_OBSERVATION_GROUP_LIMIT)
      throw new SqlObservationError("D1 Insights returned an invalid query-group collection.");
    if (rows.length === SQL_OBSERVATION_GROUP_LIMIT) limitHitBy.push(sort);
    for (const row of rows) {
      if (
        !object(row) ||
        !object(row.dimensions) ||
        typeof row.dimensions.query !== "string" ||
        !object(row.sum)
      )
        throw new SqlObservationError("D1 Insights returned an invalid SQL query group.");
      const stats: SqlStats = {
        count: metric(row.count),
        rowsRead: metric(row.sum.rowsRead),
        rowsWritten: metric(row.sum.rowsWritten),
        rowsReturned: metric(row.sum.rowsReturned),
        durationMs: metric(row.sum.queryDurationMs),
      };
      const existing = unique.get(row.dimensions.query);
      if (!existing) unique.set(row.dimensions.query, stats);
      else if (STAT_FIELDS.some((field) => stats[field] !== existing[field])) inconsistentGroups++;
    }
  }
  const normalized = new Map<string, ObservedSql>();
  for (const [raw, stats] of unique) {
    const sql = redactSql(raw);
    const fingerprint = createHash("sha256").update(sql).digest("hex");
    const existing = normalized.get(fingerprint);
    if (existing)
      Object.assign(existing, sumStats([existing, stats]), { variants: existing.variants + 1 });
    else
      normalized.set(fingerprint, {
        ...stats,
        fingerprint,
        sql: sql.slice(0, MAX_SQL_CHARS),
        sqlTruncated: sql.length > MAX_SQL_CHARS,
        variants: 1,
      });
  }
  // Preserve high-cost reads AND writes/time/count if archive size must be bounded.
  const queries = [...normalized.values()];
  const ranking = ["rowsRead", "rowsWritten", "durationMs", "count"] as const;
  const maxima = Object.fromEntries(
    ranking.map((field) => [field, Math.max(1, ...queries.map((row) => row[field] ?? 0))]),
  );
  const score = (row: ObservedSql) =>
    Math.max(...ranking.map((field) => (row[field] ?? 0) / maxima[field]!));
  queries.sort((a, b) => score(b) - score(a) || a.fingerprint.localeCompare(b.fingerprint));
  return {
    schemaVersion: 1,
    source: "cloudflare-d1-insights",
    ...context,
    windowEnd: new Date(new Date(context.windowStart).getTime() + HOUR).toISOString(),
    coverage: {
      sampling: "cloudflare-adaptive",
      fullExecutionLog: false,
      groupLimit: SQL_OBSERVATION_GROUP_LIMIT,
      limitHitBy,
      inconsistentGroups,
      sourceQueryGroups: unique.size,
      omittedQueryGroups: 0,
    },
    totals: sumStats([...unique.values()]),
    queries,
  };
}

/** An hour has one replaceable object, so overlapping retries/late telemetry do not create
 * additive samples. Keep totals before truncation and explicitly account for omitted groups. */
export function encodeObservation(observation: SqlObservation): {
  observation: SqlObservation;
  bytes: Buffer;
} {
  const bounded = structuredClone(observation);
  for (;;) {
    const json = JSON.stringify(bounded);
    const bytes = gzipSync(json);
    if (
      Buffer.byteLength(json) <= SQL_OBSERVATION_MAX_JSON_BYTES &&
      bytes.length <= SQL_OBSERVATION_MAX_BYTES
    )
      return { observation: bounded, bytes };
    if (bounded.queries.length === 0)
      throw new SqlObservationError("SQL observation metadata exceeded the archive size bound.");
    const removed = bounded.queries.splice(Math.floor(bounded.queries.length / 2));
    bounded.coverage.omittedQueryGroups += removed.reduce((sum, row) => sum + row.variants, 0);
  }
}

export function decodeObservation(bytes: Uint8Array): SqlObservation {
  if (bytes.byteLength > SQL_OBSERVATION_MAX_BYTES)
    throw new SqlObservationError("SQL archive exceeded its compressed size bound.");
  const value: unknown = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: SQL_OBSERVATION_MAX_JSON_BYTES }).toString("utf8"),
  );
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.source !== "cloudflare-d1-insights" ||
    typeof value.databaseId !== "string" ||
    typeof value.windowStart !== "string" ||
    typeof value.windowEnd !== "string" ||
    typeof value.collectedAt !== "string" ||
    !Number.isFinite(Date.parse(value.collectedAt)) ||
    !object(value.totals) ||
    !object(value.coverage) ||
    !Array.isArray(value.queries) ||
    value.queries.length > 4 * SQL_OBSERVATION_GROUP_LIMIT
  )
    throw new SqlObservationError("Invalid SQL observation archive.");
  observationKey(value.databaseId, value.windowStart);
  if (Date.parse(value.windowEnd) !== Date.parse(value.windowStart) + HOUR)
    throw new SqlObservationError("Invalid SQL archive hour window.");
  for (const stats of [value.totals, ...value.queries]) {
    if (!object(stats)) throw new SqlObservationError("Invalid SQL archive metrics.");
    for (const field of STAT_FIELDS) {
      if (!(field in stats)) throw new SqlObservationError("Missing SQL archive metric.");
      metric(stats[field]);
    }
  }
  const coverage = value.coverage;
  if (
    coverage.sampling !== "cloudflare-adaptive" ||
    coverage.fullExecutionLog !== false ||
    coverage.groupLimit !== SQL_OBSERVATION_GROUP_LIMIT ||
    !Array.isArray(coverage.limitHitBy) ||
    !coverage.limitHitBy.every((sort) => SQL_SORTS.includes(sort)) ||
    ![coverage.inconsistentGroups, coverage.sourceQueryGroups, coverage.omittedQueryGroups].every(
      (count) => typeof count === "number" && Number.isInteger(count) && count >= 0,
    )
  )
    throw new SqlObservationError("Invalid SQL archive coverage.");
  for (const row of value.queries) {
    if (
      !object(row) ||
      typeof row.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
      typeof row.sql !== "string" ||
      row.sql.length > MAX_SQL_CHARS ||
      typeof row.sqlTruncated !== "boolean" ||
      typeof row.variants !== "number" ||
      !Number.isInteger(row.variants) ||
      row.variants < 1
    )
      throw new SqlObservationError("Invalid SQL archive query.");
  }
  return value as unknown as SqlObservation;
}

export function summarizeObservations(observations: SqlObservation[]) {
  const hours = new Map<string, SqlObservation>();
  const databaseIds = new Set(observations.map((item) => item.databaseId));
  if (databaseIds.size > 1)
    throw new SqlObservationError("Do not combine SQL archives from different databases.");
  for (const item of observations) {
    const prior = hours.get(item.windowStart);
    if (!prior || item.collectedAt > prior.collectedAt) hours.set(item.windowStart, item);
  }
  const queries = new Map<string, ObservedSql>();
  for (const hour of hours.values())
    for (const row of hour.queries) {
      const prior = queries.get(row.fingerprint);
      if (prior)
        Object.assign(prior, sumStats([prior, row]), { variants: prior.variants + row.variants });
      else queries.set(row.fingerprint, { ...row });
    }
  const ranked = (field: keyof SqlStats) =>
    [...queries.values()].sort((a, b) => (b[field] ?? -1) - (a[field] ?? -1)).slice(0, 20);
  return {
    databaseId: [...databaseIds][0] ?? null,
    source: "cloudflare-d1-insights",
    fullExecutionLog: false,
    hours: [...hours.values()].map(({ windowStart, windowEnd, collectedAt, coverage, totals }) => ({
      windowStart,
      windowEnd,
      collectedAt,
      coverage,
      totals,
    })),
    totals: sumStats([...hours.values()].map((item) => item.totals)),
    topReads: ranked("rowsRead"),
    topWrites: ranked("rowsWritten"),
    topTime: ranked("durationMs"),
    topCount: ranked("count"),
  };
}
