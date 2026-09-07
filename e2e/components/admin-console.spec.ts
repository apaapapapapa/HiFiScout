import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

import { AdminConsolePage } from "../pages/admin-console-page.js";
import {
  adminCsvOriginal,
  adminCsvEditHeader,
  adminCsvEditRow,
} from "../../src/api/admin-csv-contracts.js";

const categories = [
  { id: "digital", name: "デジタル", classifiable: true, filterable: true },
  { id: "amp", name: "アンプ", classifiable: true, filterable: true },
];

const catalogProduct = {
  id: 11,
  manufacturerId: "luxman",
  canonicalModel: "D-1000",
  canonicalName: "LUXMAN D-1000",
  lifecycleStatus: "active",
  primaryCategoryId: "digital",
  matchedListingCount: 2,
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const listingProduct = {
  id: 21,
  shopKey: "audiounion",
  sourceId: "AU-21",
  sourceUrl: "https://example.test/products/21",
  isActive: true,
  stockStatus: "in_stock",
  priceYen: 980000,
  title: "LUXMAN D-1000 ブラック",
  rawManufacturer: "LUXMAN",
  manufacturer: "LUXMAN",
  manufacturerId: "luxman",
  canonicalManufacturerId: "luxman",
  rawModel: "D-1000",
  model: "D-1000",
  normalizedModel: "D1000",
  rawCategory: "デジタルプレーヤー",
  category: "デジタル",
  primaryCategoryId: "digital",
  classificationStatus: "classified",
  presentationColor: "ブラック",
  lastSeenAt: "2026-08-26T00:00:00.000Z",
  lastChangedAt: "2026-08-26T00:00:00.000Z",
  lastActivityAt: "2026-08-26T00:00:00.000Z",
  overrides: {
    manufacturerId: null,
    model: null,
    primaryCategoryId: null,
    presentationColor: null,
    updatedAt: null,
  },
};

async function mockAdminApi(page: Page): Promise<void> {
  let catalog = { ...catalogProduct };
  let listing = { ...listingProduct };

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Vite serves browser-safe source modules under /src/api/ in the fixture gallery.
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname === "/api/meta")
      return json({
        categoryFacets: categories,
        presentationColors: [
          { id: "black", name: "ブラック", aliases: ["black", "黒"], codes: ["b"], order: 0 },
          { id: "silver", name: "シルバー", aliases: ["silver", "銀"], codes: ["s"], order: 1 },
          { id: "gold", name: "ゴールド", aliases: ["gold", "金"], codes: [], order: 2 },
        ],
        shops: [{ key: "audiounion", name: "Audio Union" }],
      });
    if (url.pathname === "/api/admin/manufacturers") {
      const query = (url.searchParams.get("q") || "").toLowerCase();
      return json({
        items: [
          { id: "accuphase", name: "Accuphase" },
          { id: "luxman", name: "LUXMAN" },
        ].filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query)),
        hasMore: false,
        nextAfterId: null,
      });
    }
    if (url.pathname === "/api/admin/knowledge-catalog/products" && request.method() === "GET") {
      if (url.searchParams.get("limit") === "1") {
        const afterId = Number(url.searchParams.get("afterId"));
        return json({
          items:
            afterId === 10
              ? [catalog]
              : afterId === 11
                ? [
                    {
                      ...catalog,
                      id: 12,
                      canonicalModel: "D-1000 Duplicate",
                      primaryCategoryId: "amp",
                      matchedListingCount: 4,
                    },
                  ]
                : [],
          nextAfterId: null,
        });
      }
      return json({ items: [catalog], nextAfterId: null });
    }
    if (
      /^\/api\/admin\/knowledge-catalog\/products\/\d+$/u.test(url.pathname) &&
      request.method() === "PATCH"
    ) {
      const input = request.postDataJSON() as {
        canonicalName?: string;
        primaryCategoryId?: string;
        lifecycleStatus?: "unknown" | "active" | "discontinued";
      };
      catalog = {
        ...catalog,
        canonicalName: input.canonicalName ?? catalog.canonicalName,
        primaryCategoryId: input.primaryCategoryId ?? catalog.primaryCategoryId,
        lifecycleStatus: input.lifecycleStatus ?? catalog.lifecycleStatus,
      };
      return json({ refreshedListings: 2 });
    }
    if (url.pathname === "/api/admin/knowledge-catalog/candidates") {
      return json({ items: [], nextAfterId: null, hasMore: false });
    }
    if (url.pathname === "/api/admin/knowledge-catalog/duplicates") {
      return json({ items: [], nextAfterKey: null, hasMore: false });
    }
    if (url.pathname === "/api/admin/knowledge-catalog-exports") return json({ job: null });
    if (url.pathname === "/api/admin/product-audit-exports") return json({ job: null });
    if (url.pathname === "/api/admin/listings" && request.method() === "GET") {
      return json({ items: [listing], nextAfterId: null, hasMore: false });
    }
    if (/^\/api\/admin\/listings\/\d+$/u.test(url.pathname) && request.method() === "PATCH") {
      const input = request.postDataJSON() as { presentationColor?: string };
      listing = {
        ...listing,
        presentationColor: input.presentationColor ?? listing.presentationColor,
      };
      return json({ listing, refreshedListings: 1 });
    }
    return json({ error: "unmocked_admin_api" }, 500);
  });
}

