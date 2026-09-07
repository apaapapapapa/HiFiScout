import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { createApiClient } from "../frontend/api-client.js";
import { parseUrlFilters, productSearchParams } from "../frontend/filters.js";
import type { ProductFilters } from "../frontend/filters.js";
import {
  clearedDetailFilters,
  clearedFilters,
  desktopPanelFilters,
  filterRelaxations,
  initialFilters,
  normalizePrice,
  normalizedPriceFilters,
  priceErrors,
  readPreference,
  savePreference,
  sameFilters,
} from "../frontend/public-ui-state.js";

function filters(minPrice = "", maxPrice = ""): ProductFilters {
  const parsed = parseUrlFilters("");
  return {
    ...parsed.values,
    features: [],
    facets: [],
    offerFacts: [],
    inStock: true,
    favoritesOnly: false,
    recentOnly: false,
    priceDropped: false,
    minPrice,
    maxPrice,
  };
}

test("price input converts yen and decimal ten-thousands exactly within API bounds", () => {
  assert.equal(normalizePrice(" １，０００，０００ "), "1000000");
  assert.equal(normalizePrice("0"), "0");
  assert.equal(normalizePrice(""), "");
  for (const [input, expected] of [
    ["100円", "100"],
    ["12.5万円", "125000"],
    ["５万", "50000"],
    ["0.0001万", "1"],
    ["99,999,999.9999万円", "999999999999"],
  ])
    assert.equal(normalizePrice(input), expected);
  for (const input of [
    "-1",
    "1.5",
    "10,00",
    "1e6",
    "abc",
    "1.5円",
    "0.00001万",
    "100000000万",
    "1000000000000",
    "9007199254740992",
    "1万5千",
    "1".repeat(41),
  ])
    assert.equal(normalizePrice(input), null, input);
  assert.ok(priceErrors(filters("200", "100")).maxPrice);
  assert.equal(normalizedPriceFilters(filters("abc")), null);
  const valid = normalizedPriceFilters(filters("１００，０００", "1,000,000"));
  assert.ok(valid);
  assert.equal(productSearchParams(valid).get("minPrice"), "100000");
  assert.equal(productSearchParams(valid).get("maxPrice"), "1000000");
});

test("desktop drafts keep detailed edits while immediate controls use their latest state", () => {
  const applied = { ...filters(), q: "latest", inStock: false, sort: "priceAsc", recentOnly: true };
  const draft = {
    ...filters("5万", "12.5万円"),
    q: "old",
    manufacturer: ["LUXMAN"],
    shop: ["shop-a"],
  };
  const merged = desktopPanelFilters(applied, draft);
  assert.equal(merged.q, "latest");
  assert.equal(merged.sort, "priceAsc");
  assert.equal(merged.inStock, false);
  assert.equal(merged.recentOnly, true);
  assert.deepEqual(merged.manufacturer, ["LUXMAN"]);
  assert.equal(merged.minPrice, "5万");
  assert.equal(sameFilters(merged, applied), false);
  assert.equal(
    sameFilters(normalizedPriceFilters(merged)!, {
      ...merged,
      minPrice: "50000",
      maxPrice: "125000",
    }),
    true,
  );
});

test("detail reset, initial state and complete reset have distinct stock and query semantics", () => {
  const current = {
    ...filters("1万"),
    q: "L-505",
    shop: ["shop-a"],
    category: "AMP",
    recentOnly: true,
    sort: "priceAsc",
  };
  const details = clearedDetailFilters(current);
  assert.equal(details.q, "L-505");
  assert.equal(details.recentOnly, true);
  assert.equal(details.inStock, true);
  assert.equal(details.minPrice, "");
  assert.deepEqual(details.shop, []);
  assert.equal(clearedFilters(current).inStock, false);
  assert.deepEqual(initialFilters(current), { ...filters(), specificationFilters: {} });
});

test("empty-search alternatives remove only their named conditions and are limited to three", () => {
  const current = {
    ...filters("50000", "100000"),
    q: "MC",
    category: "ANA.CARTRIDGE",
    shop: ["shop-a"],
    manufacturer: ["LUXMAN"],
  };
  const alternatives = filterRelaxations(current);
  assert.equal(alternatives.length, 3);
  assert.deepEqual(alternatives[0].filters, { ...current, minPrice: "", maxPrice: "" });
  assert.deepEqual(alternatives[1].filters, { ...current, inStock: false });
  assert.deepEqual(alternatives[2].filters, { ...current, shop: [] });
  assert.deepEqual(filterRelaxations(clearedFilters(current)), []);
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
