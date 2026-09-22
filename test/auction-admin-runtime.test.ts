import { auctionSnapshot } from "./helpers/auction-snapshot.js";
import { it, expect } from "vite-plus/test";
import { build } from "vite-plus";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { AuctionAdminStatus } from "../src/api/admin-auction-contracts.js";
import type { AuctionSqlUsage } from "../src/auctions/storage.js";
import { recordCostSample } from "../scripts/harness/cost.js";
it("bounds administrative status and keeps unknown usage separate from real counts and stopping", async () => {
  const bundle = await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry: "test/auction-admin-worker.ts", formats: ["es"] },
      rollupOptions: { external: ["cloudflare:workers"] },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!("output" in output)) throw new Error("bundle");
  const chunk = output.output.find((row) => row.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("chunk");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: chunk.code,
      compatibilityDate: "2026-08-11",
      durableObjects: { AUCTIONS: { className: "TestAuctionAdmin", useSQLite: true } },
    }),
  );
  const call = (path: string) => mf.dispatchFetch(`https://test.invalid${path}`);
  try {
    expect(
      (
        await mf.dispatchFetch("https://test.invalid/seed", {
          method: "POST",
          body: JSON.stringify(auctionSnapshot()),
        })
      ).status,
    ).toBe(200);
    const measured = (await (await call("/measure-status")).json()) as {
      status: AuctionAdminStatus;
      usage: Record<string, AuctionSqlUsage>;
      alarms: { get: number; set: number; delete: number };
    };
    expect(measured.status.retainedItems).toBe(2000);
    expect(measured.status.pendingTasks).toBe(1990);
    expect(measured.status.exhaustedTasks).toBe(10);
    expect(measured.status.endCheckPending).toBe(2000);
    expect(measured.status.catalogPendingKeys).toBe(2000);
    expect(measured.status.productionUsage).toBeNull();
    expect(measured.status.access.collect).toBe(false);
    expect(measured.alarms).toEqual({ get: 1, set: 0, delete: 0 });
    const metrics = {
      rowsRead: Object.values(measured.usage).reduce((n, s) => n + s.rowsRead, 0),
      rowsWritten: Object.values(measured.usage).reduce((n, s) => n + s.rowsWritten, 0),
      sqlStatements: Object.values(measured.usage).reduce((n, s) => n + s.statements, 0),
    };
    expect(metrics.rowsRead).toBeLessThanOrEqual(10100);
    expect(metrics.rowsWritten).toBe(0);
    await recordCostSample(
      "auction-admin-status",
      "local-workerd",
      metrics,
      ["test/auction-admin-runtime.test.ts", "test/auction-admin-worker.ts"],
      [
        "2,000 retained items, tasks and replay keys; one getAlarm, no D1, seller or data writes. Production class admission reserves 10,100 reads/100 writes and one Alarm operation separately.",
      ],
    );
    for (const action of [["pause"], 0, null, "sql"])
      expect(
        (
          await mf.dispatchFetch("https://test.invalid/admin/control", {
            method: "POST",
            body: JSON.stringify({ action }),
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await mf.dispatchFetch("https://test.invalid/admin/control", {
          method: "POST",
          body: JSON.stringify({ action: "clear_halt", reviewed: true }),
        })
      ).status,
    ).toBe(409);
    const status = (await (await call("/admin/status")).json()) as AuctionAdminStatus;
    expect(status.state.reserved.requests).toBe(1);
    expect(status.state.reserved.alarmOperations).toBe(1);
    expect(
      (
        await mf.dispatchFetch("https://test.invalid/admin/control", {
          method: "POST",
          body: JSON.stringify({ action: "pause" }),
        })
      ).status,
    ).toBe(200);
    const state = (await (await call("/state")).json()) as AuctionAdminStatus["state"];
    expect(state.paused).toBe(true);
    expect(state.reserved.alarmOperations).toBe(5);
  } finally {
    await mf.dispose();
  }
}, 30000);
