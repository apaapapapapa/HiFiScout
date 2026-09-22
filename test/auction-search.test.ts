import { beforeAll, afterAll, it, expect } from "vite-plus/test";
import { build } from "vite-plus";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { auctionSnapshot } from "./helpers/auction-snapshot.js";
import {
  auctionCatalogInput,
  AUCTION_CATALOG_RULE,
  AUCTION_CATALOG_TTL,
} from "../src/auctions/catalog.js";
import type { AuctionSearchResult } from "../src/api/auction-contracts.js";
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
      lib: { entry: "test/auction-search-worker.ts", formats: ["es"] },
      rollupOptions: { external: ["cloudflare:workers"] },
    },
  });
  const out = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!("output" in out)) throw new Error("bundle");
  const chunk = out.output.find((row) => row.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("chunk");
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: chunk.code,
      compatibilityDate: "2026-08-11",
      durableObjects: { AUCTIONS: { className: "TestSearch", useSQLite: true } },
    }),
  );
}, 30_000);
afterAll(async () => mf?.dispose());
async function call(path: string, input: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`https://test.invalid/${path}`, {
    method: "POST",
    body: JSON.stringify({ now, ...input }),
  });
  const data = (await r.json()) as {
    result: AuctionSearchResult;
    usage: Record<string, AuctionSqlUsage>;
    error?: string;
  };
  return { status: r.status, ...data };
}
function observation(index: number, current = 1000) {
  const o = auctionSnapshot();
  o.auctionId = `a${String(index).padStart(6, "0")}`;
  o.sourceUrl = `https://auctions.yahoo.co.jp/jp/auction/${o.auctionId}`;
  o.stamp.observedAt = new Date(now).toISOString();
  for (const fact of Object.values(o.live)) if (fact) fact.observedAt = o.stamp.observedAt;
  o.live.sourceState = { value: "open", observedAt: o.stamp.observedAt };
  o.live.scheduledEndAt = {
    value: new Date(now + 86_400_000).toISOString(),
    observedAt: o.stamp.observedAt,
  };
  o.live.currentPrice!.value = { amountYen: current, tax: "inclusive" };
  o.item = {
    ...o.item,
    title: "ＤＥＮＯＮ 真空管アンプ PMA-1700NE",
    rawManufacturer: "DENON",
    rawModel: "PMA-1700NE",
    saleSubject: "main_unit",
    saleUnit: "single",
  };
  return o;
}
it("combines same-offer filters, separates buy-now prices and orders unknown tax last", async () => {
  const a = observation(1, 1),
    b = observation(2, 2000),
    c = observation(3, 50);
  a.live.buyNowPrice!.value = { amountYen: 9900, tax: "inclusive" };
  b.live.buyNowPrice!.value = { amountYen: 100, tax: "inclusive" };
  c.live.currentPrice!.value.tax = "unknown";
  c.live.buyNowPrice!.value = null;
  await call("prices", { op: "apply", observations: [a, b, c] });
  expect(
    (await call("prices", { op: "search", query: "sort=current_asc" })).result.items.map(
      (row) => row.auctionId,
    ),
  ).toEqual([a.auctionId, b.auctionId, c.auctionId]);
  expect(
    (await call("prices", { op: "search", query: "sort=buy_asc" })).result.items.map(
      (row) => row.auctionId,
    ),
  ).toEqual([b.auctionId, a.auctionId, c.auctionId]);
  expect((await call("prices", { op: "search", query: "max=10&buyMax=100" })).result.items).toEqual(
    [],
  );
  expect(
    (await call("prices", { op: "search", query: "max=100" })).result.items.map(
      (row) => row.auctionId,
    ),
  ).toEqual([a.auctionId]);
  expect(
    (await call("prices", { op: "search", query: "buy=none" })).result.items.map(
      (row) => row.auctionId,
    ),
  ).toEqual([c.auctionId]);
  expect((await call("prices", { op: "search", query: "q=真空管" })).result.items).toHaveLength(3);
  expect(
    (await call("prices", { op: "search", query: "q=ｄｅｎｏｎ&model=ＰＭＡ−１７００" })).result
      .items,
  ).toHaveLength(3);
  expect((await call("prices", { op: "search", query: "q=A8" })).status).toBe(400);
  const short = observation(4);
  short.item.rawModel = "A-8";
  await call("prices", { op: "apply", observations: [short] });
  expect(
    (await call("prices", { op: "search", query: "model=A8" })).result.items.map(
      (row) => row.auctionId,
    ),
  ).toEqual([short.auctionId]);
});
it("uses expiring condition-bound keysets, one lookahead and bounded SQL over 2,000 rows", async () => {
  const rows = Array.from({ length: 2000 }, (_, i) => observation(i, 1000));
  for (const r of rows.slice(-2)) r.live.currentPrice!.value.tax = "unknown";
  await call("page", { op: "apply", observations: rows });
  const first = await call("page", { op: "search", query: "sort=current_asc&limit=25" });
  expect(first.result.items).toHaveLength(25);
  expect(first.result.hasMore).toBe(true);
  expect("total" in first.result).toBe(false);
  const next = await call("page", {
    op: "search",
    query: `sort=current_asc&limit=25&cursor=${first.result.nextCursor}`,
  });
  expect(next.result.items[0].auctionId).toBe(rows[25].auctionId);
  expect(
    (
      await call("page", {
        op: "search",
        query: `sort=buy_asc&limit=25&cursor=${first.result.nextCursor}`,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("page", {
        op: "search",
        now: now + 15 * 60_000,
        query: `sort=current_asc&limit=25&cursor=${first.result.nextCursor}`,
      })
    ).error,
  ).toBe("expired_auction_cursor");
  let worstReads = 0;
  for (const cached of [false, true]) {
    if (cached) await call("page", { op: "cache" });
    for (const query of [
      "q=DENON",
      "q=DENON+PMA1700NE+真空管+アンプ",
      "model=PMA",
      "state=all",
      "sort=current_desc",
      "sort=buy_asc",
      "sort=buy_desc",
      "sort=ending",
      "sort=newest",
      "q=DENON&max=1000&unit=single&sort=current_asc",
      "q=DENON&unit=pair",
      "manufacturer=denon&category=AMP&catalog=12&sort=current_desc",
    ]) {
      const measured = await call("page", { op: "search", query });
      const reads = Object.values(measured.usage).reduce((n, value) => n + value.rowsRead, 0);
      worstReads = Math.max(worstReads, reads);
      expect(reads).toBeLessThanOrEqual(15_000);
      expect(Object.values(measured.usage).reduce((n, value) => n + value.rowsWritten, 0)).toBe(0);
    }
  }
  await recordCostSample(
    "auction-search-filtered",
    "local-workerd",
    { rowsRead: worstReads, rowsWritten: 0, sqlStatements: 2 },
    ["test/auction-search.test.ts", "test/auction-search-worker.ts"],
    [
      "Worst of 24 query/cache combinations over 2,000 retained listings and distinct candidate cache keys: four FTS terms, indexed model prefix, both price orders, state, filters with no matches, catalog/manufacturer/category join. Admission reserves this bound separately.",
    ],
  );
  const metrics = {
    rowsRead: Object.values(first.usage).reduce((n, s) => n + s.rowsRead, 0),
    rowsWritten: Object.values(first.usage).reduce((n, s) => n + s.rowsWritten, 0),
    sqlStatements: Object.values(first.usage).reduce((n, s) => n + s.statements, 0),
  };
  expect(metrics.rowsRead).toBeLessThanOrEqual(6100);
  expect(metrics.rowsWritten).toBe(0);
  await recordCostSample(
    "auction-search-page",
    "local-workerd",
    metrics,
    ["test/auction-search.test.ts", "test/auction-search-worker.ts"],
    [
      "Real SQLite DO sorted page with 2,000 listings, unknown tax, stable ID ties and one lookahead. No COUNT, D1 or seller requests; invocation admission is measured separately.",
    ],
  );
});
it("expires end/freshness and catalog links using the read clock without a new observation", async () => {
  const item = observation(10);
  item.item.title = "DENON PMA-1700NE";
  item.item.rawModel = null;
  item.live.scheduledEndAt!.value = new Date(now + 1000).toISOString();
  await call("clock", { op: "apply", observations: [item] });
  const entry = {
    input: auctionCatalogInput(item.item),
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
  await call("clock", { op: "match", entries: [entry] });
  // Simulate a schema-2 row written before public search: identity is current but model_key is empty.
  await call("legacy-model", { op: "apply", observations: [item] });
  await call("legacy-model", { op: "match", entries: [entry] });
  await call("legacy-model", { op: "legacy-model" });
  expect(
    (await call("legacy-model", { op: "search", query: "model=PMA" })).result.items,
  ).toHaveLength(0);
  await call("legacy-model", { op: "match", entries: [entry], now: now + AUCTION_CATALOG_TTL });
  expect(
    (
      await call("legacy-model", {
        op: "search",
        query: "state=all&model=PMA",
        now: now + AUCTION_CATALOG_TTL,
      })
    ).result.items,
  ).toHaveLength(1);
  const unchanged = await call("legacy-model", {
    op: "match",
    entries: [entry],
    now: now + AUCTION_CATALOG_TTL + 1,
  });
  expect(Object.values(unchanged.usage).reduce((sum, use) => sum + use.rowsWritten, 0)).toBe(0);
  expect((await call("clock", { op: "search", query: "model=PMA" })).result.items).toHaveLength(1);
  expect(
    (await call("clock", { op: "search", query: "catalog=900001" })).result.items,
  ).toHaveLength(1);
  expect((await call("clock", { op: "search", now: now + 1001 })).result.items).toHaveLength(0);
  expect(
    (await call("clock", { op: "search", now: now + 1001, query: "state=pending" })).result.items[0]
      .displayState,
  ).toBe("end_check_pending");
  expect(
    (
      await call("clock", {
        op: "search",
        now: now + AUCTION_CATALOG_TTL,
        query: "state=all&catalog=900001",
      })
    ).result.items,
  ).toHaveLength(0);
  const expired = await call("clock", {
    op: "search",
    now: now + 3 * 60 * 60_000,
    query: "state=stale",
  });
  expect(expired.result.items[0].catalogProductId).toBeNull();
  expect(expired.result.items[0].freshness).toBe("stale");
});
it("keeps null-price tails and stable IDs in both price cursor directions", async () => {
  const rows = [
    observation(101, 200),
    observation(102, 100),
    observation(103, 200),
    observation(104, 500),
    observation(105, 20),
  ];
  rows[3].live.currentPrice!.value.tax = "unknown";
  rows[4].live.currentPrice!.value.tax = "exclusive";
  await call("null-tail", { op: "apply", observations: rows });
  for (const sort of ["current_asc", "current_desc"]) {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const response = await call("null-tail", {
        op: "search",
        query: `sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      });
      ids.push(...response.result.items.map((item) => item.auctionId));
      cursor = response.result.nextCursor;
    }
    expect(ids).toEqual(
      (sort === "current_asc" ? [102, 101, 103, 104, 105] : [101, 103, 102, 104, 105]).map(
        (n) => `a${String(n).padStart(6, "0")}`,
      ),
    );
    expect(cursor).toBeNull();
  }
});
