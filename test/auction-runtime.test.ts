import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { build } from "vite-plus";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { auctionSnapshot } from "./helpers/auction-snapshot.js";
import {
  initialAuctionRuntime,
  reserveAuctionBudget,
  emptyAuctionCharge,
} from "../src/auctions/runtime-policy.js";
import type { AuctionRuntimeState } from "../src/auctions/runtime-policy.js";
import type { AuctionSqlUsage, StoredAuction } from "../src/auctions/storage.js";
import { readFileSync } from "node:fs";
import { recordCostSample } from "../scripts/harness/cost.js";

const now = Date.parse("2099-09-22T01:00:00Z");
let mf: Miniflare;
type Result = {
  usage: Record<string, AuctionSqlUsage>;
  state: AuctionRuntimeState;
  item: StoredAuction | null;
  calls: string[];
  hits: unknown[];
  receipts: unknown[];
  tasks: { value: string }[];
  alarm: number | null;
};
async function call(input: Record<string, unknown>): Promise<Result> {
  const response = await mf.dispatchFetch("https://fixture.test/", {
    method: "POST",
    body: JSON.stringify({ now, ...input }),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as Result;
}
beforeAll(async () => {
  const bundle = await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: {
        entry: "test/fixtures/auction-runtime-worker.ts",
        formats: ["es"],
      },
      rollupOptions: { external: ["cloudflare:workers"] },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!("output" in output)) throw new Error("missing_fixture_bundle");
  const chunk = output.output.find((output) => output.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("missing_fixture_chunk");
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: chunk.code,
      compatibilityDate: "2026-08-11",
      durableObjects: { AUCTIONS: { className: "TestAuction", useSQLite: true } },
    }),
  );
}, 30_000);
afterAll(async () => {
  await mf?.dispose();
});

