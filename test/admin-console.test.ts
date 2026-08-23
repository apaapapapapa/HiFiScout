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

test("admin root serves the single React console entrypoint", async () => {
  const seenPaths: string[] = [];
  const response = await handleAuthenticatedAdminEntryRequest(
    new Request("https://admin.example.test/?ignored=1"),
    adminEnv(seenPaths),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seenPaths, ["/index.html"]);
  assertAdminSecurityHeaders(response);
});

test("admin brand image is served through the protected static asset binding", async () => {
  const seenPaths: string[] = [];
  const response = await handleAuthenticatedAdminEntryRequest(
    new Request("https://admin.example.test/hifiscout-mark.jpg"),
    adminEnv(seenPaths),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seenPaths, ["/hifiscout-mark.jpg"]);
  assertAdminSecurityHeaders(response);
});

test("admin assets disable Cloudflare HTML canonical redirects", () => {
  const config = readFileSync(new URL("../wrangler.admin.jsonc", import.meta.url), "utf8");
  assert.match(config, /"html_handling"\s*:\s*"none"/u);
});

test("all legacy admin page and fragment URLs are retired", async () => {
  for (const pathname of [
    "/catalog-admin",
    "/listing-admin",
    "/catalog-admin.html",
    "/listing-admin.html",
  ]) {
    for (const headers of [{}, { "x-admin-fragment": "1" }]) {
      const seenPaths: string[] = [];
      const response = await handleAuthenticatedAdminEntryRequest(
        new Request(`https://admin.example.test${pathname}`, { headers }),
        adminEnv(seenPaths),
      );

      assert.equal(response.status, 404, `${pathname} must stay retired`);
      assert.deepEqual(seenPaths, []);
      assertAdminSecurityHeaders(response);
    }
  }
});

test("admin HTML is only a React mount shell", () => {
  const html = readFileSync(new URL("../admin-public/index.html", import.meta.url), "utf8");

  assert.match(html, /id="admin-root"/u);
  assert.match(html, /<script src="\/admin-console\.js"><\/script>/u);
  assert.doesNotMatch(html, /role="tablist"/u);
  assert.doesNotMatch(html, /catalog-pane/u);
  assert.doesNotMatch(html, /listings-pane/u);
  assert.doesNotMatch(html, /catalog-admin\.js/u);
  assert.doesNotMatch(html, /listing-admin\.js/u);
  assert.doesNotMatch(html, /catalog-admin\.html/u);
  assert.doesNotMatch(html, /listing-admin\.html/u);
});
