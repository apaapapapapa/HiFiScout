import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

import { AdminConsolePage } from "../pages/admin-console-page.js";

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

    if (url.pathname === "/api/meta") return json({ categoryFacets: categories });
    if (url.pathname === "/api/admin/knowledge-catalog/products" && request.method() === "GET") {
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
