import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { handleHttp } from "../src/http/router.js";
import { checkPublicApiRateLimit } from "../src/api-guard.js";
import { parseProductPage } from "../src/crawler/parser.js";
import { safeProductSourceUrl } from "../src/db/product-search-entity-mapper.js";

// Keep the regression suite crossing HTTP, crawler, and DTO boundaries so each defense is explicit.
function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

test("product-search list and detail share an abuse-brake rate-limit bucket", async () => {
  const keys: string[] = [];
  const env = {
    API_RATE_LIMITER: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: true };
      },
    },
  } as unknown as Env;
  const headers = new Headers({ "cf-connecting-ip": "203.0.113.7" });

  const list = await checkPublicApiRateLimit(
    { method: "GET", url: "https://example.test/api/product-search?q=TAD", headers },
    env,
  );
  const detail = await checkPublicApiRateLimit(
    { method: "GET", url: "https://example.test/api/product-search/c-12", headers },
    env,
  );

  assert.equal(list.bucket, "product-search");
  assert.equal(detail.bucket, "product-search");
  assert.deepEqual(keys, ["203.0.113.7:product-search", "203.0.113.7:product-search"]);
});

test("common parser rejects executable schemes from retailer JSON-LD", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    name: "TAD ME1TX",
    url: "javascript:alert(document.domain)",
    offers: { price: "1000000", availability: "InStock" },
  })}</script>`;

  assert.deepEqual(
    parseProductPage(html, { shopKey: "test", baseUrl: "https://shop.example.test/" }),
    [],
  );
});

test("JSON-LD obeys the same product URL pattern as anchor parsing", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    name: "TAD ME1TX",
    url: "https://attacker.example/shopdetail/123",
    offers: { price: "1000000", availability: "InStock" },
  })}</script>`;

  assert.deepEqual(
    parseProductPage(html, {
      shopKey: "test",
      baseUrl: "https://shop.example.test/",
      productUrlPattern: /^https:\/\/shop\.example\.test\/product\//,
    }),
    [],
  );
});

test("public product DTO boundary strips non-web URL schemes", () => {
  assert.equal(safeProductSourceUrl("javascript:alert(1)"), "");
  assert.equal(safeProductSourceUrl("data:text/html,<script>alert(1)</script>"), "");
  assert.equal(safeProductSourceUrl("not a url"), "");
  assert.equal(
    safeProductSourceUrl("https://shop.example.test/item/1"),
    "https://shop.example.test/item/1",
  );
});

test("legacy bearer token cannot reach public operational admin routes", async () => {
  const routes = [
    ["GET", "data-platform/status"],
    ["GET", "data-quality/status"],
    ["GET", "data-quality/history?shop=hifido"],
    ["GET", "data-quality/remediation-impact"],
    ["POST", "data-quality/rebuild"],
    ["GET", "data-quality/unresolved-manufacturers"],
    ["POST", "manufacturer-aliases"],
    ["GET", "data-quality/unresolved-models"],
    ["GET", "data-quality/unresolved-identity"],
    ["GET", "data-quality/remediation-events"],
    ["POST", "data-quality/replay-models"],
    ["POST", "data-quality/replay-manufacturers"],
    ["POST", "knowledge-catalog/replay"],
    ["GET", "product-search/consistency"],
    ["POST", "product-search/rebuild"],
    ["POST", "crawl?shop=hifido"],
  ] as const;
  const env = new Proxy(
    { ADMIN_TOKEN: "legacy-token" },
    {
      get(_target, property) {
        assert.fail(`Retired routes must not access the ${String(property)} binding`);
      },
    },
  ) as unknown as Env;

  for (const handler of [worker.fetch, handleHttp]) {
    for (const [method, path] of routes) {
      const response = await handler(
        new Request(`https://example.test/api/admin/${path}`, {
          method,
          headers: { authorization: "Bearer legacy-token" },
        }),
        env,
        executionContext(),
      );
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
  }
});
