import { test } from "vitest";
import assert from "node:assert/strict";

import {
  activeFilterEntries,
  filterUrlParams,
  parseUrlFilters,
  productSearchParams,
} from "../frontend/filters.js";
import type { ProductFilters } from "../frontend/filters.js";

function filters(overrides: Partial<ProductFilters> = {}): ProductFilters {
  return {
    q: "",
    shop: "",
    manufacturer: "",
    category: "",
    minPrice: "",
    maxPrice: "",
    sort: "newest",
    inStock: true,
    favoritesOnly: false,
    recentOnly: false,
    priceDropped: false,
    ...overrides,
  };
}

test("the default query asks only for the first page of in-stock listings", () => {
  const params = productSearchParams(filters());
  assert.equal(params.toString(), "sort=newest&inStock=true&limit=50");
});

test("a cursor supersedes offset paging", () => {
  const withCursor = productSearchParams(filters(), { cursor: "abc", page: 4 });
  assert.equal(withCursor.get("cursor"), "abc");
  assert.equal(withCursor.get("offset"), null);

  const withOffset = productSearchParams(filters(), { page: 4 });
  assert.equal(withOffset.get("offset"), "150");
  assert.equal(withOffset.get("cursor"), null);
  assert.equal(productSearchParams(filters(), { page: 1 }).get("offset"), null);
});

test("a total count is requested only when asked for", () => {
  assert.equal(productSearchParams(filters()).get("includeTotal"), null);
  assert.equal(productSearchParams(filters(), { includeTotal: true }).get("includeTotal"), "true");
});

test("unparseable price input still reaches the API so the server can reject it", () => {
  const params = productSearchParams(filters({ minPrice: "abc" }));
  assert.equal(params.get("minPrice"), "abc");
});

test("the address bar records only non-default state", () => {
  assert.equal(filterUrlParams(filters(), "list").toString(), "");
  assert.equal(
    filterUrlParams(filters({ sort: "priceAsc", q: "TAD" }), "list").toString(),
    "q=TAD&sort=priceAsc",
  );
  // `inStock` defaults to on, so it is the *off* state that has to be encoded.
  assert.equal(filterUrlParams(filters({ inStock: false }), "list").get("inStock"), "false");
  assert.equal(filterUrlParams(filters(), "cards").get("view"), "cards");
  assert.equal(filterUrlParams(filters(), "list").get("view"), null);
});

test("favorites-only is device state and is never shared through the URL", () => {
  assert.equal(filterUrlParams(filters({ favoritesOnly: true }), "list").toString(), "");
});

test("URL state round-trips through the filter controls", () => {
  const source = filters({
    q: "TAD",
    shop: "hifido",
    manufacturer: "LUXMAN",
    category: "pre_amp",
    minPrice: "1000",
    maxPrice: "2000",
    sort: "priceDesc",
    inStock: false,
    recentOnly: true,
    priceDropped: true,
  });

  const parsed = parseUrlFilters(`?${filterUrlParams(source, "cards")}`);

  assert.deepEqual(parsed.values, {
    q: "TAD",
    shop: "hifido",
    manufacturer: "LUXMAN",
    category: "pre_amp",
    minPrice: "1000",
    maxPrice: "2000",
    sort: "priceDesc",
  });
  assert.equal(parsed.inStock, false);
  assert.equal(parsed.recentOnly, true);
  assert.equal(parsed.priceDropped, true);
  assert.equal(parsed.view, "cards");
});

test("an empty or unknown URL falls back to the defaults", () => {
  const parsed = parseUrlFilters("");
  assert.equal(parsed.values.sort, "newest");
  assert.equal(parsed.inStock, true);
  assert.equal(parsed.view, null);
  assert.equal(parseUrlFilters("?view=grid").view, null);
});

test("filter chips are ordered and only detail filters are counted", () => {
  const entries = activeFilterEntries(
    filters({ q: "TAD", shop: "hifido", category: "pre_amp", minPrice: "100000" }),
    { shop: "ハイファイ堂", category: "プリアンプ" },
  );

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["q", "shop", "category", "minPrice", "inStock"],
  );
  assert.equal(entries[0].label, "検索: TAD");
  assert.equal(entries[1].label, "ハイファイ堂");
  assert.equal(entries[2].label, "プリアンプ");
  assert.match(entries[3].label, /以上$/u);
  // The free-text query is shown but not counted by the mobile badge.
  assert.equal(entries.filter((entry) => entry.detail).length, 4);
});

test("a category without a resolved label falls back to its id", () => {
  const [entry] = activeFilterEntries(filters({ category: "pre_amp", inStock: false }), {
    shop: "",
    category: "",
  });
  assert.equal(entry.label, "pre_amp");
});
