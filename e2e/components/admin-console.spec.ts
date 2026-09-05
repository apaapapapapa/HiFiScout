import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

import { AdminConsolePage } from "../pages/admin-console-page.js";
import { adminCsvOriginal, adminCsvEditHeader, adminCsvEditRow } from "../../src/api/admin-csv-contracts.js";

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
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname === "/api/meta")
      return json({
        categoryFacets: categories,
        shops: [{ key: "audiounion", name: "Audio Union" }],
      });
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

test("CSV import previews the edit before applying and follows a durable pending operation", async ({ page, mount }) => {
  const original = adminCsvOriginal("listing", 21, {
    manufacturer_id: "luxman", model: "C10", primary_category_id: "AMP.PRE",
  });
  const csv = "listing_id," + adminCsvEditHeader("listing") + "\n21," +
    adminCsvEditRow(original).replace(/,"C10",/u, ',"C11",');
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const received: { operationId: string }[] = [];
  await page.route("**/api/admin/csv-import/*", async (route) => {
    const input = route.request().postDataJSON();
    const result = { line: 2, id: 21, kind: "listing", message: "確認結果" };
    if (route.request().url().endsWith("/preview")) {
      expect(input.changes).toHaveLength(1);
      return route.fulfill({ json: { items: [{ ...result, status: "ready", revision: "revision" }] } });
    }
    received.push(input);
    return route.fulfill({ json: {
      ...result, status: received.length === 1 ? "pending" : "applied", operationId,
    } });
  });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.catalog.csvSummary.click();
  const panel = component.getByRole("region", { name: "編集したCSVで一括更新" });
  await panel.getByLabel("編集済みCSV（100MiB以内）").setInputFiles({
    name: "corrections.csv", mimeType: "text/csv", buffer: Buffer.from(csv),
  });
  await expect(panel.getByRole("button", { name: "0件の更新を実行" })).toBeDisabled();
  await panel.getByRole("button", { name: "差分を確認" }).click();
  await expect(panel.getByRole("table")).toContainText("C10 → C11");
  await expect(panel.getByRole("table")).toContainText("更新可能");
  expect(received).toHaveLength(0);
  await panel.getByRole("button", { name: "1件の更新を実行" }).click();
  await expect(panel.getByRole("status")).toContainText("更新が完了しました");
  expect(received).toHaveLength(2);
  expect(received[1].operationId).toBe(operationId);
  await expect(panel.getByRole("button", { name: "結果CSVをダウンロード" })).toBeEnabled();
});

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
  await admin.listings.saveButton().click();
  await expect(admin.listings.listingRow(21)).toContainText("色: ブラック/ゴールド");
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
