import { expect, test } from "../harness-fixtures.js";
import type { Page } from "@playwright/test";
import { offer, product } from "../tests/product-fixtures.js";

const manufacturer = "BOWERS & WILKINS";
const setProduct = product({
  manufacturer,
  manufacturer_id: "bowers-wilkins",
  model: "Reference set",
  primary_category_id: "AMP.INTEGRATED",
  category: "プリメインアンプ",
  direct_category_ids: ["AMP.INTEGRATED", "PRC.DAC"],
  direct_categories: ["プリメインアンプ", "DAC"],
});

async function mockCatalog(page: Page, items = [setProduct]) {
  const searches: URL[] = [];
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const url = new URL(route.request().url());
      let body: unknown;
      if (url.pathname === "/api/meta") {
        body = {
          status: "healthy",
          shops: [
            {
              key: "shop-a",
              name: "テスト販売店",
              enabled: true,
              intervalMinutes: 60,
              sync: null,
              health: null,
            },
          ],
          manufacturers: [manufacturer, "LUXMAN"],
          categories: [],
          categoryFacets: [
            { id: "AMP", name: "アンプ", parentId: null },
            { id: "AMP.INTEGRATED", name: "プリメインアンプ", parentId: "AMP" },
            { id: "PRC.DAC", name: "DAC", parentId: null },
          ].map((entry, order) => ({
            ...entry,
            order,
            classifiable: true,
            filterable: true,
            group: null,
            activeProductCount: 1,
          })),
        };
      } else if (url.pathname === "/api/product-search") {
        searches.push(url);
        const filtered = url.searchParams.get("category") === "PRC.DAC";
        body = {
          items,
          hasMore: !filtered && !url.searchParams.has("offset"),
          nextCursor: null,
          totalCount: filtered ? items.length : 61,
          totalPages: filtered ? 1 : 2,
        };
      } else if (url.pathname.startsWith("/api/product-search/")) {
        const key = url.pathname.split("/").at(-1)!;
        body = {
          product: { ...items[0], key, catalog_product_id: Number(key.slice(2)) },
          offers: [offer()],
        };
      } else body = {};
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    },
  );
  return searches;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });
});

