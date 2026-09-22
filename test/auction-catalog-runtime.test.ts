import { afterAll, beforeAll, it, expect } from "vite-plus/test";
import { build } from "vite-plus";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { auctionSnapshot } from "./helpers/auction-snapshot.js";
import {
  auctionCatalogInput,
  AUCTION_CATALOG_RULE,
  AUCTION_CATALOG_TTL,
  currentAuctionIdentity,
} from "../src/auctions/catalog.js";
import type { AuctionSqlUsage } from "../src/auctions/storage.js";
import { recordCostSample } from "../scripts/harness/cost.js";

const now = Date.parse("2099-09-22T01:00:00Z");
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
      lib: { entry: "test/auction-catalog-worker.ts", formats: ["es"] },
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
      durableObjects: { AUCTIONS: { className: "TestCatalog", useSQLite: true } },
    }),
  );
}, 30_000);
afterAll(async () => mf?.dispose());
type Result = {
  usage: Record<string, AuctionSqlUsage>;
  calls: string[][];
  items: { auction_id: string; identity: string; match_revision: string }[];
  pending: unknown[];
  cache: { value: string; expires: number }[];
  nextDue: number | null;
};
async function call(path: string, input: Record<string, unknown>): Promise<Result> {
  const r = await mf.dispatchFetch(`https://test.invalid/${path}`, {
    method: "POST",
    body: JSON.stringify({ now, ...input }),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as Result;
}
function observation(id: string) {
  const o = auctionSnapshot();
  o.auctionId = id;
  o.sourceUrl = `https://auctions.yahoo.co.jp/jp/auction/${id}`;
  o.item = {
    ...o.item,
    title: "DENON PMA-1700NE",
    rawManufacturer: "DENON",
    rawModel: "PMA-1700NE",
    saleSubject: "main_unit",
    saleUnit: "single",
  };
  return o;
}
function entry() {
  return {
    input: auctionCatalogInput(observation("a000001").item),
    manufacturerId: "denon",
    manufacturerName: "DENON",
    model: "PMA-1700NE",
    candidates: [
      {
        id: 900001,
        manufacturerId: "denon",
        canonicalModel: "PMA-1700NE",
        canonicalName: "PMA-1700NE",
        categoryIds: ["AMP.INTEGRATED"],
      },
    ],
    revision: "revision-1",
    rule: AUCTION_CATALOG_RULE,
  };
}
const matched = (r: Result) =>
  r.items.filter((row) => JSON.parse(row.identity).catalogProductId === 900001);
it("shares one key, resumes bounded registration, replays negative changes and does no price lookup", async () => {
  const items = Array.from({ length: 41 }, (_, i) => observation(`a${String(i).padStart(6, "0")}`));
  items[1].item.saleSubject = "empty_box";
  await call("shared", { op: "apply", observations: items });
  const first = await call("shared", { op: "refresh", entries: [entry()] });
  expect(first.calls).toEqual([[entry().input.key]]);
  expect(matched(first)).toHaveLength(19);
  const second = await call("shared", { op: "refresh", entries: [] });
  expect(second.calls).toEqual([]);
  expect(matched(second)).toHaveLength(39);
  const third = await call("shared", { op: "refresh", entries: [] });
  expect(third.calls).toEqual([]);
  expect(matched(third)).toHaveLength(40);
  const price = structuredClone(items[0]);
  price.stamp.sequence++;
  price.live.currentPrice!.value.amountYen = 1;
  await call("shared", { op: "apply", observations: [price] });
  const unchanged = await call("shared", { op: "refresh", entries: [] });
  expect(unchanged.calls).toEqual([]);
  expect(Object.values(unchanged.usage).reduce((n, s) => n + s.rowsWritten, 0)).toBe(0);
  await recordCostSample(
    "auction-catalog-replay",
    "local-workerd",
    {
      rowsRead: Object.values(unchanged.usage).reduce((n, s) => n + s.rowsRead, 0),
      rowsWritten: 0,
      sqlStatements: Object.values(unchanged.usage).reduce((n, s) => n + s.statements, 0),
    },
    ["test/auction-catalog-runtime.test.ts", "test/auction-catalog-worker.ts"],
    [
      "Price-only update keeps candidate key and does not query D1 or rewrite identity; workerd cursors consumed.",
    ],
  );
  const withdrawn = { ...entry(), revision: "revision-2", candidates: [] };
  const revoked = await call("shared", {
    op: "refresh",
    now: now + AUCTION_CATALOG_TTL,
    entries: [withdrawn],
  });
  expect(revoked.calls).toHaveLength(1);
  expect(matched(revoked)).toHaveLength(21);
  expect(revoked.cache[0].value).toContain("revision-2"); // Public readers must compare this revision before using any old item identity.
  expect(
    revoked.items
      .map((row) =>
        currentAuctionIdentity(
          JSON.parse(row.identity),
          row.match_revision,
          revoked.cache[0],
          now + AUCTION_CATALOG_TTL,
        ),
      )
      .filter((identity) => identity.catalogProductId),
  ).toHaveLength(0);
  expect(
    first.items
      .map((row) =>
        currentAuctionIdentity(
          JSON.parse(row.identity),
          row.match_revision,
          first.cache[0],
          now + AUCTION_CATALOG_TTL,
        ),
      )
      .filter((identity) => identity.catalogProductId),
  ).toHaveLength(0);
  await call("shared", { op: "refresh", now: now + AUCTION_CATALOG_TTL, entries: [] });
  const complete = await call("shared", {
    op: "refresh",
    now: now + AUCTION_CATALOG_TTL,
    entries: [],
  });
  expect(matched(complete)).toHaveLength(0);
  expect(complete.pending).toHaveLength(0);
  const recovered = await call("shared", {
    op: "refresh",
    now: now + 2 * AUCTION_CATALOG_TTL,
    entries: [entry()],
  });
  expect(matched(recovered)).toHaveLength(19);
});
it("fences a delayed catalog reply after pause and leaves a durable retry deadline", async () => {
  await call("pause", { op: "apply", observations: [observation("b000001")] });
  const result = await call("pause", { op: "run", entries: [entry()], pauseDuringRead: true });
  expect(matched(result)).toHaveLength(0);
  expect(result.cache[0].expires).toBe(0);
  expect(result.nextDue).toBe(now + 5 * 60_000);
});

it("retired candidate keys stop D1 renewal and disappear through bounded retention", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => observation(`c${String(i).padStart(6, "0")}`));
  await call("retired", { op: "apply", observations: rows });
  const populated = await call("retired", { op: "refresh", entries: [entry()] });
  expect(populated.pending).toHaveLength(1);
  const retired = await call("retired", { op: "retain" });
  expect(retired.items).toHaveLength(0);
  expect(retired.pending).toHaveLength(0);
  const expires = retired.cache[0].expires;
  const refreshed = await call("retired", {
    op: "run",
    now: now + AUCTION_CATALOG_TTL,
    entries: [entry()],
  });
  expect(refreshed.calls).toEqual([]);
  expect(refreshed.cache[0].expires).toBe(expires);
  expect(refreshed.nextDue).toBeNull();
  const deleted = await call("retired", { op: "retain", now: now + 2 * 86_400_000 });
  expect(deleted.cache).toHaveLength(0);
});
