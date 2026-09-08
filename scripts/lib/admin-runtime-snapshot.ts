import { isRecord } from "../../src/types.js";
import { parseAdminRuntimeSnapshot } from "../../src/admin/operations.js";
import type { AdminRuntimeSnapshot } from "../../src/api/admin-listing-contracts.js";
import type { SqlObservationClient } from "./d1-sql-observation-client.js";

export function workerStatuses(
  payload: unknown,
): AdminRuntimeSnapshot["workerStats"][number]["statuses"] {
  if (!isRecord(payload) || (Array.isArray(payload.errors) && payload.errors.length))
    throw new Error("worker_stats_unavailable");
  const data = payload.data;
  const viewer = isRecord(data) ? data.viewer : null;
  const accounts = isRecord(viewer) ? viewer.accounts : null;
  const account = Array.isArray(accounts) && accounts.length === 1 ? accounts[0] : null;
  const rows = isRecord(account) ? account.workersInvocationsAdaptive : null;
  if (!Array.isArray(rows) || rows.length > 50) throw new Error("worker_stats_unavailable");
  return rows.map((row) => {
    if (
      !isRecord(row) ||
      !isRecord(row.dimensions) ||
      !isRecord(row.sum) ||
      typeof row.dimensions.status !== "string"
    )
      throw new Error("invalid_worker_metric");
    const metric = (n: unknown) =>
      typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
    return {
      status: row.dimensions.status,
      requests: metric(row.sum.requests),
      errors: metric(row.sum.errors),
    };
  });
}
export function deploymentState(sha: string, payload: unknown): AdminRuntimeSnapshot["deployment"] {
  if (!/^[a-f0-9]{40}$/u.test(sha) || !isRecord(payload) || !Array.isArray(payload.statuses))
    throw new Error("deployment_state_unavailable");
  const statuses = payload.statuses
    .filter(isRecord)
    .filter((s) => s.context === "deployment/cloudflare")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const status = statuses[0];
  const deferred =
    typeof status?.description === "string" &&
    status.description.startsWith("Cloudflare deployment deferred by D1 quota");
  return {
    targetSha: sha,
    state: deferred
      ? "deferred"
      : status?.state === "success"
        ? "success"
        : status?.state === "failure" || status?.state === "error"
          ? "failure"
          : "pending",
    updatedAt: typeof status?.created_at === "string" ? status.created_at : null,
    runUrl: typeof status?.target_url === "string" ? status.target_url : null,
  };
}
export async function buildRuntimeSnapshot(
  client: Pick<SqlObservationClient, "workerStatusMetrics">,
  github: (path: string) => Promise<unknown>,
  now = new Date(),
): Promise<AdminRuntimeSnapshot> {
  const windowEnd = new Date(now.getTime() - 5 * 60_000).toISOString();
  const windowStart = new Date(Date.parse(windowEnd) - 24 * 3_600_000).toISOString();
  const workerStats = [];
  for (const worker of ["hifiscout", "hifiscout-admin"] as const) {
    try {
      const statuses = workerStatuses(
        await client.workerStatusMetrics(worker, windowStart, windowEnd),
      );
      workerStats.push({ worker, available: true, limitHit: statuses.length === 50, statuses });
    } catch {
      workerStats.push({ worker, available: false, limitHit: false, statuses: [] });
    }
  }
  let deployment: AdminRuntimeSnapshot["deployment"] = null;
  try {
    const main = await github("git/ref/heads/main");
    if (
      !isRecord(main) ||
      !isRecord(main.object) ||
      typeof main.object.sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(main.object.sha)
    )
      throw new Error("invalid_main_sha");
    deployment = deploymentState(
      main.object.sha,
      await github(`commits/${main.object.sha}/status?per_page=100`),
    );
  } catch {
    /* Missing control-plane data is recorded as unknown, independently of Worker metrics. */
  }
  return parseAdminRuntimeSnapshot({
    generatedAt: now.toISOString(),
    windowStart,
    windowEnd,
    workerStats,
    deployment,
  });
}
