import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { handlePublicContractRoute } from "../src/http/public-routes.js";
import { handleHttp } from "../src/http/router.js";
import { PublicSearchCache } from "../src/http/public-search-cache.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { recordingDatabase } from "./helpers/query-plan.js";

test("the uncached gateway rate-limits every request before forwarding clean canonical search URLs", async () => {
  const forwarded: Request[] = [];
  const actors: string[] = [];
  let allowed = true;
  const env = {
    DB: {
      prepare() {
        throw new Error("gateway must not query D1");
      },
    },
    API_RATE_LIMITER: {
      async limit({ key }: { key: string }) {
        actors.push(key);
        return { success: allowed };
      },
    },
  } as unknown as Env;
  const ctx = {
    exports: {
      PublicSearchCache: {
        async fetch(request: Request) {
          forwarded.push(request);
          return new Response('{"items":[]}', {
            headers: { "cache-control": "public, max-age=30" },
          });
        },
      },
    },
  } as unknown as ExecutionContext;
  const headers = {
    "cf-connecting-ip": "203.0.113.10",
    authorization: "Bearer test",
    cookie: "session=test",
    "cache-control": "no-cache",
  };
  const request = (query: string) =>
    handleHttp(
      new Request(`https://example.test/api/product-search?${query}`, { headers }),
      env,
      ctx,
    );
  assert.equal((await request("shop=hifido&limit=50")).status, 200);
  assert.equal((await request("limit=050&shop=hifido")).status, 200);
  assert.equal(forwarded[0]?.url, forwarded[1]?.url);
  assert.deepEqual(
    [...forwarded[0]!.headers],
    [],
    "no private or bypass headers enter the public cache",
  );
  assert.equal((await request("limit=garbage")).status, 400);
  assert.equal(forwarded.length, 2, "validation runs before the cache");
  allowed = false;
  const denied = await request("shop=hifido&limit=50");
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("cache-control"), "no-store");
  assert.equal(forwarded.length, 2, "even a known cached URL cannot bypass a denied actor");
  assert.deepEqual(actors, Array(4).fill("203.0.113.10:product-search"));
});

test("the cached entrypoint serves only validated public search and suggestions for 30 seconds", async () => {
  const { db } = migratedSqlite();
  const recording = recordingDatabase(db);
  const env = { DB: recording.db } as unknown as Env;
  const service = new PublicSearchCache({} as ExecutionContext, env);
  for (const path of ["/api/product-search?limit=50", "/api/suggest?q=LUXMAN"]) {
    const response = await service.fetch(new Request(`https://example.test${path}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=30");
    await response.json();
  }
  const queries = recording.executed.length;
  for (const [path, method, status] of [
    ["/api/admin/crawl", "GET", 404],
    ["/api/meta", "GET", 404],
    ["/api/product-search", "POST", 404],
    ["/api/product-search?limit=garbage", "GET", 400],
  ] as const) {
    const response = await service.fetch(new Request(`https://example.test${path}`, { method }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(recording.executed.length, queries);
});

test("search routes share canonical cache entries and keep distinct queries apart", async () => {
  const { db } = migratedSqlite();
  const recording = recordingDatabase(db);
  const stored = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        async match(request: Request) {
          return stored.get(request.url)?.clone();
        },
        async put(request: Request, response: Response) {
          stored.set(request.url, response);
        },
      },
    },
  });
  const ctx = {
    waitUntil(work: Promise<unknown>) {
      pending.push(work);
    },
  } as ExecutionContext;
  const request = async (query: string) => {
    const response = await handlePublicContractRoute(
      new Request(`https://example.test/api/product-search?${query}`),
      { DB: recording.db } as unknown as Env,
      ctx,
    );
    await Promise.all(pending);
    assert.ok(response);
    return response;
  };
  try {
    const first = await request("shop=audioshop&limit=50");
    assert.equal(first.status, 200);
    const calls = recording.executed.length;
    assert.ok(calls > 0);
    const equivalent = await request("limit=050&shop=audioshop");
    assert.deepEqual(await equivalent.json(), await first.json());
    assert.equal(recording.executed.length, calls, "equivalent URLs must not query D1 twice");
    await request("limit=50&shop=hifido");
    assert.ok(recording.executed.length > calls, "different filters need different entries");
    const entries = stored.size;
    assert.equal((await request("limit=garbage")).status, 400);
    assert.equal(stored.size, entries, "invalid requests are never cached");
  } finally {
    if (original) Object.defineProperty(globalThis, "caches", original);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});
