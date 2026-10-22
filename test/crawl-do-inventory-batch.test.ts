import assert from "node:assert/strict";
import { afterEach, test, vi } from "vite-plus/test";
import { CrawlScheduler } from "../src/crawler/crawl-scheduler-do.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { ensureCrawlFetchSession } from "../src/db/crawl-fetch-session-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const STORAGE_KEY = "phase2_crawl_execution"; // Public DO record name, not a credential. gitleaks:allow
const SHOP = "fujiya-avic";
const RUN = "crawl:fujiya-avic:inventory-batch";
// 12:00 JST, inside the crawl window.
const NOON = Date.parse("2026-09-05T03:00:00.000Z");
const plugin = getShopPlugin(SHOP)!;
const detailUrl = (id: number) => `https://www.fujiya-avic.co.jp/shop/g/g24000000000${id}/`;

afterEach(() => {
  vi.restoreAllMocks();
});

async function harness({ batchSize, listings }: { batchSize: string; listings: number }) {
  const { db, sqlite } = migratedSqlite();
  sqlite.exec("DELETE FROM products;");
  await ensureCrawlFetchSession(db, {
    runId: RUN,
    shopKey: SHOP,
    requestedAt: "2026-09-05T02:00:00.000Z",
    createdAt: "2026-09-05T02:00:00.000Z",
    progressStorage: "durable_object",
    maxPages: 1,
    pageLimit: 1,
    pages: [{ key: "https://www.fujiya-avic.co.jp/shop/c/c/", page: "x", ordinal: 0 }],
  });
  sqlite.prepare("UPDATE crawl_fetch_sessions SET status = 'completed' WHERE run_id = ?").run(RUN);
  for (let id = 1; id <= listings; id += 1)
    sqlite
      .prepare(`INSERT INTO products(shop_key,source_id,manufacturer,model,title,source_url,
          first_seen_at,last_seen_at,last_changed_at,last_activity_at,stock_status,is_active)
        VALUES (?,?,?,?,?,?,?,?,?,?,'in_stock',1)`)
      .run(
        SHOP,
        `g${id}`,
        "Shure",
        `SE-${id}00`,
        `Shure SE-${id}00`,
        detailUrl(id),
        // Older listings first, so the selection order is the id order.
        `2026-08-0${id}T00:00:00.000Z`,
        `2026-08-0${id}T00:00:00.000Z`,
        `2026-08-0${id}T00:00:00.000Z`,
        `2026-08-0${id}T00:00:00.000Z`,
      );
  const stored = new Map<string, unknown>([
    [
      STORAGE_KEY,
      {
        message: {
          shopKey: SHOP,
          requestedAt: "2026-09-05T02:00:00.000Z",
          force: true,
          jobId: RUN,
          collectionRunId: RUN,
          continuation: { phase: "finalize", sequence: 3 },
        },
        acceptedAt: "2026-09-05T02:00:00.000Z",
        nextOriginNotBeforeMs: 0,
        inventoryRecheckPending: true,
      },
    ],
  ]);
  const alarms: number[] = [];
  let now = NOON;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const ctx = {
    storage: {
      get: async (key: string) => structuredClone(stored.get(key)),
      put: async (key: string, value: unknown) => {
        stored.set(key, structuredClone(value));
      },
      delete: async (key: string) => stored.delete(key),
      setAlarm: async (at: number) => {
        alarms.push(at);
      },
      deleteAlarm: async () => {},
    },
  } as unknown as DurableObjectState;
  const env = {
    DB: db,
    FUJIYA_AVIC_ENABLED: "true",
    FUJIYA_AVIC_REQUEST_DELAY_MS: "1000",
    FUJIYA_AVIC_INVENTORY_RECHECK_ENABLED: "true",
    FUJIYA_AVIC_INVENTORY_RECHECK_BATCH_SIZE: batchSize,
    CRAWLER_USER_AGENT: "HiFiScoutBot/0.1",
  } as unknown as Env;
  const alarm = () => new CrawlScheduler(ctx, env).alarm();
  const advance = (ms: number) => {
    now += ms;
  };
  const row = (id: number) => ({
    ...(sqlite
      .prepare(
        "SELECT is_active, stock_status, inventory_check_failures FROM products WHERE source_id = ?",
      )
      .get(`g${id}`) as Record<string, unknown>),
  });
  return { stored, alarms, alarm, advance, row, sqlite };
}

