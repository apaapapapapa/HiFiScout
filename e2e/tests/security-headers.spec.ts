/**
 * Production response-header verification.
 *
 * Static assets and Worker responses are configured by two separate mechanisms (`public/_headers`
 * and `src/http/security-headers.ts`), and only a real request proves which one a given URL
 * actually went through. This suite runs against the deployed Worker after every deployment.
 */

import type { APIResponse, Page } from "@playwright/test";
import { expect, test } from "../fixtures/catalog-test.js";

const REQUIRED_HEADERS = {
  "content-security-policy": /(^|; )script-src 'self'(;|$)/u,
  "x-content-type-options": /^nosniff$/u,
  "x-frame-options": /^DENY$/u,
  "referrer-policy": /^strict-origin-when-cross-origin$/u,
  "permissions-policy": /camera=\(\)/u,
  "cross-origin-opener-policy": /^same-origin$/u,
  "strict-transport-security": /^max-age=\d+$/u,
} as const;

function expectHardened(response: APIResponse, label: string): void {
  const headers = response.headers();
  for (const [name, pattern] of Object.entries(REQUIRED_HEADERS)) {
    expect(headers[name] ?? "", `${label}: ${name} (HTTP ${response.status()})`).toMatch(pattern);
  }
}

/** Collects every CSP violation the browser reports, from the first navigation onward. */
async function collectCspViolations(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction("__reportCspViolation", (detail: string) => {
    violations.push(detail);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const violation = event as SecurityPolicyViolationEvent;
      void (
        window as unknown as {
          __reportCspViolation(detail: string): Promise<void>;
        }
      ).__reportCspViolation(
        `${violation.violatedDirective} blocked ${violation.blockedURI || "(inline)"}`,
      );
    });
  });
  return violations;
}

test("the catalog top page is served with the public security headers", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  expectHardened(response, "top page");
  expect(response.headers()["content-type"]).toContain("text/html");
});

test("static assets carry the same headers, applied by _headers rather than the Worker", async ({
  request,
}) => {
  for (const asset of ["/styles.css", "/app.js", "/permalink.css"]) {
    const response = await request.get(asset);
    expect(response.status(), `${asset} should be served`).toBe(200);
    expectHardened(response, asset);
  }
});

test("a public API read and its cached repeat are both hardened", async ({ request }) => {
  const first = await request.get("/api/meta");
  expect(first.status()).toBe(200);
  expectHardened(first, "/api/meta");

  // The second request is the one most likely to be answered from the edge cache; headers are
  // applied after the cache lookup, so a hit must look identical.
  const repeat = await request.get("/api/meta");
  expect(repeat.status()).toBe(200);
  expectHardened(repeat, "/api/meta (repeat)");

  const feed = await request.get("/api/feed?inStock=true&limit=1");
  expect(feed.status()).toBe(200);
  expectHardened(feed, "/api/feed");
  expect(feed.headers()["content-type"]).toContain("application/atom+xml");
});

test("application error responses are hardened too", async ({ request }) => {
  const notFound = await request.get("/api/admin/data-platform/status");
  expect(notFound.status()).toBe(404);
  expectHardened(notFound, "a retired admin route");

  const badQuery = await request.get("/api/product-search?facet=not-a-facet");
  expect(badQuery.status()).toBe(400);
  expectHardened(badQuery, "an invalid query");

  const missingProduct = await request.get("/p/c-0");
  expect(missingProduct.status()).toBe(404);
  expectHardened(missingProduct, "a permalink 404");
});

test("a real product permalink is hardened", async ({ request }) => {
  const search = await request.get("/api/product-search?inStock=true&limit=1");
  expect(search.status()).toBe(200);
  const payload = (await search.json()) as { items?: { key?: string }[] };
  const key = payload.items?.[0]?.key;
  test.skip(!key, "the live catalogue returned no products to open");

  const permalink = await request.get(`/p/${key}`);
  expect(permalink.status()).toBe(200);
  expectHardened(permalink, `/p/${key}`);
  expect(permalink.headers()["content-type"]).toContain("text/html");
});

test("search, paging, product detail and shop links work under the enforced policy", async ({
  page,
  catalogPage,
}) => {
  const violations = await collectCspViolations(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await catalogPage.goto("/");
  // The bundle is the first thing `script-src 'self'` has to admit: nothing below renders without it.
  await expect(catalogPage.heading).toBeVisible();
  await expect(catalogPage.searchInput).toBeVisible();

  await catalogPage.searchInput.fill("LUXMAN");
  await catalogPage.searchInput.press("Enter");
  await expect(catalogPage.count).toBeVisible();

  const key = await catalogPage.cards.first().getAttribute("data-key");
  if (key) {
    await catalogPage.offerButton(key).click();
    await expect(catalogPage.offersDialog).toBeVisible();
    const shopLink = catalogPage.offerLinks().first();
    if (await shopLink.count()) {
      await expect(shopLink).toHaveAttribute("href", /^https:\/\//u);
      await expect(shopLink).toHaveAttribute("rel", /noopener/u);
    }
    // Reloading the permalink exercises the server-rendered document, whose stylesheet has to load
    // under `style-src-elem 'self'` now that it is no longer inline.
    await page.reload();
    await expect(page.locator("#product-permalink-page")).toBeVisible();
  }

  expect(violations, "unexpected CSP violations").toEqual([]);
  expect(pageErrors, "unexpected page errors under the enforced policy").toEqual([]);
});
