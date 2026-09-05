import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { createApiClient } from "../frontend/api-client.js";
import { parseUrlFilters, productSearchParams } from "../frontend/filters.js";
import type { ProductFilters } from "../frontend/filters.js";
import {
  normalizePrice,
  normalizedPriceFilters,
  priceErrors,
  readPreference,
  savePreference,
} from "../frontend/public-ui-state.js";

function filters(minPrice = "", maxPrice = ""): ProductFilters {
  const parsed = parseUrlFilters("");
  return {
    ...parsed.values,
    features: [],
    facets: [],
    inStock: true,
    favoritesOnly: false,
    recentOnly: false,
    priceDropped: false,
    minPrice,
    maxPrice,
  };
}

test("yen input accepts full-width and grouped integers but never silently drops malformed values", () => {
  assert.equal(normalizePrice(" １，０００，０００ "), "1000000");
  assert.equal(normalizePrice("0"), "0");
  assert.equal(normalizePrice(""), "");
  for (const input of ["-1", "1.5", "10,00", "1e6", "abc", "100円", "9007199254740992"])
    assert.equal(normalizePrice(input), null, input);
  assert.ok(priceErrors(filters("200", "100")).maxPrice);
  assert.equal(normalizedPriceFilters(filters("abc")), null);
  const valid = normalizedPriceFilters(filters("１００，０００", "1,000,000"));
  assert.ok(valid);
  assert.equal(productSearchParams(valid).get("minPrice"), "100000");
  assert.equal(productSearchParams(valid).get("maxPrice"), "1000000");
});

test("unavailable browser storage cannot break boot or pretend a preference was persisted", () => {
  vi.stubGlobal("localStorage", {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("quota");
    },
  });
  try {
    assert.equal(readPreference("view"), null);
    assert.equal(savePreference("favorites", "{}"), false);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("explicit retry bypasses even a cached malformed success response", async () => {
  let count = 0;
  const client = createApiClient(async () => Response.json({ attempt: ++count }));
  assert.deepEqual(await client.fetchJson("/api/meta"), { attempt: 1 });
  assert.deepEqual(await client.fetchJson("/api/meta"), { attempt: 1 });
  assert.deepEqual(await client.fetchJson("/api/meta", { refresh: true }), { attempt: 2 });
});

test("API requests time out and forward caller cancellation without caching an aborted response", async () => {
  vi.useFakeTimers();
  const client = createApiClient(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
  try {
    const request = client.fetchJson("/api/meta");
    const rejected = assert.rejects(request, { name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    const controller = new AbortController();
    const cancelled = client.fetchJson("/api/meta", { signal: controller.signal });
    const aborted = assert.rejects(cancelled, { name: "AbortError" });
    controller.abort();
    await aborted;
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});
