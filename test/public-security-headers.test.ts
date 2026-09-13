import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import worker from "../src/index.js";
import { renderProductPermalinkHtml } from "../src/http/product-permalink.js";
import {
  PUBLIC_CONTENT_SECURITY_POLICY,
  PUBLIC_SECURITY_HEADERS,
} from "../src/http/security-headers.js";

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

function forbiddenDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("this test must not reach D1");
    },
  } as unknown as D1Database;
}

function limiter(success: boolean): RateLimit {
  return {
    async limit() {
      return { success };
    },
  } as unknown as RateLimit;
}

const HEADERS = { "cf-connecting-ip": "203.0.113.55" };

function assertHardened(response: Response, label: string): void {
  for (const [name, value] of PUBLIC_SECURITY_HEADERS) {
    assert.equal(response.headers.get(name), value, `${label} is missing ${name}`);
  }
}

async function withCache<T>(entries: Map<string, Response>, run: () => Promise<T>): Promise<T> {
  const original = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = {
    default: {
      async match(request: Request) {
        return entries.get(new Request(request).url)?.clone();
      },
      async put() {},
    },
  };
  try {
    return await run();
  } finally {
    if (original === undefined) delete (globalThis as { caches?: unknown }).caches;
    else (globalThis as { caches?: unknown }).caches = original;
  }
}