describe("SQLite auction runtime", () => {
  it("commits separately, replays without writes and supports Japanese trigram in workerd", async () => {
    const observation = auctionSnapshot();
    observation.item.title += " 真空管アンプ";
    const saved = await call({
      op: "apply",
      observations: [observation],
      id: observation.auctionId,
      text: "真空管",
    });
    expect(saved.item?.snapshot.auctionId).toBe(observation.auctionId);
    expect(saved.hits).toHaveLength(1);
    const replay = await call({ op: "apply", observations: [observation] });
    expect(Object.values(replay.usage).reduce((sum, family) => sum + family.rowsWritten, 0)).toBe(
      0,
    );
    await recordCostSample(
      "auction-replay",
      "local-workerd",
      {
        rowsRead: Object.values(replay.usage).reduce((sum, family) => sum + family.rowsRead, 0),
        rowsWritten: 0,
        sqlStatements: Object.values(replay.usage).reduce(
          (sum, family) => sum + family.statements,
          0,
        ),
      },
      ["test/auction-runtime.test.ts"],
      ["Real SQLite DO replay; schema initialization excluded; no D1 or seller calls."],
    );
    const updated = structuredClone(observation);
    const unrelated = Array.from({ length: 1999 }, (_, index) => ({
      ...structuredClone(observation),
      auctionId: `z${String(index).padStart(8, "0")}`,
      sourceUrl: `https://auctions.yahoo.co.jp/jp/auction/z${String(index).padStart(8, "0")}`,
    }));
    await call({ op: "apply", observations: unrelated });
    const overflow = {
      ...structuredClone(observation),
      auctionId: "z99999999",
      sourceUrl: "https://auctions.yahoo.co.jp/jp/auction/z99999999",
    };
    expect(
      (await call({ op: "apply", observations: [overflow], id: overflow.auctionId })).item,
    ).toBeNull();
    updated.stamp.sequence++;
    updated.live.currentPrice!.value.amountYen = 1;
    const live = await call({ op: "apply", observations: [updated] });
    expect(live.usage.fts).toBeUndefined();
    expect(live.usage.item.rowsWritten).toBe(0);
    expect(live.usage.live.rowsWritten).toBeGreaterThan(0);
    await recordCostSample(
      "auction-price-change",
      "local-workerd",
      {
        rowsRead: Object.values(live.usage).reduce((sum, family) => sum + family.rowsRead, 0),
        rowsWritten: Object.values(live.usage).reduce((sum, family) => sum + family.rowsWritten, 0),
        sqlStatements: Object.values(live.usage).reduce(
          (sum, family) => sum + family.statements,
          0,
        ),
      },
      ["test/auction-runtime.test.ts"],
      ["Real SQLite DO price-only change, FTS and static item rows unchanged."],
    );
  }, 30_000);
  it("rolls back item, FTS and live state together on a commit interruption", async () => {
    const observation = auctionSnapshot();
    observation.stamp.sequence = 3;
    observation.item.title = "rolled back title";
    const result = await call({
      op: "apply",
      observations: [observation],
      failCommit: true,
      id: observation.auctionId,
    });
    expect(result.item?.snapshot.stamp.sequence).toBe(2);
    expect(result.item?.snapshot.item.title).not.toBe("rolled back title");
  });
  it("persists pause and fences generations without resetting the UTC budget", async () => {
    const state = { ...initialAuctionRuntime(now), paused: false, categories: ["2084037425"] };
    state.reserved.sellerRequests = 499;
    await call({ op: "state", state });
    const paused = await call({ op: "control", action: "pause" });
    expect(paused.state.paused).toBe(true);
    expect(paused.state.generation).toBe(2);
    const resumed = await call({ op: "control", action: "resume" });
    expect(resumed.state.reserved.sellerRequests).toBe(499);
    expect((await call({ op: "alarm" })).calls).toHaveLength(0);
  });
  it("never fetches at night and respects Retry-After without inventing auction endings", async () => {
    await call({
      op: "state",
      state: { ...initialAuctionRuntime(now), paused: false, categories: ["2084037425"] },
    });
    await call({
      op: "task",
      task: {
        id: "discover:2084037425",
        kind: "discover",
        categoryId: "2084037425",
        auctionId: null,
        page: 1,
        due: now,
        attempts: 0,
        sequence: null,
      },
    });
    const night = await call({ op: "alarm", now: Date.parse("2099-09-22T14:00:00Z") });
    expect(night.calls).toHaveLength(0);
    expect(night.alarm).toBe(Date.parse("2099-09-22T23:00:00Z"));
    const throttled = await call({
      op: "alarm",
      response: { status: 429, text: null, retryAfter: "7200", authenticationRequired: false },
    });
    expect(throttled.calls).toHaveLength(1);
    expect(throttled.state.backoffUntil).toBe(now + 7_200_000);
    expect(throttled.state.reserved.sellerRequests).toBe(1);
    expect(throttled.state.coverage).toBe("unknown");
    expect((await call({ op: "alarm", now: now + 120_000 })).calls).toHaveLength(0);
  });
  it("persists a robots permit, receipt and page cursor; duplicate alarms do not fetch again", async () => {
    await call({
      op: "state",
      state: { ...initialAuctionRuntime(now), paused: false, categories: ["2084037425"] },
    });
    await call({
      op: "task",
      task: {
        id: "discover:2084037425",
        kind: "discover",
        categoryId: "2084037425",
        auctionId: null,
        page: 1,
        due: now,
        attempts: 0,
        sequence: null,
      },
    });
    const robots = await call({
      op: "alarm",
      response: {
        status: 200,
        text: "User-agent: *\nAllow: /\nCrawl-delay: 90",
        retryAfter: null,
        authenticationRequired: false,
      },
    });
    expect(robots.state.nextFetchAt).toBe(now + 90_000);
    expect((await call({ op: "alarm", now: now + 60_000 })).calls).toHaveLength(0);
    const page = await call({
      op: "alarm",
      now: now + 90_000,
      response: {
        status: 200,
        text: readFileSync("test/fixtures/yahoo-auctions.synthetic.html", "utf8"),
        retryAfter: null,
        authenticationRequired: false,
      },
    });
    expect(page.state.lastSuccessAt).toBe(new Date(now + 90_000).toISOString());
    expect(page.receipts).toHaveLength(2);
    expect(
      page.tasks.map((row) => JSON.parse(row.value)).find((row) => row.kind === "discover").page,
    ).toBe(2);
    const replay = await call({ op: "alarm", now: now + 90_000 });
    expect(replay.calls).toHaveLength(0);
    expect(replay.receipts).toHaveLength(2);
  });
});
it("does not restore budget at JST midnight, 08:00, restarts or a backwards clock", () => {
  const before = Date.parse("2026-09-22T13:59:00Z");
  const state = initialAuctionRuntime(before);
  state.reserved.sellerRequests = 500;
  const charge = { ...emptyAuctionCharge(), sellerRequests: 1 };
  for (const time of [
    before,
    before + 61_000,
    Date.parse("2026-09-22T23:00:00Z"),
    before - 86_400_000,
  ])
    expect(reserveAuctionBudget(state, charge, time)).toBeNull();
  expect(
    reserveAuctionBudget(state, charge, Date.parse("2026-09-23T00:00:00Z"))?.reserved
      .sellerRequests,
  ).toBe(1);
});
