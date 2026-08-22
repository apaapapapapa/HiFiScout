import assert from "node:assert/strict";
import test from "node:test";

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
