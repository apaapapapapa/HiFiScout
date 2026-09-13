import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import { checkPublicApiRateLimit } from "../src/api-guard.js";
import worker from "../src/index.js";
import { handleHttp } from "../src/http/router.js";

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

/** A D1 binding that fails the test if a refused request reaches it. */
function forbiddenDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("a refused request must not read or write D1");
    },
    batch() {
      throw new Error("a refused request must not read or write D1");
    },
    exec() {
      throw new Error("a refused request must not read or write D1");
    },
  } as unknown as D1Database;
}

function limiter(behaviour: () => Promise<{ success: boolean }>): RateLimit {
  return { limit: behaviour } as unknown as RateLimit;
}

const ALLOWING = limiter(async () => ({ success: true }));
const REFUSING = limiter(async () => ({ success: false }));
const BROKEN = limiter(async () => {
  throw new Error("rate limiter unavailable");
});

const SEARCH_URL = "https://example.test/api/product-search?q=TAD";
const headers = { "cf-connecting-ip": "203.0.113.42" };

/** Replaces the global edge cache for one call and restores whatever was there. */
async function withCache<T>(
  entries: Map<string, Response>,
  run: () => Promise<T>,
): Promise<{ result: T; puts: string[] }> {
  const puts: string[] = [];
  const original = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = {
    default: {
      async match(request: Request) {
        return entries.get(new Request(request).url)?.clone();
      },
      async put(request: Request, response: Response) {
        puts.push(new Request(request).url);
        entries.set(new Request(request).url, response);
      },
    },
  };
  try {
    return { result: await run(), puts };
  } finally {
    if (original === undefined) delete (globalThis as { caches?: unknown }).caches;
    else (globalThis as { caches?: unknown }).caches = original;
  }
}

test("a missing binding refuses the routes it protects instead of passing them", async () => {
  const result = await checkPublicApiRateLimit(
    { method: "GET", url: SEARCH_URL, headers: new Headers(headers) },
    {},
  );
  assert.equal(result.decision, "unavailable");
  assert.equal(result.allowed, false);
  assert.equal(result.bucket, "product-search");
});

test("a working limiter still allows and still refuses on its own terms", async () => {
  const allowed = await checkPublicApiRateLimit(
    { method: "GET", url: SEARCH_URL, headers: new Headers(headers) },
    { API_RATE_LIMITER: ALLOWING },
  );
  assert.deepEqual(
    { decision: allowed.decision, allowed: allowed.allowed },
    { decision: "allowed", allowed: true },
  );

  const over = await checkPublicApiRateLimit(
    { method: "GET", url: SEARCH_URL, headers: new Headers(headers) },
    { API_RATE_LIMITER: REFUSING },
  );
  assert.deepEqual(
    { decision: over.decision, allowed: over.allowed },
    { decision: "limited", allowed: false },
  );
});

test("a limiter that throws is unavailable, not an allow and not a limit", async () => {
  const result = await checkPublicApiRateLimit(
    { method: "GET", url: SEARCH_URL, headers: new Headers(headers) },
    { API_RATE_LIMITER: BROKEN },
  );
  assert.equal(result.decision, "unavailable");
  assert.equal(result.allowed, false);
});

test("routes the limiter does not cover are unaffected by its state", async () => {
  // Retired admin paths carry no bucket, so a limiter outage never turns into a 503 for them.
  const admin = await checkPublicApiRateLimit(
    { method: "POST", url: "https://example.test/api/admin/crawl", headers: new Headers(headers) },
    {},
  );
  assert.deepEqual(
    { decision: admin.decision, bucket: admin.bucket },
    { decision: "allowed", bucket: undefined },
  );

  const asset = await checkPublicApiRateLimit(
    { method: "GET", url: "https://example.test/styles.css", headers: new Headers(headers) },
    {},
  );
  assert.equal(asset.decision, "allowed");
});

test("an unknown public API path is bucketed, and refused while the limiter is down", async () => {
  const bucketed = await checkPublicApiRateLimit(
    { method: "POST", url: "https://example.test/api/future-write", headers: new Headers(headers) },
    {},
  );
  assert.equal(bucketed.bucket, "unknown-api");
  assert.equal(bucketed.decision, "unavailable");

  const response = await handleHttp(
    new Request("https://example.test/api/future-write", { method: "POST", headers }),
    { DB: forbiddenDatabase() } as unknown as Env,
    executionContext(),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "rate_limiter_unavailable" });
  assert.equal(response.headers.get("retry-after"), "30");
});