test.beforeEach(async ({ page }) => {
  await mockAdminApi(page);
});

test("admin exports expose every ZIP volume and retain the legacy CSV download", async ({
  page,
  mount,
}) => {
  const job = {
    id: "complete-archive",
    status: "ready",
    format: "complete",
    archivePartCount: 3,
    rowCount: 2500,
    byteCount: 123456,
    chunkCount: 401,
    error: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const formats: string[] = [];
  await page.route("**/api/admin/knowledge-catalog-exports", (route) => {
    if (route.request().method() === "POST") formats.push(route.request().postDataJSON().format);
    return route.fulfill({ json: route.request().method() === "POST" ? job : { job } });
  });
  await page.route("**/api/admin/product-audit-exports?scope=active", (route) =>
    route.fulfill({
      json: { job: { ...job, id: "legacy-csv", format: "csv", archivePartCount: undefined } },
    }),
  );
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.catalog.csvSummary.click();
  for (let part = 1; part <= 3; part += 1) {
    const link = component.getByRole("link", { name: `ZIP ${part} / 3`, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      "href",
      `/api/admin/knowledge-catalog-exports/complete-archive/download?part=${part}`,
    );
  }
  await expect(component.getByRole("link", { name: "CSVをダウンロード" })).toHaveAttribute(
    "href",
    "/api/admin/product-audit-exports/legacy-csv/download",
  );
  const card = component
    .locator(".export-job")
    .filter({ has: page.getByRole("heading", { name: "Knowledge Catalog", exact: true }) });
  await card.getByRole("button", { name: "編集用CSVを生成" }).click();
  await expect.poll(() => formats).toEqual(["csv"]);
  await card.getByRole("button", { name: "全情報ZIPを生成" }).click();
  await expect.poll(() => formats).toEqual(["csv", "complete"]);
});

test("CSV import retries an outage with the same operation and follows durable pending work", async ({
  page,
  mount,
}) => {
  const original = adminCsvOriginal("listing", 21, {
    manufacturer_id: "luxman",
    model: "C10",
    primary_category_id: "AMP.PRE",
  });
  const csv =
    "listing_id," +
    adminCsvEditHeader("listing") +
    "\n21," +
    adminCsvEditRow(original).replace(/,"C10",/u, ',"C11",');
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const received: { operationId: string }[] = [];
  await page.route("**/api/admin/csv-import/*", async (route) => {
    const input = route.request().postDataJSON();
    const result = { line: 2, id: 21, kind: "listing", message: "確認結果" };
    if (route.request().url().endsWith("/preview")) {
      expect(input.changes).toHaveLength(1);
      return route.fulfill({
        json: { items: [{ ...result, status: "ready", revision: "revision" }] },
      });
    }
    received.push(input);
    if (received.length === 1) {
      return route.fulfill({ status: 503, json: { error: "cloudflare_access_unavailable" } });
    }
    return route.fulfill({
      json: {
        ...result,
        status: received.length === 2 ? "pending" : "applied",
        operationId,
      },
    });
  });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.catalog.csvSummary.click();
  const panel = component.getByRole("region", { name: "編集したCSVで一括登録・更新" });
  await panel.getByLabel("編集済みCSV（100MiB以内）").setInputFiles({
    name: "corrections.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await expect(panel.getByRole("button", { name: "0件の更新を実行" })).toBeDisabled();
  await panel.getByRole("button", { name: "差分を確認" }).click();
  await expect(panel.getByRole("table")).toContainText("C10 → C11");
  await expect(panel.getByRole("table")).toContainText("更新可能");
  expect(received).toHaveLength(0);
  await panel.getByRole("button", { name: "1件の更新を実行" }).click();
  await expect(panel.getByRole("status")).toContainText("更新が完了しました");
  expect(received).toHaveLength(3);
  expect(received[1].operationId).toBe(received[0].operationId);
  expect(received[2].operationId).toBe(operationId);
  await expect(panel.getByRole("button", { name: "結果CSVをダウンロード" })).toBeEnabled();
});

test("CSV imports show new catalog rows alongside corrections and display assigned IDs", async ({
  page,
  mount,
}) => {
  const original = adminCsvOriginal("catalog", 21, {
    manufacturer_id: "luxman",
    canonical_model: "C10",
    canonical_name: "LUXMAN C10",
    primary_category_id: "AMP.PRE",
    lifecycle_status: "unknown",
  });
  const csv =
    "catalog_product_id," +
    adminCsvEditHeader("catalog") +
    "\n21," +
    adminCsvEditRow(original).replace(/,"LUXMAN C10",/u, ',"Corrected C10",') +
    "\n,,luxman,C11,LUXMAN C11,AMP.PRE,unknown";
  const received: (number | null)[] = [];
  await page.route("**/api/admin/csv-import/*", async (route) => {
    const input = route.request().postDataJSON();
    if (route.request().url().endsWith("/preview"))
      return route.fulfill({
        json: {
          items: input.changes.map((change: { line: number; original: { id: number | null } }) => ({
            line: change.line,
            id: change.original.id,
            kind: "catalog",
            status: "ready",
            revision: "revision",
            message: "確認結果",
          })),
        },
      });
    received.push(input.change.original.id);
    return route.fulfill({
      json: {
        line: input.change.line,
        id: input.change.original.id ?? 99,
        kind: "catalog",
        status: "applied",
        operationId: input.operationId,
        message: "反映完了",
      },
    });
  });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.catalog.csvSummary.click();
  const panel = component.getByRole("region", { name: "編集したCSVで一括登録・更新" });
  await panel
    .getByLabel("編集済みCSV（100MiB以内）")
    .setInputFiles({ name: "catalog.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await panel.getByRole("button", { name: "差分を確認" }).click();
  await expect(panel).toContainText("新規追加 1件 / 既存行の修正 1件");
  await expect(panel.getByRole("table")).toContainText("追加可能");
  expect(received).toHaveLength(0);
  await panel.getByRole("button", { name: "2件の登録・更新を実行" }).click();
  await expect(panel.getByRole("status")).toContainText("登録・更新が完了しました");
  await expect(panel.getByRole("table")).toContainText("新規追加 #99");
  expect(received).toEqual([21, null]);
});

for (const failure of ["expired", "redirect"] as const) {
  test(`CSV import retains progress and resumes after an Access ${failure}`, async ({
    page,
    mount,
  }) => {
    const originals = [21, 22].map((id) =>
      adminCsvOriginal("listing", id, {
        manufacturer_id: "luxman",
        model: "C10",
        primary_category_id: "AMP.PRE",
      }),
    );
    const csv =
      "listing_id," +
      adminCsvEditHeader("listing") +
      "\n" +
      originals
        .map(
          (original) =>
            original.id + "," + adminCsvEditRow(original).replace(/,"C10",/u, ',"C11",'),
        )
        .join("\n");
    let previews = 0;
    const received: { operationId: string; change: { original: { id: number } } }[] = [];
    await page.route("**/api/admin/csv-import/*", async (route) => {
      const input = route.request().postDataJSON();
      if (route.request().url().endsWith("/preview")) {
        previews += 1;
        return route.fulfill({
          json: {
            items: originals.map((original, index) => ({
              line: index + 2,
              id: original.id,
              kind: "listing",
              status: "ready",
              revision: "revision",
              message: "更新可能",
            })),
          },
        });
      }
      received.push(input);
      if (received.length === 2) {
        return failure === "expired"
          ? route.fulfill({ status: 403, json: { error: "cloudflare_access_required" } })
          : route.fulfill({ status: 302, headers: { location: "/cdn-cgi/access/login" } });
      }
      return route.fulfill({
        json: {
          line: input.change.line,
          id: input.change.original.id,
          kind: "listing",
          status: "applied",
          operationId: input.operationId,
          message: "適用済み",
        },
      });
    });
    const component = await mount("frontend/admin-console/Default");
    const admin = new AdminConsolePage(component, page);
    await admin.catalog.csvSummary.click();
    const panel = component.getByRole("region", { name: "編集したCSVで一括登録・更新" });
    await panel
      .getByLabel("編集済みCSV（100MiB以内）")
      .setInputFiles({ name: "resume.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await panel.getByRole("button", { name: "差分を確認" }).click();
    await panel.getByRole("button", { name: "2件の更新を実行" }).click();
    await expect(panel.getByRole("alert")).toContainText("別タブでログイン");
    await expect(panel.getByRole("link", { name: "別タブでログインを確認" })).toHaveAttribute(
      "target",
      "_blank",
    );
    await panel.getByRole("button", { name: "残り1件の更新を再開" }).click();
    await expect(panel.getByRole("status")).toContainText("更新が完了しました");
    expect(previews).toBe(1);
    expect(received.map((input) => input.change.original.id)).toEqual([21, 22, 22]);
    expect(received[2].operationId).toBe(received[1].operationId);
    await expect(panel.getByRole("alert")).toHaveCount(0);
  });
}

test("admin catalog screen uses the shared POM for search and edit flows", async ({
  page,
  mount,
}) => {
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);

  await expect(admin.heading).toBeVisible();
  await expect(admin.catalogTab).toHaveAttribute("aria-selected", "true");
  await expect(admin.catalog.heading).toBeVisible();
  await expect(admin.catalog.duplicateHeading).toBeVisible();
  await expect(admin.catalog.candidateHeading).toBeVisible();
  await expect(admin.catalog.csvSummary).toBeVisible();
  await expect(admin.sectionLinks).toHaveCount(4);

  await admin.catalog.searchFor("D-1000");
  await expect(admin.catalog.resultSummary).toContainText("検索「D-1000」");

  await admin.catalog.openEditor(11);
  await expect(admin.catalog.editDialog).toBeVisible();
  await admin.catalog.editName().fill("LUXMAN D-1000 Reference");
  const changes = admin.catalog.editDialog.getByRole("region", { name: "保存前の変更内容" });
  await expect(changes.getByRole("row", { name: /表示名/ })).toContainText(
    "LUXMAN D-1000 Reference",
  );
  await admin.catalog.saveButton().click();
  await expect(admin.catalog.catalogRow(11)).toContainText("LUXMAN D-1000 Reference");
  await expect(admin.catalog.status).toContainText("保存しました");
});

test("admin listings screen uses the shared POM for tab, search, and color edit flows", async ({
  page,
  mount,
}) => {
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);

  await admin.openListings();
  await expect(admin.listingsTab).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/#listings$/u);
  await expect(admin.listings.heading).toBeVisible();
  await expect(admin.sectionLinks).toHaveCount(2);

  await admin.listings.searchFor("D-1000");
  await expect(admin.listings.status).toContainText("検索条件を反映しました");

  await admin.listings.openEditor(21);
  await expect(admin.listings.editDialog).toBeVisible();
  await admin.listings.presentationColor().fill("ブラック/ゴールド");
  await expect(
    admin.listings.editDialog.getByRole("region", { name: "保存前の変更内容" }),
  ).toContainText("ブラック/ゴールド");
  await admin.listings.saveButton().click();
  await expect(admin.listings.listingRow(21)).toContainText("色: ブラック/ゴールド");
});

test("manufacturer lookup keeps the selected ID until a candidate is chosen and shows the saved diff", async ({
  page,
  mount,
}) => {
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.openListings();
  await admin.listings.openEditor(21);
  const picker = admin.listings.editDialog.getByRole("group", { name: "メーカー", exact: true });
  await picker.getByText("メーカー名から選ぶ", { exact: true }).click();
  await picker.getByRole("searchbox", { name: "メーカー候補を検索" }).fill("acc");
  await expect(picker.getByRole("listbox", { name: "メーカー候補", exact: true })).toContainText(
    "Accuphase",
  );
  await expect(picker.locator(".manufacturer-selection")).toContainText("LUXMAN");
  await expect(admin.listings.saveButton()).toBeDisabled();
  await picker
    .getByRole("listbox", { name: "メーカー候補", exact: true })
    .selectOption("accuphase");
  const diff = admin.listings.editDialog.getByRole("region", { name: "保存前の変更内容" });
  await expect(diff).toContainText("luxman");
  await expect(diff).toContainText("Accuphase (accuphase)");
  const request = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/admin/listings/21" && request.method() === "PATCH",
  );
  await admin.listings.saveButton().click();
  expect((await request).postDataJSON()).toEqual({ manufacturerId: "accuphase" });
});

test("manufacturer lookup retries without clearing selection, and unresolved is explicit in the preview", async ({
  page,
  mount,
}) => {
  let calls = 0;
  await page.route("**/api/admin/manufacturers?**", async (route) => {
    calls++;
    await route.fulfill({
      status: calls === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        calls === 1 ? { error: "temporary" } : { items: [], hasMore: false, nextAfterId: null },
      ),
    });
  });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.openListings();
  await admin.listings.openEditor(21);
  const picker = admin.listings.editDialog.getByRole("group", { name: "メーカー", exact: true });
  await picker.getByText("メーカー名から選ぶ", { exact: true }).click();
  await picker.getByRole("button", { name: "メーカー候補を再読み込み" }).click();
  await expect(picker).toContainText("一致する検証済みメーカーがありません");
  await expect(picker.locator(".manufacturer-selection")).toContainText("LUXMAN");
  await expect(admin.listings.saveButton()).toBeDisabled();
  await picker.getByRole("button", { name: "メーカー未解決にする", exact: true }).click();
  await expect(
    admin.listings.editDialog.getByRole("region", { name: "保存前の変更内容" }),
  ).toContainText("メーカー未解決として固定");
});

test("manufacturer choice and changes remain usable on a narrow admin dialog", async ({
  page,
  mount,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.openListings();
  await admin.listings.openEditor(21);
  await admin.listings.presentationColor().fill("silver");
  const diff = admin.listings.editDialog.getByRole("region", { name: "保存前の変更内容" });
  await expect(diff.getByRole("columnheader", { name: "現在", exact: true })).toBeVisible();
  await expect(diff.getByRole("cell", { name: "シルバー", exact: true })).toBeVisible();
  expect(
    await admin.listings.editDialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await admin.listings.editDialog.screenshot({
    path: testInfo.outputPath("admin-edit-preview-mobile.png"),
  });
});

test("an older manufacturer response cannot replace the current query", async ({ page, mount }) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const requested = new Promise<void>((resolve) => {
    received = resolve;
  });
  let sent!: () => void;
  const completed = new Promise<void>((resolve) => {
    sent = resolve;
  });
  await page.route("**/api/admin/manufacturers?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") !== "stale") return route.fallback();
    received();
    await hold;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [{ id: "old", name: "Old result" }],
        hasMore: false,
        nextAfterId: null,
      }),
    });
    sent();
  });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.openListings();
  await admin.listings.openEditor(21);
  const picker = admin.listings.editDialog.getByRole("group", { name: "メーカー", exact: true });
  await picker.getByText("メーカー名から選ぶ", { exact: true }).click();
  await picker.getByRole("searchbox", { name: "メーカー候補を検索" }).fill("stale");
  await requested;
  await picker.getByRole("searchbox", { name: "メーカー候補を検索" }).fill("acc");
  await expect(picker.getByRole("listbox", { name: "メーカー候補", exact: true })).toContainText(
    "Accuphase",
  );
  release();
  await completed;
  await expect(
    picker.getByRole("listbox", { name: "メーカー候補", exact: true }),
  ).not.toContainText("Old result");
  await expect(picker.locator(".manufacturer-selection")).toContainText("LUXMAN");
});

