import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { checkPublicApiRateLimit } from "../src/api-guard.js";

test("public API rate limiter keys by actor and route bucket", async () => {
  const keys: string[] = [];
  const env = {
    API_RATE_LIMITER: {
      async limit({ key }: { key: string }) {
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

test("product permalinks share the product-search abuse bucket", async () => {
  const keys: string[] = [];
  const env = {
    API_RATE_LIMITER: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: true };
      },
    },
  };
  const request = new Request("https://example.test/p/c-42?q=TAD", {
    headers: { "cf-connecting-ip": "203.0.113.11" },
  });

  const result = await checkPublicApiRateLimit(request, env);

  assert.equal(result.allowed, true);
  assert.equal(result.bucket, "product-search");
  assert.deepEqual(keys, ["203.0.113.11:product-search"]);
});

test("feed has its own public rate-limit bucket", async () => {
  const keys: string[] = [];
  const env = {
    API_RATE_LIMITER: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: true };
      },
    },
  };
  const request = new Request("https://example.test/api/feed?manufacturer=LUXMAN", {
    headers: { "cf-connecting-ip": "203.0.113.15" },
  });

  const result = await checkPublicApiRateLimit(request, env);

  assert.equal(result.allowed, true);
  assert.equal(result.bucket, "feed");
  assert.deepEqual(keys, ["203.0.113.15:feed"]);
});

test("suggest has its own public rate-limit bucket", async () => {
  const keys: string[] = [];
  const env = {
    API_RATE_LIMITER: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: true };
      },
    },
  };
  const request = new Request("https://example.test/api/suggest?q=PM14S1", {
    headers: { "cf-connecting-ip": "203.0.113.20" },
  });

  const result = await checkPublicApiRateLimit(request, env);

  assert.equal(result.allowed, true);
  assert.equal(result.bucket, "suggest");
  assert.deepEqual(keys, ["203.0.113.20:suggest"]);
});

test("correction report writes use a dedicated public rate-limit bucket", async () => {
  const keys: string[] = [];
  const env = {
    API_RATE_LIMITER: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: true };
      },
    },
  };
  const request = new Request("https://example.test/api/product-correction-reports", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.30" },
  });

  const result = await checkPublicApiRateLimit(request, env);

  assert.equal(result.allowed, true);
  assert.equal(result.bucket, "correction-reports");
  assert.deepEqual(keys, ["203.0.113.30:correction-reports"]);
});

test("unknown public API paths do not bypass the limiter", async () => {
  const keys: string[] = [];
  const env = {
    API_RATE_LIMITER: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: true };
      },
    },
  };
  const request = new Request("https://example.test/api/future-write", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.31" },
  });

  const result = await checkPublicApiRateLimit(request, env);

  assert.equal(result.bucket, "unknown-api");
  assert.deepEqual(keys, ["203.0.113.31:unknown-api"]);
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
