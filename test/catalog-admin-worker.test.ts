import assert from "node:assert/strict";
import test from "node:test";

import { handleAuthenticatedCatalogAdminRequest } from "../src/admin/index.js";

function adminEnv(seenPaths: string[]) {
  return {
    ADMIN_ASSETS: {
      async fetch(input: Request | URL | string): Promise<Response> {
        const request = input instanceof Request ? input : new Request(input);
        seenPaths.push(new URL(request.url).pathname);
        return new Response("catalog admin", { status: 200 });
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

test("Catalog Admin clean routes fetch the clean asset URL instead of the .html redirect target", async () => {
  for (const pathname of ["/", "/catalog-admin"]) {
    const seenPaths: string[] = [];
    const response = await handleAuthenticatedCatalogAdminRequest(
      new Request(`https://admin.example.test${pathname}?ignored=1`),
      adminEnv(seenPaths),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/catalog-admin"]);
  }
});
