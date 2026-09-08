import type {
  AdminOperations,
  AdminSqlSnapshot,
  AdminRuntimeSnapshot,
  AdminSqlMetrics,
} from "../api/admin-listing-contracts.js";
import { isRecord } from "../types.js";

export const ADMIN_SNAPSHOT_MAX_BYTES = 64 * 1024;
export const ADMIN_SQL_SNAPSHOT_KEY = "admin/v1/sql-load.json";
export const ADMIN_RUNTIME_SNAPSHOT_KEY = "admin/v1/runtime.json";
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = (value: unknown): string => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("invalid_snapshot_timestamp");
  return value;
};
function metrics(value: unknown): AdminSqlMetrics {
  if (!isRecord(value)) throw new Error("invalid_snapshot_metrics");
  return {
    count: number(value.count),
    rowsRead: number(value.rowsRead),
    rowsWritten: number(value.rowsWritten),
    durationMs: number(value.durationMs),
  };
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error("invalid_snapshot_array");
  return value;
}
/** The archive bucket contains private SQL too. Only these allowlisted fields reach the console. */
export function parseAdminSqlSnapshot(value: unknown): AdminSqlSnapshot {
  if (!isRecord(value)) throw new Error("invalid_sql_snapshot");
  const ranking = (rows: unknown) =>
    array(rows, 20).map((row) => {
      if (
        !isRecord(row) ||
        typeof row.fingerprint !== "string" ||
        !/^[a-f0-9]{16,64}$/u.test(row.fingerprint) ||
        typeof row.operation !== "string" ||
        !/^[A-Z]{2,10}$/u.test(row.operation)
      )
        throw new Error("invalid_sql_ranking");
      return { fingerprint: row.fingerprint, operation: row.operation, ...metrics(row) };
    });
  return {
    generatedAt: timestamp(value.generatedAt),
    requestedHours: array(value.requestedHours, 24).map(timestamp),
    missingHours: array(value.missingHours, 24).map(timestamp),
    observedTotals: metrics(value.observedTotals),
    hours: array(value.hours, 24).map((row) => {
      if (!isRecord(row)) throw new Error("invalid_sql_hour");
      const coverage = isRecord(row.coverage) ? row.coverage : {};
      const limited =
        row.limited === true ||
        (Array.isArray(coverage.limitHitBy) && coverage.limitHitBy.length > 0) ||
        (number(coverage.omittedQueryGroups) ?? 0) > 0 ||
        (number(coverage.inconsistentGroups) ?? 0) > 0;
      return {
        windowStart: timestamp(row.windowStart),
        windowEnd: timestamp(row.windowEnd),
        collectedAt: timestamp(row.collectedAt),
        provisional: row.provisional === true,
        totals: metrics(row.totals),
        limited,
      };
    }),
    topReads: ranking(value.topReads),
    topWrites: ranking(value.topWrites),
  };
}
export function parseAdminRuntimeSnapshot(value: unknown): AdminRuntimeSnapshot {
  if (!isRecord(value)) throw new Error("invalid_runtime_snapshot");
  let deployment: AdminRuntimeSnapshot["deployment"] = null;
  const d = value.deployment;
  if (
    isRecord(d) &&
    typeof d.targetSha === "string" &&
    /^[a-f0-9]{40}$/u.test(d.targetSha) &&
    ["deferred", "success", "failure", "pending"].includes(String(d.state))
  ) {
    deployment = {
      targetSha: d.targetSha,
      state: d.state as NonNullable<AdminRuntimeSnapshot["deployment"]>["state"],
      updatedAt: d.updatedAt ? timestamp(d.updatedAt) : null,
      runUrl:
        typeof d.runUrl === "string" &&
        /^https:\/\/github\.com\/apaapapapapa\/HiFiScout\/actions\/runs\/\d+$/u.test(d.runUrl)
          ? d.runUrl
          : null,
    };
  }
  return {
    generatedAt: timestamp(value.generatedAt),
    windowStart: timestamp(value.windowStart),
    windowEnd: timestamp(value.windowEnd),
    deployment,
    workerStats: array(value.workerStats, 2).map((row) => {
      if (!isRecord(row) || !["hifiscout", "hifiscout-admin"].includes(String(row.worker)))
        throw new Error("invalid_worker_stats");
      return {
        worker: String(row.worker),
        available: row.available === true,
        limitHit: row.limitHit === true,
        statuses: array(row.statuses, 50).map((status) => {
          if (
            !isRecord(status) ||
            typeof status.status !== "string" ||
            !/^[a-zA-Z_]{1,60}$/u.test(status.status)
          )
            throw new Error("invalid_worker_status");
          return {
            status: status.status,
            requests: number(status.requests),
            errors: number(status.errors),
          };
        }),
      };
    }),
  };
}

export async function readAdminOperations(env: {
  OPS_BUCKET?: Pick<R2Bucket, "get">;
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
}): Promise<AdminOperations> {
  const unavailable: string[] = [];
  async function read<T>(key: string, parse: (value: unknown) => T): Promise<T | null> {
    try {
      const object = await env.OPS_BUCKET?.get(key);
      if (!object || object.size > ADMIN_SNAPSHOT_MAX_BYTES)
        throw new Error("snapshot_unavailable");
      return parse(await object.json());
    } catch {
      unavailable.push(key === ADMIN_SQL_SNAPSHOT_KEY ? "D1集計" : "実行統計・反映状況");
      return null;
    }
  }
  const [sql, runtime] = await Promise.all([
    read(ADMIN_SQL_SNAPSHOT_KEY, parseAdminSqlSnapshot),
    read(ADMIN_RUNTIME_SNAPSHOT_KEY, parseAdminRuntimeSnapshot),
  ]);
  const version = env.CF_VERSION_METADATA;
  return {
    observedAt: new Date().toISOString(),
    version: {
      id: version?.id ?? null,
      tag: version?.tag ?? null,
      timestamp: version?.timestamp ?? null,
    },
    sql,
    runtime,
    unavailable,
  };
}