test("every catalog close control confirms before discarding dirty fields", async ({
  page,
  mount,
}) => {
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.catalog.openEditor(11);
  await admin.catalog.editName().fill("Unsaved name");
  page.once("dialog", (dialog) => dialog.dismiss());
  await admin.catalog.editDialog.getByRole("button", { name: "編集画面を閉じる" }).click();
  await expect(admin.catalog.editName()).toHaveValue("Unsaved name");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("Escape");
  await expect(admin.catalog.editDialog).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await admin.catalog.editDialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(admin.catalog.editDialog).toBeHidden();
  await expect(admin.catalog.catalogRow(11)).toContainText("LUXMAN D-1000");
});

test("shop filters use names and manual merge requires a full identity preview", async ({
  page,
  mount,
}) => {
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.openListings();
  await expect(page.locator("#listings-shop-key")).toHaveJSProperty("tagName", "SELECT");
  await page.locator("#listings-shop-key").selectOption({ label: "Audio Union" });
  await expect(page.locator("#listings-shop-key")).toHaveValue("audiounion");
  await admin.catalogTab.click();
  await admin.catalog.openEditor(11);
  const dialog = admin.catalog.editDialog;
  await dialog.getByLabel("統合元 Catalog ID").fill("12");
  await expect(
    dialog.getByRole("button", { name: "このCatalogへ統合", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "統合内容を確認" }).click();
  await expect(dialog.locator(".merge-preview")).toContainText("残す製品（統合先）");
  await expect(dialog.locator(".merge-preview")).toContainText("D-1000 Duplicate");
  await expect(dialog.locator(".merge-preview")).toContainText("アンプ · 関連商品 4件");
  const confirmation = page.waitForEvent("dialog");
  const click = dialog.getByRole("button", { name: "このCatalogへ統合", exact: true }).click();
  const confirm = await confirmation;
  expect(confirm.message()).toContain("残す製品:");
  expect(confirm.message()).toContain("D-1000 (#11)");
  expect(confirm.message()).toContain("D-1000 Duplicate (#12)");
  expect(confirm.message()).toContain("デジタル · 関連商品 2件");
  await confirm.dismiss();
  await click;
  await expect(dialog).toBeVisible();
});