for (const { width, view } of [
  { width: 1280, view: "cards" },
  { width: 390, view: "list" },
]) {
  test(`product metadata links select exact filters and reset pagination at ${width}px`, async ({
    page,
    mount,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const searches = await mockCatalog(page);
    await mount("frontend/public-app/Default");
    await expect(page.locator(".card")).toHaveCount(1);
    await page.evaluate(
      ({ manufacturer, view }) => {
        const params = new URLSearchParams({
          q: "Reference",
          category: "AMP",
          shop: "shop-a",
          sort: "priceAsc",
          view,
        });
        params.append("manufacturer", manufacturer);
        params.append("manufacturer", "LUXMAN");
        history.replaceState(null, "", `/?${params}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      },
      { manufacturer, view },
    );
    await expect.poll(() => searches.at(-1)?.searchParams.get("q")).toBe("Reference");
    await page.getByRole("button", { name: "2ページ目", exact: true }).click();
    await expect(page.locator('.page-button[aria-current="page"]')).toHaveText("2");
    const dac = page.locator('.card [data-category-filter="PRC.DAC"]');
    await expect(dac).toHaveText("DAC");
    const href = new URL((await dac.getAttribute("href"))!, page.url());
    expect(href.pathname).toBe("/");
    expect(href.searchParams.get("category")).toBe("PRC.DAC");
    expect(href.searchParams.has("page")).toBe(false);
    if (width === 390) await dac.click();
    else {
      await dac.focus();
      await page.keyboard.press("Enter");
    }
    await expect.poll(() => searches.at(-1)?.searchParams.get("category")).toBe("PRC.DAC");
    const params = searches.at(-1)!.searchParams;
    expect(params.get("q")).toBe("Reference");
    expect(params.getAll("shop")).toEqual(["shop-a"]);
    expect(params.get("sort")).toBe("priceAsc");
    expect(params.get("inStock")).toBe("true");
    expect(params.has("offset")).toBe(false);
    expect(params.has("cursor")).toBe(false);
    expect(new URL(page.url()).searchParams.has("page")).toBe(false);
    await expect(page.locator('#active-filters [data-clear-filter="category"]')).toContainText(
      "DAC",
    );

    const maker = page.locator(".card [data-manufacturer-filter]");
    const makerHref = new URL((await maker.getAttribute("href"))!, page.url());
    expect(makerHref.searchParams.getAll("manufacturer")).toEqual([manufacturer]);
    await maker.click();
    await expect
      .poll(() => searches.at(-1)?.searchParams.getAll("manufacturer"))
      .toEqual([manufacturer]);
    expect(searches.at(-1)!.searchParams.get("category")).toBe("PRC.DAC");
    expect(searches.at(-1)!.searchParams.get("q")).toBe("Reference");
    expect(new URL(page.url()).searchParams.getAll("manufacturer")).toEqual([manufacturer]);
  });
}

test("detail metadata searches close the detail and Back restores the detail and original page", async ({
  page,
  mount,
}) => {
  const searches = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await page.getByRole("button", { name: "2ページ目", exact: true }).click();
  await expect(page.locator('.page-button[aria-current="page"]')).toHaveText("2");
  await page.locator(".card .product-title-link").click();
  await expect(page.locator("#offers-dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/p\/c-1$/);
  await page.locator("#offers-dialog [data-manufacturer-filter]").click();
  await expect
    .poll(() => searches.at(-1)?.searchParams.getAll("manufacturer"))
    .toEqual([manufacturer]);
  await expect(page.locator("#offers-dialog")).not.toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  await page.goBack();
  await expect(page.locator("#offers-dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/p\/c-1$/);
  await page.goBack();
  await expect(page.locator("#offers-dialog")).not.toBeVisible();
  await expect(page.locator('.page-button[aria-current="page"]')).toHaveText("2");
  await page.goForward();
  await expect(page.locator("#offers-dialog")).toBeVisible();
  await page.locator('#offers-dialog [data-category-filter="PRC.DAC"]').click();
  await expect.poll(() => searches.at(-1)?.searchParams.get("category")).toBe("PRC.DAC");
  await expect(page.locator("#offers-dialog")).not.toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test("older snapshots keep their primary category link and unpaired labels stay plain text", async ({
  page,
  mount,
}) => {
  await mockCatalog(page, [
    product({
      manufacturer: "",
      primary_category_id: "AMP.INTEGRATED",
      category: "プリメインアンプ",
    }),
    product({
      key: "c-2",
      direct_category_ids: ["AMP.INTEGRATED", "PRC.DAC"],
      direct_categories: ["", "DAC", "未確認のカテゴリ"],
    }),
  ]);
  await mount("frontend/public-app/Default");
  const first = page.locator(".card").first();
  await expect(first.locator(".maker")).toHaveText("メーカー不明");
  await expect(first.locator(".maker a")).toHaveCount(0);
  await expect(first.locator('[data-category-filter="AMP.INTEGRATED"]')).toHaveText(
    "プリメインアンプ",
  );
  const second = page.locator(".card").nth(1);
  await expect(second.locator('[data-category-filter="PRC.DAC"]')).toHaveText("DAC");
  await expect(second.locator("a.category")).toHaveCount(1);
  await expect(second.locator("span.category")).toHaveText("未確認のカテゴリ");
});

test("comparison metadata uses the same search links", async ({ page, mount }) => {
  const searches = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.evaluate(() => {
    history.replaceState(null, "", "/?compare=c-1,c-2");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const table = page.locator(".comparison-table");
  await table.locator('[data-category-filter="PRC.DAC"]').first().click();
  await expect.poll(() => searches.at(-1)?.searchParams.get("category")).toBe("PRC.DAC");
  await table.locator("[data-manufacturer-filter]").first().click();
  await expect
    .poll(() => searches.at(-1)?.searchParams.getAll("manufacturer"))
    .toEqual([manufacturer]);
  expect(new URL(page.url()).searchParams.get("compare")).toBe("c-1,c-2");
});

test("direct detail links outside the React root retain filters in their href and navigation", async ({
  page,
  mount,
}) => {
  const searches = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.evaluate((manufacturer) => {
    const params = new URLSearchParams({
      q: "Reference",
      shop: "shop-a",
      minPrice: "10000",
      view: "cards",
      compare: "c-1,c-2",
    });
    history.replaceState(null, "", `/p/c-1?${params}`);
    const detail = document.createElement("section");
    detail.id = "product-permalink-page";
    detail.dataset.productKey = "c-1";
    // The server-rendered document is outside the story's React root. The SSR unit test checks
    // these data attributes and neutral hrefs against the real HTML renderer.
    for (const [field, value, label] of [
      ["manufacturer", manufacturer, manufacturer],
      ["category", "PRC.DAC", "DAC"],
    ]) {
      const link = document.createElement("a");
      link.setAttribute(`data-${field}-filter`, value);
      link.href = `/?${new URLSearchParams({ [field]: value })}`;
      link.textContent = label;
      detail.appendChild(link);
    }
    document.body.insertBefore(detail, document.body.firstChild);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, manufacturer);
  await expect.poll(() => searches.at(-1)?.searchParams.get("q")).toBe("Reference");
  const detail = page.locator("#product-permalink-page");
  const maker = detail.locator("[data-manufacturer-filter]");
  await expect(page.locator(".card")).toHaveCount(1);
  for (const link of [maker, detail.locator("[data-category-filter]")]) {
    const target = new URL((await link.getAttribute("href"))!, page.url());
    expect(target.pathname).toBe("/");
    expect(target.searchParams.get("q")).toBe("Reference");
    expect(target.searchParams.get("shop")).toBe("shop-a");
    expect(target.searchParams.get("minPrice")).toBe("10000");
    expect(target.searchParams.get("view")).toBe("cards");
    expect(target.searchParams.get("compare")).toBe("c-1,c-2");
  }
  await maker.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => searches.at(-1)?.searchParams.getAll("manufacturer"))
    .toEqual([manufacturer]);
  await expect(detail).toBeHidden();
  expect(new URL(page.url()).pathname).toBe("/");
  await page.goBack();
  await expect(detail).toBeVisible();
  await detail.locator("[data-category-filter]").click();
  await expect.poll(() => searches.at(-1)?.searchParams.get("category")).toBe("PRC.DAC");
  expect(searches.at(-1)!.searchParams.get("q")).toBe("Reference");
  expect(searches.at(-1)!.searchParams.getAll("shop")).toEqual(["shop-a"]);
  await expect(detail).toBeHidden();
});