test("a direct shop rechecks its batch through one paced permit per listing", async () => {
  assert.ok(plugin.capabilities.inventoryRecheck);
  assert.equal(plugin.capabilities.transport?.kind, undefined, "Fujiya-Avic is fetched directly");
  const h = await harness({ batchSize: "2", listings: 3 });
  const sellerRequests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/robots.txt")) return new Response("nf", { status: 404 });
    sellerRequests.push(url);
    // The permit is consumed before the seller is asked.
    const execution = h.stored.get(STORAGE_KEY) as { permit?: unknown };
    assert.equal(execution.permit, undefined, "consume before issuing seller HTTP");
    const id = Number(url.match(/g24000000000(\d)/)?.[1]);
    return new Response(
      `<html><body><main><h1>Shure SE-${id}00</h1><p>在庫がありません</p></main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  });

  // PREPARE never contacts the seller page and arms the paced Alarm.
  await h.alarm();
  const prepared = h.stored.get(STORAGE_KEY) as {
    permit: { notBeforeMs: number; targetUrl: string };
  };
  assert.equal(prepared.permit.targetUrl, detailUrl(1));
  assert.equal(prepared.permit.notBeforeMs, NOON + 1000);
  assert.equal(sellerRequests.length, 0);

  // An early Alarm only re-arms.
  await h.alarm();
  assert.equal(sellerRequests.length, 0);

  h.advance(1000);
  await h.alarm();
  assert.deepEqual(sellerRequests, [detailUrl(1)]);
  assert.deepEqual(h.row(1), {
    is_active: 1,
    stock_status: "sold_out",
    inventory_check_failures: 1,
  });
  const continuing = h.stored.get(STORAGE_KEY) as { inventoryRechecksCompleted: number };
  assert.equal(continuing.inventoryRechecksCompleted, 1);

  // The next listing gets its own PREPARE and its own delay after the previous request.
  await h.alarm();
  const second = h.stored.get(STORAGE_KEY) as {
    permit: { notBeforeMs: number; targetUrl: string };
  };
  assert.equal(second.permit.targetUrl, detailUrl(2));
  assert.equal(second.permit.notBeforeMs, NOON + 2000);
  h.advance(1000);
  await h.alarm();
  assert.deepEqual(sellerRequests, [detailUrl(1), detailUrl(2)]);

  // The batch is spent: the execution ends and the third listing waits for the next crawl.
  assert.equal(h.stored.has(STORAGE_KEY), false);
  assert.deepEqual(h.row(3), {
    is_active: 1,
    stock_status: "in_stock",
    inventory_check_failures: 0,
  });
});

test("a batch stops at the first recheck the seller did not answer", async () => {
  const h = await harness({ batchSize: "5", listings: 3 });
  let sellerRequests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/robots.txt")) return new Response("nf", { status: 404 });
    sellerRequests += 1;
    return new Response("", { status: 202, headers: { "content-type": "text/html" } });
  });
  await h.alarm();
  h.advance(1000);
  await h.alarm();
  assert.equal(sellerRequests, 1);
  assert.equal(h.stored.has(STORAGE_KEY), false, "a challenge page is not asked again this run");
  assert.deepEqual(h.row(1), {
    is_active: 1,
    stock_status: "in_stock",
    inventory_check_failures: 0,
  });
});

for (const phase of ["before_fetch", "during_fetch"] as const) {
  test(`PREPARE snapshot rejects a concurrent rediscovery ${phase}`, async () => {
    const h = await harness({ batchSize: "2", listings: 2 });
    let requests = 0;
    const rediscover = () =>
      h.sqlite
        .prepare(
          "UPDATE products SET last_seen_at=?,inventory_check_failures=0 WHERE source_id='g1'",
        )
        .run(new Date(NOON + 1000).toISOString());
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
      requests += 1;
      if (phase === "during_fetch") rediscover();
      return new Response("<h1>Shure SE-100</h1><p>在庫がありません</p>", {
        headers: { "content-type": "text/html" },
      });
    });
    await h.alarm();
    if (phase === "before_fetch") rediscover();
    h.advance(1000);
    await h.alarm();
    assert.equal(requests, phase === "before_fetch" ? 0 : 1);
    assert.deepEqual(h.row(1), {
      is_active: 1,
      stock_status: "in_stock",
      inventory_check_failures: 0,
    });
    assert.deepEqual(h.row(2), {
      is_active: 1,
      stock_status: "in_stock",
      inventory_check_failures: 0,
    });
    assert.equal(h.stored.has(STORAGE_KEY), false);
  });
}

test("expired permits and pre-upgrade unbound permits are replaced before seller access", async () => {
  const h = await harness({ batchSize: "1", listings: 1 });
  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
    requests++;
    return new Response("", { status: 202 });
  });
  await h.alarm();
  h.advance(16 * 60_000);
  await h.alarm();
  assert.equal(requests, 0);
  await h.alarm(); // new permit and snapshot
  const old = h.stored.get(STORAGE_KEY) as Record<string, unknown>;
  delete old.inventoryCandidate;
  h.stored.set(STORAGE_KEY, old);
  h.advance(1000);
  await h.alarm(); // new worker must not use this unbound capability
  assert.equal(requests, 0);
  h.advance(1000);
  await h.alarm();
  assert.equal(requests, 1);
  assert.equal(h.row(1).is_active, 1);
});

for (const status of [202, 403, 429, 500, 503]) {
  test(`repeated HTTP ${status} never counts as missing stock`, async () => {
    const h = await harness({ batchSize: "5", listings: 2 });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) =>
        new Response("", { status: String(input).endsWith("/robots.txt") ? 404 : status }),
    );
    const execution = structuredClone(h.stored.get(STORAGE_KEY));
    for (let attempt = 0; attempt < 3; attempt++) {
      h.stored.set(STORAGE_KEY, structuredClone(execution));
      await h.alarm();
      h.advance(1000);
      await h.alarm();
      h.advance(48 * 60 * 60_000);
    }
    assert.deepEqual(h.row(1), {
      is_active: 1,
      stock_status: "in_stock",
      inventory_check_failures: 0,
    });
    assert.equal(h.stored.has(STORAGE_KEY), false);
  });
}

test("two separately paced sold observations end a listing and remove its search offer", async () => {
  const h = await harness({ batchSize: "1", listings: 1 });
  const execution = structuredClone(h.stored.get(STORAGE_KEY));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input).endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : new Response("<h1>Shure SE-100</h1><p>在庫がありません</p>", {
          headers: { "content-type": "text/html" },
        }),
  );
  await h.alarm();
  h.advance(1000);
  await h.alarm();
  assert.equal(h.row(1).is_active, 1);
  h.advance(48 * 60 * 60_000);
  h.stored.set(STORAGE_KEY, execution);
  await h.alarm();
  h.advance(1000);
  await h.alarm();
  assert.deepEqual(h.row(1), {
    is_active: 0,
    stock_status: "sold_out",
    inventory_check_failures: 2,
  });
  assert.equal(
    h.sqlite
      .prepare(
        "SELECT count(*) AS n FROM product_search_entity_offers WHERE listing_product_id IN (SELECT id FROM products WHERE source_id='g1')",
      )
      .get()!.n,
    0,
  );
});

test("HTTP 200 WAF challenge defers without clearing earlier sold confirmation", async () => {
  const h = await harness({ batchSize: "5", listings: 1 });
  h.sqlite.exec(
    "UPDATE products SET stock_status='sold_out',inventory_check_failures=1,last_inventory_check_attempt_at='2026-08-20T00:00:00Z',last_inventory_checked_at='2026-08-20T00:00:00Z'",
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input).endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : new Response(
          '<script src="https://challenge.aws/challenge.js"></script><h1>Shure SE-100</h1><p>在庫がありません</p>',
          { headers: { "content-type": "text/html" } },
        ),
  );
  await h.alarm();
  h.advance(1000);
  await h.alarm();
  assert.deepEqual(h.row(1), {
    is_active: 1,
    stock_status: "sold_out",
    inventory_check_failures: 1,
  });
  assert.equal(h.stored.has(STORAGE_KEY), false);
});
