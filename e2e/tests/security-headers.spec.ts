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

/**
 * The complete set of image sources the public surface is expected to reference.
 *
 * An allowlist rather than an origin check on purpose: a retailer's photo copied into a same-origin
 * path, or inlined as a `data:` URL, would satisfy `img-src 'self' data:` and still be exactly the
 * republication the catalogue does not do. Widening this set is a deliberate decision, so it should
 * take a failing test to notice one was made.
 */
const ALLOWED_IMAGE_PATHS = ["/hifiscout-mark.jpg"];

test("the only images the catalogue loads are its own, and no seller imagery is republished", async ({
  page,
  catalogPage,
}) => {
  // `img-src 'self' data:` is only proven by a document that actually loads an image, and the
  // policy alone cannot tell a first-party icon from a copied product photo.
  const violations = await collectCspViolations(page);
  const imageRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "image") imageRequests.push(request.url());
  });
  const failedImages: string[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "image" && !response.ok())
      failedImages.push(`${response.status()} ${response.url()}`);
  });

  await catalogPage.goto("/");
  await expect(catalogPage.heading).toBeVisible();
  await expect(catalogPage.count).not.toHaveText("—");

  const documentImages = await page.evaluate(() => {
    const icons = [
      ...document.querySelectorAll('link[rel~="icon"], link[rel~="apple-touch-icon"]'),
    ].map((link) => (link as HTMLLinkElement).href);
    const images = [...document.querySelectorAll("img")].map(
      (image) => image.getAttribute("src") ?? "",
    );
    return { icons, images };
  });

  // An `<img>` on the public catalogue would be a product photo: there are none by design.
  expect(documentImages.images, "the catalogue renders no <img> elements").toEqual([]);

  const origin = new URL(page.url()).origin;
  const referenced = [...new Set([...documentImages.icons, ...imageRequests])];
  expect(referenced.length, "the document references at least one image").toBeGreaterThan(0);
  expect(
    referenced.map((url) => (url.startsWith("data:") ? "data:" : new URL(url).pathname)).sort(),
    "only the known first-party image assets may be referenced",
  ).toEqual([...ALLOWED_IMAGE_PATHS].sort());

  for (const url of referenced) {
    expect(new URL(url).origin, `image source must be same-origin: ${url}`).toBe(origin);
    // Without this the directive could be admitting a 404 rather than a real file.
    const fetched = await page.request.get(url);
    expect(fetched.status(), `image must load: ${url}`).toBe(200);
    expect(fetched.headers()["content-type"] ?? "").toMatch(/^image\//u);
  }

  expect(failedImages, "images blocked or missing under the enforced policy").toEqual([]);
  expect(violations, "unexpected CSP violations").toEqual([]);
});

test("paging re-renders under connect-src, and the price history graphic draws", async ({
  page,
  catalogPage,
}) => {
  const violations = await collectCspViolations(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await catalogPage.goto("/");
  // `#count` renders a placeholder dash while the first fetch is in flight, so pagination does not
  // exist yet at that point; waiting for a real count is what makes the rest of this deterministic.
  await expect(catalogPage.count).not.toHaveText("—");
  await expect(catalogPage.cards.first()).toBeVisible();

  // Paging re-renders from the bundle's own fetches, so it exercises `connect-src 'self'` rather
  // than only the initial document.
  const firstKeyBefore = await catalogPage.cards.first().getAttribute("data-key");
  const secondPage = catalogPage.pageIndicator(2);
  await expect(secondPage, "the deployed catalogue has more than one page").toBeVisible();
  await secondPage.click();
  await expect(secondPage).toHaveAttribute("aria-current", "page");
  await expect(catalogPage.cards.first()).toBeVisible();
  expect(
    await catalogPage.cards.first().getAttribute("data-key"),
    "page two shows different listings",
  ).not.toBe(firstKeyBefore);

  // The price history is an inline <svg>, not an image, and it renders only inside the history
  // dialog -- so loading the catalogue alone would never draw it.
  const key = await catalogPage.cards.first().getAttribute("data-key");
  expect(key, "a card exposes its key").toBeTruthy();
  await catalogPage.offerButton(key!).click();
  await expect(catalogPage.offersDialog).toBeVisible();

  // Read the visible disclosure controls to find a listing with history, then expand it.
  const offerDetails = catalogPage.offersDialog.locator(
    ".offer-primary-actions button[aria-controls]",
  );
  await expect(offerDetails.first()).toBeVisible();
  let charted = "";
  for (let index = 0; index < (await offerDetails.count()); index += 1) {
    const details = offerDetails.nth(index);
    const detailId = await details.getAttribute("aria-controls");
    const listingId = detailId?.replace(/^offer-details-/u, "") ?? "";
    if (!listingId) continue;

    const response = await page.request.get(`/api/products/${listingId}/history`);
    const body = (await response.json()) as { history?: unknown[] };
    if ((body.history ?? []).length === 0) continue;

    charted = listingId;
    if ((await details.getAttribute("aria-expanded")) !== "true") await details.click();
    const historyButton = catalogPage.offersDialog.locator(`[data-history="${listingId}"]`);
    await expect(historyButton).toBeVisible();
    await historyButton.click();
    break;
  }
  expect(charted, "an offer on this page has recorded price history").not.toBe("");
  await expect(page.locator("#history-dialog")).toBeVisible();
  await expect(page.locator("svg.history-sparkline")).toBeVisible();

  expect(violations, "unexpected CSP violations").toEqual([]);
  expect(pageErrors, "unexpected page errors under the enforced policy").toEqual([]);
});
