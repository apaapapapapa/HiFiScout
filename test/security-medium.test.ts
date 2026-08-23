import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
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
  const response = await worker.fetch(
    new Request("https://example.test/api/admin/crawl?shop=hifido", {
      method: "POST",
      headers: { authorization: "Bearer legacy-token" },
    }),
    {} as Env,
    executionContext(),
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});
