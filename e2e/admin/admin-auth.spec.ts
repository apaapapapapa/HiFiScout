import { test, expect } from "./fixtures.js";
import { AdminConsolePage } from "../pages/admin-console-page.js";

const catalogPath = "/api/admin/knowledge-catalog/products";
const listingPath = "/api/admin/listings";
const catalogEdit = {
  canonicalName: "LUXMAN D-1000 更新済み",
  lifecycleStatus: "active",
  primaryCategoryId: "SRC.DISC",
};

test("unauthenticated requests cannot read the console, assets, metadata or admin APIs", async ({
  request,
  app,
}) => {
  for (const path of [
    "/",
    "/admin-console.js",
    "/admin-console.css",
    "/api/meta",
    "/api/admin/manufacturers",
    "/api/admin/work-counts",
    catalogPath,
    listingPath,
    "/api/admin/offer-facts/replay",
    `${listingPath}/21/offer-facts`,
    `${listingPath}/21/diagnosis`,
    "/api/admin/change-history?kind=listing&id=21",
    "/api/admin/crawls",
    "/api/admin/jobs",
    "/api/admin/operations",
    "/api/admin/extraction-preview",
    "/api/admin/manufacturer-registry",
    `${catalogPath}/11/model-facts`,
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(403);
    expect(await response.json()).toEqual({ error: "cloudflare_access_required" });
  }
  for (const [path, data] of [
    [`${catalogPath}/11`, catalogEdit],
    [`${listingPath}/21`, { presentationColor: "シルバー" }],
  ] as const) {
    const response = await request.patch(path, { headers: { origin: app.url }, data });
    expect(response.status(), path).toBe(403);
  }
  expect(app.state.writes).toEqual({ catalog: 0, listing: 0 });
  expect(
    (
      await request.post("/api/admin/offer-facts/replay", {
        headers: { origin: app.url },
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect(app.state.replay.stepCalls).toBe(0);
  expect(
    (
      await request.post(`${catalogPath}/11/model-facts`, {
        headers: { origin: app.url },
        data: {},
      })
    ).status(),
  ).toBe(403);
});

for (const mode of ["expired", "wrong-audience", "invalid-signature"] as const) {
  test(`${mode} Access assertions are rejected by the real Worker`, async ({ request, app }) => {
    const headers = { ...(await app.headers(mode)), origin: app.url };
    for (const path of [
      "/",
      "/admin-console.js",
      "/api/meta",
      "/api/admin/manufacturers",
      "/api/admin/work-counts",
      catalogPath,
      listingPath,
    ]) {
      expect((await request.get(path, { headers })).status(), path).toBe(403);
    }
    expect(
      (await request.patch(`${catalogPath}/11`, { headers, data: catalogEdit })).status(),
    ).toBe(403);
    expect(
      (
        await request.patch(`${listingPath}/21`, {
          headers,
          data: { presentationColor: "シルバー" },
        })
      ).status(),
    ).toBe(403);
    expect(app.state.writes).toEqual({ catalog: 0, listing: 0 });
  });
}

test("mock login loads the built console and saves catalog and listing edits through the Worker", async ({
  page,
  context,
  app,
}) => {
  await context.setExtraHTTPHeaders(await app.headers());
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  const admin = new AdminConsolePage(page.locator("#admin-root"), page);
  await expect(admin.heading).toBeVisible();
  await admin.catalog.openEditor(11);
  await admin.catalog.editName().fill(catalogEdit.canonicalName);
  await admin.catalog.saveButton().click();
  await expect(admin.catalog.editDialog).not.toBeVisible();
  await expect(admin.catalog.catalogRow(11)).toContainText(catalogEdit.canonicalName);
  expect(app.state.catalog.canonicalName).toBe(catalogEdit.canonicalName);

  await admin.openListings();
  await admin.listings.openEditor(21);
  const picker = admin.listings.editDialog.getByRole("group", { name: "メーカー", exact: true });
  await picker.getByText("メーカー名から選ぶ", { exact: true }).click();
  await picker.getByRole("searchbox", { name: "メーカー候補を検索" }).fill("lux");
  await expect(picker.getByRole("listbox", { name: "メーカー候補", exact: true })).toContainText(
    "LUXMAN",
  );
  await admin.listings.presentationColor().fill("silver");
  await expect(
    admin.listings.editDialog.getByRole("region", { name: "保存前の変更内容" }),
  ).toContainText("シルバー");
  await admin.listings.saveButton().click();
  await expect(admin.listings.editDialog).not.toBeVisible();
  await expect(admin.listings.listingRow(21)).toContainText("シルバー");
  expect(app.state.writes).toEqual({ catalog: 1, listing: 1 });
  // Reload proves the view comes from the local RPC state, not just an optimistic React update.
  await page.reload();
  await expect(admin.listings.listingRow(21)).toContainText("シルバー");
});

test("an expired session preserves an edit and only writes after mock reauthentication", async ({
  page,
  context,
  app,
}) => {
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/");
  const admin = new AdminConsolePage(page.locator("#admin-root"), page);
  await admin.catalog.openEditor(11);
  await admin.catalog.editName().fill(catalogEdit.canonicalName);
  await context.setExtraHTTPHeaders(await app.headers("expired"));
  const rejected = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${catalogPath}/11`) && response.request().method() === "PATCH",
  );
  await admin.catalog.saveButton().click();
  expect((await rejected).status()).toBe(403);
  await expect(admin.catalog.editDialog).toBeVisible();
  await expect(admin.catalog.editName()).toHaveValue(catalogEdit.canonicalName);
  await expect(admin.catalog.root.locator('[role="status"]').first()).toContainText(
    "ログインの有効期限が切れたか",
  );
  await expect(admin.catalog.editDialog.getByRole("alert")).toBeVisible();
  expect(app.state.writes.catalog).toBe(0);
  expect(app.state.catalog.canonicalName).toBe("LUXMAN D-1000");

  await context.setExtraHTTPHeaders(await app.headers());
  await admin.catalog.saveButton().click();
  await expect(admin.catalog.editDialog).not.toBeVisible();
  await expect(admin.catalog.catalogRow(11)).toContainText(catalogEdit.canonicalName);
  expect(app.state.writes.catalog).toBe(1);
});

test("mock authentication does not bypass same-origin or JSON validation", async ({
  request,
  app,
}) => {
  const headers = await app.headers();
  for (const [path, data] of [
    [`${catalogPath}/11`, catalogEdit],
    [`${listingPath}/21`, { presentationColor: "シルバー" }],
  ] as const) {
    const response = await request.patch(path, {
      headers: { ...headers, origin: "https://untrusted.example" },
      data,
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "same_origin_required" });
    const invalidJson = await request.patch(path, {
      headers: { ...headers, origin: app.url, "content-type": "text/plain" },
      data: "not JSON",
    });
    expect(invalidJson.status()).toBe(415);
  }
  expect(app.state.writes).toEqual({ catalog: 0, listing: 0 });
});

test("a shop-only deep link loads filtered listings directly without catalog requests", async ({
  page,
  context,
  app,
}) => {
  await context.setExtraHTTPHeaders(await app.headers());
  const requests: URL[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/admin/")) requests.push(new URL(request.url()));
  });
  await page.goto("/?shopKey=audiounion&scope=all#listings");
  const admin = new AdminConsolePage(page.locator("#admin-root"), page);
  await expect(admin.listings.listingRow(21)).toBeVisible();
  await expect(admin.listings.shop).toHaveValue("audiounion");
  await expect(admin.listings.scope).toHaveValue("all");
  const listings = requests.filter((url) => url.pathname === listingPath);
  expect(listings).toHaveLength(1);
  expect(listings[0].searchParams.get("shopKey")).toBe("audiounion");
  expect(listings[0].searchParams.get("scope")).toBe("all");
  expect(requests.some((url) => url.pathname.includes("knowledge-catalog"))).toBe(false);
});

test("manufacturer registry requests pass through the real Access and entry routing guards", async ({
  request,
  app,
}) => {
  const path = "/api/admin/manufacturer-registry",
    input = { action: "get", manufacturerId: "luxman" };
  const headers = { ...(await app.headers()), origin: app.url };
  const response = await request.post(path, { headers, data: input });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ received: input });
  expect(app.state.manufacturerCommands).toEqual([input]);
  const foreign = await request.post(path, {
    headers: { ...headers, origin: "https://other.example" },
    data: input,
  });
  expect(foreign.status()).toBe(403);
  const invalid = await request.post(path, {
    headers,
    data: { action: "preview", edit: {}, afterId: 0 },
  });
  expect(invalid.status()).toBe(400);
  expect(app.state.manufacturerCommands).toHaveLength(1);
});
