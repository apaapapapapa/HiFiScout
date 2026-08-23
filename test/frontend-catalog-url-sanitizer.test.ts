import { test } from "vitest";
import assert from "node:assert/strict";

import { sanitizedCatalogSearch, sanitizedCatalogUrl } from "../frontend/catalog-url-sanitizer.js";

/**
 * The catalog's first request is built from whatever the address bar holds, so a shared or crafted
 * link is untrusted input. These assert the bounds match what `validateProductQuery` accepts on the
 * server: anything the API would answer `400` to is dropped before the app ever sees it.
 */

test("a clean link is left exactly as it is", () => {
  assert.equal(sanitizedCatalogSearch("?q=LUXMAN&sort=priceAsc"), "q=LUXMAN&sort=priceAsc");
  assert.equal(sanitizedCatalogUrl("/", "?q=LUXMAN", ""), null);
  assert.equal(sanitizedCatalogUrl("/", "", ""), null);
});

test("text parameters over the server's limit are dropped, not truncated", () => {
  // A truncated search is a different search; running it silently would be worse than ignoring it.
  assert.equal(sanitizedCatalogSearch(`?q=${"x".repeat(101)}`), "");
  assert.equal(sanitizedCatalogSearch(`?q=${"x".repeat(100)}`), `q=${"x".repeat(100)}`);
  assert.equal(sanitizedCatalogSearch(`?shop=${"s".repeat(81)}`), "");
  assert.equal(sanitizedCatalogSearch(`?manufacturer=${"m".repeat(101)}`), "");
  assert.equal(sanitizedCatalogSearch(`?category=${"c".repeat(101)}`), "");
});

test("length is counted in code points so a Japanese query is not rejected for its bytes", () => {
  const query = "あ".repeat(100);
  assert.equal(
    sanitizedCatalogSearch(`?q=${encodeURIComponent(query)}`),
    `q=${encodeURIComponent(query)}`,
  );
  assert.equal(sanitizedCatalogSearch(`?q=${encodeURIComponent("あ".repeat(101))}`), "");
});

test("a blank or whitespace-only value carries no state and is dropped", () => {
  assert.equal(sanitizedCatalogSearch("?q=&shop=%20%20"), "");
});

test("price bounds must be plain integers", () => {
  assert.equal(
    sanitizedCatalogSearch("?minPrice=1000&maxPrice=200000"),
    "minPrice=1000&maxPrice=200000",
  );
  assert.equal(sanitizedCatalogSearch("?minPrice=abc&maxPrice=12x"), "");
  assert.equal(sanitizedCatalogSearch("?minPrice=-5&maxPrice=1.5"), "");
  assert.equal(sanitizedCatalogSearch(`?minPrice=${"9".repeat(13)}`), "");
});

test("only the price sorts are shareable", () => {
  assert.equal(sanitizedCatalogSearch("?sort=priceAsc"), "sort=priceAsc");
  assert.equal(sanitizedCatalogSearch("?sort=priceDesc"), "sort=priceDesc");
  // `newest` is the default the app applies itself, so carrying it would only add URL noise.
  assert.equal(sanitizedCatalogSearch("?sort=newest"), "");
  assert.equal(sanitizedCatalogSearch("?sort=invalid"), "");
});

test("toggles are carried only in their non-default state", () => {
  assert.equal(sanitizedCatalogSearch("?inStock=false"), "inStock=false");
  assert.equal(sanitizedCatalogSearch("?inStock=true"), "", "in-stock is already the default");
  assert.equal(sanitizedCatalogSearch("?inStock=maybe"), "");
  assert.equal(
    sanitizedCatalogSearch("?newOnly=true&priceDropped=true"),
    "newOnly=true&priceDropped=true",
  );
  assert.equal(sanitizedCatalogSearch("?newOnly=yes&priceDropped=1"), "");
});

test("device-only and internal state is never accepted from a link", () => {
  // Favorites live in this browser's storage, and a cursor belongs to a query that no longer exists.
  assert.equal(sanitizedCatalogSearch("?favoritesOnly=true&cursor=bogus&limit=999&offset=50"), "");
});

test("a known view preference is kept and anything else falls back to the stored one", () => {
  assert.equal(sanitizedCatalogSearch("?view=cards"), "view=cards");
  assert.equal(sanitizedCatalogSearch("?view=list"), "view=list");
  assert.equal(sanitizedCatalogSearch("?view=grid"), "");
});

test("surviving parameters are ordered so equivalent links normalize to one URL", () => {
  assert.equal(
    sanitizedCatalogSearch("?view=cards&priceDropped=true&sort=priceAsc&maxPrice=5000&q=LUXMAN"),
    "q=LUXMAN&maxPrice=5000&sort=priceAsc&priceDropped=true&view=cards",
  );
});

test("a hostile link is reduced to the parameters the API would accept", () => {
  const hostile =
    `?q=${"x".repeat(101)}&shop=${"s".repeat(81)}&minPrice=abc&sort=invalid` +
    "&inStock=maybe&newOnly=yes&priceDropped=1&favoritesOnly=true&cursor=bogus";

  assert.equal(sanitizedCatalogSearch(hostile), "");
  assert.equal(sanitizedCatalogUrl("/", hostile, ""), "/");
});

test("the hash is preserved when the query is rewritten", () => {
  assert.equal(
    sanitizedCatalogUrl("/", "?sort=invalid&q=LUXMAN", "#results"),
    "/?q=LUXMAN#results",
  );
});
