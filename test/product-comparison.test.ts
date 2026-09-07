import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { canonicalComparisonKeys, comparisonKeysFromSearch, comparisonPath, loadComparisonProducts } from "../frontend/product-comparison.js";
import { sanitizedCatalogSearch } from "../frontend/catalog-url-sanitizer.js";
import { createApiClient } from "../frontend/api-client.js";
import type { ProductSearchItem } from "../src/api/contracts.js";

function product(key: string): ProductSearchItem {
  return {
    key, identity_kind: "catalog", catalog_product_id: Number(key.slice(2)), manufacturer: "Maker", manufacturer_id: "maker", model: key,
    category: "", primary_category_id: "unclassified", offer_count: 0, in_stock_offer_count: 0, sold_out_offer_count: 0, shop_count: 0,
    lowest_price_yen: null, highest_price_yen: null, latest_activity_at: null, newest_listed_at: null,
    has_new_offer: false, has_price_drop: false, representative_offer: null,
  };
}

test("comparison URLs canonicalize catalog identities and survive catalog sanitization", () => {
  const path = comparisonPath(["c-03", "c-1", "c-3"]);
  assert.equal(path, "/?compare=c-1%2Cc-3");
  const search = sanitizedCatalogSearch("?q=amp&compare=c-03,c-1&compare=c-3");
  assert.equal(search, "q=amp&compare=c-1%2Cc-3");
  assert.equal(sanitizedCatalogSearch(search), search);
  assert.deepEqual(comparisonKeysFromSearch(path!.slice(1)), ["c-1", "c-3"]);
  assert.equal(comparisonPath(["c-1"]), null);
  for (const keys of [["c-1", "l-2"], ["c-0"], ["c-1", "c-2", "c-3", "c-4", "c-5"], ["c-1", "c-9999999999999999"]]) assert.deepEqual(canonicalComparisonKeys(keys), []);
  assert.deepEqual(comparisonKeysFromSearch("?compare=" + "c-1,".repeat(1000)), []);
});

test("comparison requests are bounded and validate each returned identity independently", async () => {
  const requests: string[] = [];
  const api = createApiClient(async (input) => {
    const path = String(input);
    requests.push(path);
    const key = path.split("/").at(-1)!;
    if (key === "c-2") return new Response("unavailable", { status: 503 });
    return Response.json({ product: product(key === "c-3" ? "c-1" : key), offers: [] });
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await loadComparisonProducts(api, ["c-1"], signal), []);
  assert.deepEqual(await loadComparisonProducts(api, ["c-1", "c-2", "c-3", "c-4", "c-5"], signal), []);
  assert.equal(requests.length, 0);
  const columns = await loadComparisonProducts(api, ["c-4", "c-1", "c-2", "c-3", "c-1"], signal);
  assert.equal(requests.length, 4);
  assert.deepEqual(columns.map((column) => [column.key, column.product?.key ?? null]), [["c-1", "c-1"], ["c-2", null], ["c-3", null], ["c-4", "c-4"]]);
  assert.equal(columns[0].product?.lowest_price_yen, null);
});

test("cancelled comparison requests do not become unavailable-product results", async () => {
  const controller = new AbortController();
  controller.abort();
  const api = createApiClient(async () => { throw new Error("unexpected request"); });
  await assert.rejects(loadComparisonProducts(api, ["c-1", "c-2"], controller.signal), { name: "AbortError" });
});
