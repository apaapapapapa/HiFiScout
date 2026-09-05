import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { handleAuthenticatedCatalogAdminRequest } from "../src/admin/index.js";

function adminEnv(seenPaths: string[]) {
  return {
    ADMIN_ASSETS: {
      async fetch(input: Request | URL | string): Promise<Response> {
        const request = input instanceof Request ? input : new Request(input);
        seenPaths.push(new URL(request.url).pathname);
        return new Response("catalog admin", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
    CATALOG_ADMIN: {
      async listProducts(): Promise<unknown> {
        return {};
      },
      async updateProduct(): Promise<unknown> {
        return {};
      },
    },
  } as unknown as Parameters<typeof handleAuthenticatedCatalogAdminRequest>[1];
}

function assertAdminSecurityHeaders(response: Response): void {
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(response.headers.get("permissions-policy") || "", /camera=\(\)/u);
  const csp = response.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'self'/u);
  assert.match(csp, /script-src 'self'/u);
  assert.match(csp, /frame-ancestors 'none'/u);
  assert.match(csp, /object-src 'none'/u);
}

test("Catalog Admin clean routes fetch the clean asset URL instead of the .html redirect target", async () => {
  for (const pathname of ["/", "/catalog-admin"]) {
    const seenPaths: string[] = [];
    const response = await handleAuthenticatedCatalogAdminRequest(
      new Request(`https://admin.example.test${pathname}?ignored=1`),
      adminEnv(seenPaths),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/catalog-admin"]);
    assertAdminSecurityHeaders(response);
  }
});

test("Catalog Admin duplicate review passes a validated cursor to the RPC", async () => {
  const received: unknown[] = [];
  const env = {
    ...adminEnv([]),
    CATALOG_ADMIN: {
      async listDuplicates(options: unknown): Promise<unknown> {
        received.push(options);
        return { items: [], nextAfterKey: null, hasMore: false };
      },
    },
  } as unknown as Parameters<typeof handleAuthenticatedCatalogAdminRequest>[1];

  const response = await handleAuthenticatedCatalogAdminRequest(
    new Request(
      "https://admin.example.test/api/admin/knowledge-catalog/duplicates?manufacturerId=LUXMAN&afterKey=L509MK2&limit=5",
    ),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, [{ manufacturerId: "luxman", afterKey: "L509MK2", limit: 5 }]);
  assertAdminSecurityHeaders(response);

  const rejected = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/knowledge-catalog/duplicates?limit=0"),
    env,
  );

  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: "invalid_catalog_duplicate_query" });
  assert.equal(received.length, 1, "an invalid query never reaches the RPC");
});

test("Catalog Admin JSON responses carry the same browser security policy", async () => {
  const response = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/meta"),
    adminEnv([]),
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^application\/json/u);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assertAdminSecurityHeaders(response);
});

test("admin metadata exposes shop names and keys for the shop selector", async () => {
  const response = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/meta"),
    adminEnv([]),
  );
  const meta = (await response.json()) as { shops: { key: string; name: string }[] };
  assert.ok(meta.shops.some((shop) => shop.key === "hifido" && shop.name === "ハイファイ堂"));
  assert.equal(new Set(meta.shops.map((shop) => shop.key)).size, meta.shops.length);
});
