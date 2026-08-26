import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { FEATURE_DEFINITIONS } from "../src/api/contracts.js";
import {
  activeFilterEntries,
  featureFromFilterId,
  filterUrlParams,
  parseUrlFilters,
  productSearchParams,
  savedSearchFeedPath,
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
    features: [],
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

test("the saved-search feed carries filters but not UI sorting or pagination", () => {
  assert.equal(
    savedSearchFeedPath(
      filters({
        q: "TAD 1000",
        shop: "hifido",
        manufacturer: "TAD",
        category: "dac",
        sort: "priceAsc",
        features: ["phono_input", "dac"],
        inStock: true,
        recentOnly: true,
        priceDropped: true,
      }),
    ),
    "/api/feed?q=TAD+1000&shop=hifido&manufacturer=TAD&category=dac&feature=dac&feature=phono_input&inStock=true&newOnly=true&priceDropped=true",
  );
  assert.equal(savedSearchFeedPath(filters({ inStock: false })), "/api/feed");
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

test("selected features reach the API as repeated, sorted parameters", () => {
  const params = productSearchParams(filters({ features: ["phono_input", "dac"] }));

  // Sorted on the way out so two users who ticked the same boxes in a different order collapse
  // onto the one edge-cache key the server canonicalises to.
  assert.deepEqual(params.getAll("feature"), ["dac", "phono_input"]);
});

test("a feature selection survives the address bar", () => {
  const url = filterUrlParams(filters({ features: ["headphone_output", "dac"] }), "list");
  assert.equal(url.getAll("feature").join(","), "dac,headphone_output");

  const parsed = parseUrlFilters(`?${url.toString()}`);
  assert.deepEqual(parsed.features, ["dac", "headphone_output"]);
});

test("the shared comma-separated form is accepted and de-duplicated", () => {
  const parsed = parseUrlFilters("?feature=dac,phono_input&feature=dac");
  assert.deepEqual(parsed.features, ["dac", "phono_input"]);
});

test("a feature outside the vocabulary never becomes filter state", () => {
  // The server answers 400 feature_invalid for these; the UI must not offer to round-trip one.
  assert.deepEqual(parseUrlFilters("?feature=teleport&feature=dac").features, ["dac"]);
});

test("each selected feature is its own removable, counted chip", () => {
  const entries = activeFilterEntries(filters({ features: ["dac", "network_playback"] }), {
    shop: "",
    category: "",
  });
  const features = entries.filter((entry) => featureFromFilterId(entry.id));

  assert.deepEqual(
    features.map((entry) => entry.label),
    ["DAC搭載", "ネットワーク対応"],
  );
  assert.ok(
    features.every((entry) => entry.detail),
    "features count toward the mobile filter badge",
  );
  assert.equal(featureFromFilterId(features[0]!.id), "dac");
  assert.equal(featureFromFilterId("shop"), null);
});

test("the filter UI derives its options from the shared vocabulary", () => {
  // Ids repeated in the frontend are how four working filters shipped unreachable: the server
  // gained them and no second edit ever exposed them.
  const parsed = parseUrlFilters(
    `?${FEATURE_DEFINITIONS.map((feature) => `feature=${feature.id}`).join("&")}`,
  );
  assert.equal(parsed.features.length, FEATURE_DEFINITIONS.length);
});

test("features are not claimed as active while favorites are shown locally", () => {
  const selected = { features: ["dac"] as const };
  const labels = { shop: "", category: "" };

  assert.ok(
    activeFilterEntries(filters({ ...selected }), labels).some((entry) =>
      featureFromFilterId(entry.id),
    ),
  );

  // Favorites are matched against stored snapshots, which carry no feature facts, so the predicate
  // cannot run there. A chip and a filter count claiming otherwise would misreport the results.
  const inFavorites = activeFilterEntries(filters({ ...selected, favoritesOnly: true }), labels);
  assert.equal(
    inFavorites.filter((entry) => featureFromFilterId(entry.id)).length,
    0,
    "no feature chip while the predicate cannot be applied",
  );

  // The selection itself survives, so it applies again as soon as the mode is turned off.
  assert.deepEqual(
    productSearchParams(filters({ ...selected, favoritesOnly: true })).getAll("feature"),
    ["dac"],
  );
});
