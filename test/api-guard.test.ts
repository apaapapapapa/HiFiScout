import test from "node:test";
import assert from "node:assert/strict";
import { checkPublicApiRateLimit } from "../src/api-guard.js";

test("public API rate limiter keys by actor and route bucket", async () => {
  const keys = [];
  const env = {
    API_RATE_LIMITER: {
      async limit({ key }) {
        keys.push(key);
        return { success: false };
      },
    },
  };
  const request = new Request("https://example.test/api/products?q=TAD", {
    headers: { "cf-connecting-ip": "203.0.113.10" },
  });

  const result = await checkPublicApiRateLimit(request, env);

  assert.equal(result.allowed, false);
  assert.equal(result.bucket, "products");
  assert.deepEqual(keys, ["203.0.113.10:products"]);
});

test("admin endpoints are not subject to the public limiter", async () => {
  let called = false;
  const env = {
    API_RATE_LIMITER: {
      async limit() {
        called = true;
        return { success: false };
      },
    },
  };
  const request = new Request("https://example.test/api/admin/crawl?shop=hifido", {
    method: "POST",
  });
  const result = await checkPublicApiRateLimit(request, env);
  assert.equal(result.allowed, true);
  assert.equal(called, false);
});