test("static asset delivery is not stopped by a limiter outage", async () => {
  let served = 0;
  const env = {
    DB: forbiddenDatabase(),
    ASSETS: {
      async fetch() {
        served += 1;
        return new Response("body{}", { headers: { "content-type": "text/css" } });
      },
    },
  } as unknown as Env;

  const response = await handleHttp(
    new Request("https://example.test/styles.css", { headers }),
    env,
    executionContext(),
  );

  assert.equal(response.status, 200);
  assert.equal(served, 1);
});

test("a cached read is still served while the limiter is down; a miss is refused", async () => {
  const env = { DB: forbiddenDatabase() } as unknown as Env;
  const request = new Request("https://example.test/api/meta", { headers });
  const cached = new Response(JSON.stringify({ shops: [] }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });

  const hit = await withCache(new Map([[request.url, cached]]), () =>
    handleHttp(request, env, executionContext()),
  );
  assert.equal(hit.result.status, 200);
  assert.deepEqual(await hit.result.json(), { shops: [] });
  assert.deepEqual(hit.puts, [], "a cache hit writes nothing back");

  const miss = await withCache(new Map(), () => handleHttp(request, env, executionContext()));
  assert.equal(miss.result.status, 503);
  assert.deepEqual(await miss.result.json(), { error: "rate_limiter_unavailable" });
});

test("search refuses while the limiter is down rather than reaching D1", async () => {
  // The search entrypoint owns its own cache and cannot be asked for a hit without also being
  // allowed to produce a miss, so it has no cache-only mode.
  const response = await handleHttp(
    new Request(SEARCH_URL, { headers }),
    { DB: forbiddenDatabase() } as unknown as Env,
    executionContext(),
  );
  assert.equal(response.status, 503);
});

test("an over-limit caller still gets 429, not 503", async () => {
  const response = await handleHttp(
    new Request(SEARCH_URL, { headers }),
    { DB: forbiddenDatabase(), API_RATE_LIMITER: REFUSING } as unknown as Env,
    executionContext(),
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "rate_limited" });
});

test("an unauthenticated write is refused outright while the limiter is down", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/product-correction-reports", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ productKey: "c-1", reason: "wrong_model" }),
    }),
    { DB: forbiddenDatabase() } as unknown as Env,
    executionContext(),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "rate_limiter_unavailable" });
});

test("a permalink is served from cache while the limiter is down, and refused on a miss", async () => {
  const env = { DB: forbiddenDatabase() } as unknown as Env;
  const request = new Request("https://example.test/p/c-42", { headers });
  const cacheKey = "https://example.test/p/c-42";
  const cached = new Response("<html>cached</html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  const hit = await withCache(new Map([[cacheKey, cached]]), () =>
    worker.fetch(request, env, executionContext()),
  );
  assert.equal(hit.result.status, 200);
  assert.match(await hit.result.text(), /cached/u);

  const miss = await withCache(new Map(), () => worker.fetch(request, env, executionContext()));
  assert.equal(miss.result.status, 503);
  assert.equal(miss.result.headers.get("content-type"), "text/plain; charset=utf-8");
});

test("the public Worker configuration declares the rate limiter every environment needs", () => {
  interface WranglerConfig {
    ratelimits?: {
      name?: string;
      namespace_id?: string;
      simple?: { limit?: number; period?: number };
    }[];
    env?: Record<string, WranglerConfig>;
  }
  const config = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as WranglerConfig;

  const declares = (candidate: WranglerConfig): boolean =>
    (candidate.ratelimits ?? []).some(
      (entry) =>
        entry.name === "API_RATE_LIMITER" &&
        Boolean(entry.namespace_id) &&
        typeof entry.simple?.limit === "number" &&
        typeof entry.simple?.period === "number",
    );

  assert.ok(declares(config), "the public Worker must bind API_RATE_LIMITER");
  // A named environment inherits nothing it re-declares, so each one is checked on its own terms.
  for (const [name, environment] of Object.entries(config.env ?? {})) {
    assert.ok(
      declares({ ...config, ...environment }),
      `wrangler environment "${name}" must also bind API_RATE_LIMITER`,
    );
  }
});

test("the Access-protected admin Worker deliberately does not bind the public limiter", () => {
  const source = readFileSync(new URL("../wrangler.admin.jsonc", import.meta.url), "utf8");
  // The admin Worker is gated by Cloudflare Access, not by the anonymous public abuse brake.
  // Asserting its absence keeps anyone from assuming the public guard protects those routes.
  assert.equal(source.includes("API_RATE_LIMITER"), false);
});
