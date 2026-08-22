import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { handleAuthenticatedAdminEntryRequest } from "../src/admin/entry.js";

function adminEnv(seenPaths: string[]) {
  return {
    ADMIN_ASSETS: {
      async fetch(input: Request | URL | string): Promise<Response> {
        const request = input instanceof Request ? input : new Request(input);
        seenPaths.push(new URL(request.url).pathname);
        return new Response("admin asset", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
    CATALOG_ADMIN: {
      async listListings(): Promise<unknown> {
        return { items: [], nextAfterId: null, hasMore: false };
      },
      async updateListing(): Promise<unknown> {
        return null;
      },
    },
  } as unknown as Parameters<typeof handleAuthenticatedAdminEntryRequest>[1];
}

function assertAdminSecurityHeaders(response: Response): void {
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/u);
}

test("admin root serves the single unified console entrypoint", async () => {
  const seenPaths: string[] = [];
  const response = await handleAuthenticatedAdminEntryRequest(
    new Request("https://admin.example.test/?ignored=1"),
    adminEnv(seenPaths),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seenPaths, ["/index.html"]);
  assertAdminSecurityHeaders(response);
});

test("admin assets disable Cloudflare HTML canonical redirects", () => {
  const config = readFileSync(new URL("../wrangler.admin.jsonc", import.meta.url), "utf8");
  assert.match(config, /"html_handling"\s*:\s*"none"/u);
});

test("legacy clean admin page URLs are retired", async () => {
  for (const pathname of ["/catalog-admin", "/listing-admin"]) {
    const seenPaths: string[] = [];
    const response = await handleAuthenticatedAdminEntryRequest(
      new Request(`https://admin.example.test${pathname}`),
      adminEnv(seenPaths),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(seenPaths, []);
    assertAdminSecurityHeaders(response);
  }
});

test("legacy HTML is only exposed as an internal tab fragment", async () => {
  for (const pathname of ["/catalog-admin.html", "/listing-admin.html"]) {
    const directPaths: string[] = [];
    const direct = await handleAuthenticatedAdminEntryRequest(
      new Request(`https://admin.example.test${pathname}`),
      adminEnv(directPaths),
    );
    assert.equal(direct.status, 404);
    assert.deepEqual(directPaths, []);

    const fragmentPaths: string[] = [];
    const fragment = await handleAuthenticatedAdminEntryRequest(
      new Request(`https://admin.example.test${pathname}`, {
        headers: { "x-admin-fragment": "1" },
      }),
      adminEnv(fragmentPaths),
    );
    assert.equal(fragment.status, 200);
    assert.deepEqual(fragmentPaths, [pathname]);
    assertAdminSecurityHeaders(fragment);
  }
});

test("unified admin shell exposes accessible tabs and no legacy page links", () => {
  const html = readFileSync(new URL("../admin-public/index.html", import.meta.url), "utf8");

  assert.match(html, /role="tablist"/u);
  assert.match(html, /id="admin-tab-catalog"/u);
  assert.match(html, /id="admin-tab-listings"/u);
  assert.match(html, /aria-controls="catalog-pane"/u);
  assert.match(html, /aria-controls="listings-pane"/u);
  assert.doesNotMatch(html, /href="\/catalog-admin"/u);
  assert.doesNotMatch(html, /href="\/listing-admin"/u);
});
