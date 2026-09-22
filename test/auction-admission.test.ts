import { beforeAll, afterAll, it, expect } from "vite-plus/test";
import { build } from "vite-plus";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { initialAuctionRuntime } from "../src/auctions/runtime-policy.js";
let mf: Miniflare;
beforeAll(async () => {
  const bundle = await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry: "test/auction-admission-worker.ts", formats: ["es"] },
      rollupOptions: { external: ["cloudflare:workers"] },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!("output" in output)) throw new Error("bundle");
  const chunk = output.output.find((row) => row.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("chunk");
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: chunk.code,
      compatibilityDate: "2026-08-11",
      durableObjects: {
        ADMISSION: { className: "TestAdmission", useSQLite: true },
        AUCTIONS: { className: "TestAuction", useSQLite: true },
      },
    }),
  );
}, 30_000);
afterAll(async () => mf?.dispose());
it("admits durable stop controls after normal public/admin admission is exhausted", async () => {
  await mf.dispatchFetch("https://test.invalid/seed");
  expect((await mf.dispatchFetch("https://test.invalid/admin/status")).status).toBe(503);
  for (const action of ["pause", "public_pause"]) {
    const response = await mf.dispatchFetch("https://test.invalid/admin/control", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    expect(response.status).toBe(200);
  }
  const state = (await (await mf.dispatchFetch("https://test.invalid/state")).json()) as ReturnType<
    typeof initialAuctionRuntime
  >;
  expect(state.paused).toBe(true);
  expect(state.publicPaused).toBe(true);
  expect(state.reserved.requests).toBe(4002);
  expect(
    (
      await mf.dispatchFetch("https://test.invalid/admin/control", {
        method: "POST",
        body: JSON.stringify({ action: "resume" }),
      })
    ).status,
  ).toBe(503);
});
it("defers exhausted discovery without imposing its soft ceiling on a ready confirmation", async () => {
  const now = Date.parse("2099-09-22T01:00:00Z");
  async function call(input: Record<string, unknown>) {
    const r = await mf.dispatchFetch("https://test.invalid/fixture", {
      method: "POST",
      body: JSON.stringify({ now, ...input }),
    });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()) as {
      calls: string[];
      state: ReturnType<typeof initialAuctionRuntime>;
      tasks: { value: string }[];
    };
  }
  const state = initialAuctionRuntime(now);
  state.paused = false;
  state.categories = ["2084037425"];
  state.reserved.writes = 6500;
  state.robots = { text: "User-agent: *\nAllow: /", observedAt: now, delayMs: 60_000 };
  await call({ op: "state", state });
  for (const kind of ["discover", "confirm"])
    await call({
      op: "task",
      task: {
        id: kind,
        kind,
        categoryId: "2084037425",
        auctionId: kind === "confirm" ? "a000001" : null,
        page: 1,
        due: now,
        attempts: 0,
        sequence: null,
      },
    });
  const deferred = await call({ op: "alarm" });
  expect(deferred.calls).toHaveLength(0);
  expect(deferred.state.backoffUntil).toBe(0);
  expect(
    deferred.tasks.map((row) => JSON.parse(row.value)).find((row) => row.id === "discover").due,
  ).toBe(Date.parse("2099-09-23T00:00:00Z"));
  const confirmed = await call({
    op: "alarm",
    response: { status: 404, text: null, retryAfter: null, authenticationRequired: false },
  });
  expect(confirmed.calls).toHaveLength(1);
  expect(confirmed.state.reserved.writes).toBe(8500);
});
