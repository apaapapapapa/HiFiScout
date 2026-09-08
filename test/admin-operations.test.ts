import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  parseAdminSqlSnapshot,
  readAdminOperations,
  ADMIN_SQL_SNAPSHOT_KEY,
  ADMIN_RUNTIME_SNAPSHOT_KEY,
} from "../src/admin/operations.js";
import { buildRuntimeSnapshot, deploymentState } from "../scripts/lib/admin-runtime-snapshot.js";
import { buildSqlLoadReport } from "../scripts/lib/d1-sql-report.js";

const at = "2026-09-08T00:00:00.000Z";
test("missing SQL archives stay unknown and private SQL never crosses the snapshot boundary", () => {
  const report = buildSqlLoadReport(
    {
      databaseId: "00000000-0000-4000-8000-000000000000",
      requestedHours: [at],
      missingHours: [at],
      archives: [],
    },
    { generatedAt: new Date(at) },
  );
  const snapshot = parseAdminSqlSnapshot({ ...report, sql: "PRIVATE", secret: "SECRET" });
  assert.equal(snapshot.observedTotals.rowsRead, null);
  assert.equal(snapshot.hours.length, 0);
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);
  assert.throws(() =>
    parseAdminSqlSnapshot({
      ...report,
      topReads: [{ fingerprint: "private text", operation: "SELECT" }],
    }),
  );
});

test("dashboard reads exactly two fixed objects, degrades independently and reports the serving version", async () => {
  const keys: string[] = [];
  const env = {
    CF_VERSION_METADATA: { id: "actual-version" },
    OPS_BUCKET: {
      async get(key: string) {
        keys.push(key);
        if (key === ADMIN_SQL_SNAPSHOT_KEY)
          return {
            size: 70_000,
            json: async () => {
              throw new Error("oversize must not be decoded");
            },
          };
        return {
          size: 200,
          json: async () => ({
            generatedAt: at,
            windowStart: at,
            windowEnd: at,
            workerStats: [],
            deployment: null,
            secret: "PRIVATE",
          }),
        };
      },
    },
  };
  const result = await readAdminOperations(
    env as unknown as Parameters<typeof readAdminOperations>[0],
  );
  assert.deepEqual(keys.sort(), [ADMIN_RUNTIME_SNAPSHOT_KEY, ADMIN_SQL_SNAPSHOT_KEY].sort());
  assert.equal(result.version.id, "actual-version");
  assert.deepEqual(result.unavailable, ["D1集計"]);
  assert.ok(result.runtime);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("native invocation statuses retain CPU failures and missing metrics without assuming zero", async () => {
  const calls: string[] = [];
  const snapshot = await buildRuntimeSnapshot(
    {
      async workerStatusMetrics(worker) {
        calls.push(worker);
        if (worker === "hifiscout-admin") throw new Error("no access");
        return {
          data: {
            viewer: {
              accounts: [
                {
                  workersInvocationsAdaptive: [
                    {
                      dimensions: { status: "exceededCpu" },
                      sum: { requests: 4, errors: null },
                      private: "SECRET",
                    },
                  ],
                },
              ],
            },
          },
        };
      },
    },
    async () => {
      throw new Error("GitHub unavailable");
    },
    new Date(at),
  );
  assert.equal(calls.length, 2);
  assert.equal(snapshot.workerStats[0].statuses[0].requests, 4);
  assert.equal(snapshot.workerStats[0].statuses[0].errors, null);
  assert.equal(snapshot.workerStats[1].available, false);
  assert.equal(snapshot.deployment, null);
  assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);
});

test("a green quota-deferred status is distinct from a completed deployment", () => {
  const status = deploymentState("a".repeat(40), {
    statuses: [
      {
        context: "deployment/cloudflare",
        state: "success",
        description: "Cloudflare deployment deferred by D1 quota: success",
        created_at: at,
      },
    ],
  });
  assert.equal(status?.state, "deferred");
  assert.equal(deploymentState("a".repeat(40), { statuses: [] })?.state, "pending");
});