test("the catalog top page carries the public header set", async () => {
  const env = {
    DB: forbiddenDatabase(),
    API_RATE_LIMITER: limiter(true),
    ASSETS: {
      async fetch() {
        return new Response("<html><head></head><body></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  } as unknown as Env;

  const response = await worker.fetch(
    new Request("https://example.test/", { headers: HEADERS }),
    env,
    executionContext(),
  );

  assert.equal(response.status, 200);
  assertHardened(response, "the top page");
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
});

test("a public API response carries the header set and keeps its own content-type and caching", async () => {
  const env = {
    DB: forbiddenDatabase(),
    API_RATE_LIMITER: limiter(true),
  } as unknown as Env;
  const request = new Request("https://example.test/api/meta", { headers: HEADERS });
  const cached = new Response(JSON.stringify({ shops: [] }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30",
    },
  });

  const response = await withCache(new Map([[request.url, cached]]), () =>
    worker.fetch(request, env, executionContext()),
  );

  assert.equal(response.status, 200);
  assertHardened(response, "a cached API read");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "public, max-age=30");
  assert.deepEqual(await response.json(), { shops: [] });
});

test("a cache hit is hardened too, so entries stored before this shipped need no purge", async () => {
  const env = { DB: forbiddenDatabase(), API_RATE_LIMITER: limiter(true) } as unknown as Env;
  const request = new Request("https://example.test/p/c-42", { headers: HEADERS });
  // Stored without any security header, exactly as an older deployment would have written it.
  const stale = new Response("<html>cached</html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  const response = await withCache(new Map([["https://example.test/p/c-42", stale]]), () =>
    worker.fetch(request, env, executionContext()),
  );

  assert.equal(response.status, 200);
  assertHardened(response, "an edge-cache hit");
  assert.match(await response.text(), /cached/u);
});

test("application error responses are hardened as well", async () => {
  const env = { DB: forbiddenDatabase(), API_RATE_LIMITER: limiter(true) } as unknown as Env;

  const badRequest = await worker.fetch(
    new Request("https://example.test/api/product-correction-reports", {
      method: "POST",
      headers: {
        ...HEADERS,
        "content-type": "application/json",
        origin: "https://example.test",
      },
      body: "{not json",
    }),
    env,
    executionContext(),
  );
  assert.equal(badRequest.status, 400);
  assertHardened(badRequest, "a 400");

  const crossOrigin = await worker.fetch(
    new Request("https://example.test/api/product-correction-reports", {
      method: "POST",
      headers: { ...HEADERS, "content-type": "application/json", origin: "https://attacker.test" },
      body: "{}",
    }),
    env,
    executionContext(),
  );
  assert.equal(crossOrigin.status, 403);
  assertHardened(crossOrigin, "a 403");

  const notFound = await worker.fetch(
    new Request("https://example.test/api/admin/crawl", { method: "POST", headers: HEADERS }),
    env,
    executionContext(),
  );
  assert.equal(notFound.status, 404);
  assertHardened(notFound, "a 404");

  const limited = await worker.fetch(
    new Request("https://example.test/api/meta", { headers: HEADERS }),
    { DB: forbiddenDatabase(), API_RATE_LIMITER: limiter(false) } as unknown as Env,
    executionContext(),
  );
  assert.equal(limited.status, 429);
  assertHardened(limited, "a 429");

  const unavailable = await worker.fetch(
    new Request("https://example.test/api/meta", { headers: HEADERS }),
    { DB: forbiddenDatabase() } as unknown as Env,
    executionContext(),
  );
  assert.equal(unavailable.status, 503);
  assertHardened(unavailable, "a 503");
});

test("a permalink 404 document is hardened", async () => {
  const env = { DB: forbiddenDatabase(), API_RATE_LIMITER: limiter(true) } as unknown as Env;
  const response = await worker.fetch(
    new Request("https://example.test/p/not-a-key", { headers: HEADERS }),
    env,
    executionContext(),
  );
  assert.equal(response.status, 404);
  assertHardened(response, "a permalink 404");
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
});

test("no document the Worker renders needs an inline style or script", () => {
  const html = renderProductPermalinkHtml(
    {
      product: {
        key: "c-1",
        manufacturer: "LUXMAN",
        model: "L-505",
        category: "amp",
        direct_categories: [],
        presentation_colors: [],
        offer_count: 1,
        in_stock_offer_count: 1,
        lowest_price_yen: 1000,
        highest_price_yen: 1000,
      },
      offers: [],
    } as never,
    "https://example.test",
  );

  // `style-src-elem 'self'` and `script-src 'self'` only hold if the rendered document has none.
  assert.equal(/<style[\s>]/u.test(html), false, "inline <style> would be blocked by the CSP");
  assert.equal(/<script(?![^>]*\ssrc=)/u.test(html), false, "inline <script> would be blocked");
  assert.match(html, /<link rel="stylesheet" href="\/permalink\.css">/u);
});

test("the static asset header file matches the Worker's header set exactly", () => {
  const source = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const lines = source.split("\n").map((line) => line.trimEnd());
  const ruleIndex = lines.indexOf("/*");
  assert.ok(ruleIndex >= 0, "_headers must define a rule for every asset path");

  const declared = new Map<string, string>();
  for (const line of lines.slice(ruleIndex + 1)) {
    if (!line.startsWith("  ")) break;
    const separator = line.indexOf(":");
    declared.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  // Static assets and Worker responses are configured separately by Cloudflare's own design, so the
  // only thing keeping a visitor from seeing two different policies is this assertion.
  assert.deepEqual(
    Object.fromEntries(declared),
    Object.fromEntries(PUBLIC_SECURITY_HEADERS),
    "public/_headers and src/http/security-headers.ts have diverged",
  );
});

test("the enforced policy allows only first-party sources, with one scoped style exception", () => {
  const directives = new Map(
    PUBLIC_CONTENT_SECURITY_POLICY.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values.join(" ")];
    }),
  );

  assert.equal(directives.get("default-src"), "'self'");
  assert.equal(directives.get("script-src"), "'self'");
  assert.equal(directives.get("object-src"), "'none'");
  assert.equal(directives.get("base-uri"), "'none'");
  assert.equal(directives.get("frame-ancestors"), "'none'");
  assert.equal(directives.get("connect-src"), "'self'");
  // Injected stylesheets stay blocked; only React's element `style` attributes are exempt.
  assert.equal(directives.get("style-src-elem"), "'self'");
  assert.equal(directives.get("style-src-attr"), "'unsafe-inline'");
  assert.equal(PUBLIC_CONTENT_SECURITY_POLICY.includes("unsafe-eval"), false);
  assert.equal(/(^|[ ;])\*($|[ ;])/u.test(PUBLIC_CONTENT_SECURITY_POLICY), false);
  // Report-Only was a rollout aid, not the destination: what ships is the enforced header.
  assert.equal(PUBLIC_SECURITY_HEADERS.has("content-security-policy-report-only"), false);
});

test("HSTS makes no claim about hosts this deployment does not own", () => {
  const hsts = PUBLIC_SECURITY_HEADERS.get("strict-transport-security");
  assert.equal(hsts, "max-age=31536000");
  assert.equal(hsts?.includes("includeSubDomains"), false);
  assert.equal(hsts?.includes("preload"), false);
});
