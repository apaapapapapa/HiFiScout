import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import {
  catalogFeedPath,
  catalogHtmlWithFeedAutodiscovery,
  injectCatalogFeedAutodiscovery,
} from "../src/http/catalog-feed-autodiscovery.js";

test("catalog feed discovery mirrors shareable filters but not presentation state", () => {
  const url = new URL(
    "https://example.test/?manufacturer=TAD&category=power_amp&maxPrice=0500000&feature=dac&inStock=false&newOnly=true&priceDropped=true&sort=priceAsc&view=cards",
  );

  assert.equal(
    catalogFeedPath(url),
    "/api/feed?manufacturer=TAD&category=power_amp&feature=dac&newOnly=true&priceDropped=true&maxPrice=500000",
  );
});

test("catalog feed discovery preserves the UI default of in-stock only", () => {
  assert.equal(catalogFeedPath(new URL("https://example.test/")), "/api/feed?inStock=true");
});

test("catalog feed discovery drops values the catalog bootstrap would sanitize", () => {
  const oversized = "x".repeat(101);
  const url = new URL(
    `https://example.test/?q=${oversized}&feature=teleport&minPrice=abc&inStock=maybe&newOnly=nope`,
  );

  assert.equal(catalogFeedPath(url), "/api/feed?inStock=true");
});

test("static Atom metadata is rewritten before JavaScript executes", () => {
  const html =
    '<head><link data-saved-search-feed rel="alternate" type="application/atom+xml" href="/api/feed?inStock=true"></head>';
  const url = new URL("https://example.test/?manufacturer=TAD&newOnly=true");

  assert.equal(
    injectCatalogFeedAutodiscovery(html, url),
    '<head><link data-saved-search-feed rel="alternate" type="application/atom+xml" href="/api/feed?manufacturer=TAD&amp;inStock=true&amp;newOnly=true"></head>',
  );
});

test("rewritten catalog responses discard validators for the original static asset", async () => {
  const response = new Response(
    '<link data-saved-search-feed rel="alternate" href="/api/feed?inStock=true">',
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag: '"static"',
        "last-modified": "Wed, 26 Aug 2026 00:00:00 GMT",
      },
    },
  );

  const rewritten = await catalogHtmlWithFeedAutodiscovery(
    response,
    new URL("https://example.test/?manufacturer=TAD"),
  );

  assert.equal(rewritten.headers.get("etag"), null);
  assert.equal(rewritten.headers.get("last-modified"), null);
  assert.match(await rewritten.text(), /manufacturer=TAD&amp;inStock=true/u);
});

test("Cloudflare routes the catalog root through the Worker before serving static assets", () => {
  const config = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as { assets?: { run_worker_first?: unknown } };

  assert.deepEqual(config.assets?.run_worker_first, ["/api/*", "/"]);
});
