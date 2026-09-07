import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { product, offer } from "../tests/product-fixtures.js";

const item = product({
  model: "長い製品名 Reference Edition D-1000 / Limited",
  lowest_price_yen: 1_234_567,
  highest_price_yen: 1_234_567,
  offer_count: 1,
  shop_count: 1,
});
const meta = {
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
    {
      key: "shop-b",
      name: "別の販売店",
      enabled: true,
      intervalMinutes: 60,
      sync: null,
      health: null,
    },
  ],
  manufacturers: ["LUXMAN", "Accuphase"],
  categories: [],
  categoryFacets: [
    {
      id: "SRC",
      name: "ソース機器",
      parentId: null,
      order: 4,
      classifiable: false,
      filterable: true,
      group: null,
      activeProductCount: 1,
    },
    {
      id: "ANA.TAPE",
      name: "テープデッキ",
      parentId: "SRC",
      order: 6,
      classifiable: true,
      filterable: true,
      group: "ソース機器",
      activeProductCount: 1,
    },
  ],
};
const results = { items: [item], hasMore: false, nextCursor: null, totalCount: 1, totalPages: 1 };

async function mockCatalog(
  page: Page,
  options: { failMeta?: boolean; pauseSearch?: Promise<void> } = {},
) {
  const seen = { meta: 0, searches: [] as URL[], detail: 0, history: 0 };
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const url = new URL(route.request().url());
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (url.pathname === "/api/meta") {
        seen.meta++;
        return seen.meta === 1 && options.failMeta
          ? json({ error: "unavailable" }, 500)
          : json(meta);
      }
      if (url.pathname === "/api/product-search") {
        seen.searches.push(url);
        await options.pauseSearch;
        return json(
          url.searchParams.get("q") === "zero"
            ? { ...results, items: [], totalCount: 0, totalPages: 0 }
            : results,
        );
      }
      if (url.pathname.startsWith("/api/product-search/")) {
        seen.detail++;
        return seen.detail === 1
          ? json({}, 503)
          : json({
              product: item,
              offers: [
                offer({
                  offer_facts: [
                    {
                      factId: "original_box",
                      state: "absent",
                      source: "seller",
                      sourceField: "condition_text",
                      ruleId: "fixture",
                      confidence: 1,
                      observedAt: "2026-09-07T00:00:00Z",
                    },
                  ],
                }),
              ],
            });
      }
      if (url.pathname.endsWith("/history")) {
        seen.history++;
        return seen.history === 1
          ? json({}, 503)
          : json({
              product: { manufacturer: "LUXMAN", model: "D-1000", title: "LUXMAN D-1000" },
              history: [],
            });
      }
      return json({ suggestions: [] });
    },
  );
  return seen;
}

async function selectShop(page: Page, name = "テスト販売店") {
  await page.locator("#shop summary").click();
  await page.locator("#shop").getByRole("checkbox", { name, exact: true }).check();
  await page.locator("#shop summary").click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });
});

test("named saved searches restore applied filters and support rename and removal", async ({
  page,
  mount,
}) => {
  await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await page.locator("#q").fill("LUXMAN");
  await expect(page).toHaveURL(/q=LUXMAN/);
  await page.locator(".saved-searches > summary").click();
  await page.getByLabel("検索名", { exact: true }).fill("アンプ候補");
  await page.getByRole("button", { name: "この検索を保存", exact: true }).click();
  await expect(page.locator(".saved-searches")).toContainText("検索条件を保存しました");
  await page.locator("#q").fill("TAD");
  await expect(page).toHaveURL(/q=TAD/);
  await page.getByRole("button", { name: "アンプ候補を検索", exact: true }).click();
  await expect(page.locator("#q")).toHaveValue("LUXMAN");
  await expect(page).toHaveURL(/q=LUXMAN/);
  await page.getByRole("button", { name: "アンプ候補の名前を変更", exact: true }).click();
  await page.getByLabel("検索名", { exact: true }).fill("ラック用");
  await page.getByRole("button", { name: "検索名を変更", exact: true }).click();
  const saved = page.locator(".saved-searches li").filter({ hasText: "ラック用" });
  await saved.locator(".feed-subscription > summary").click();
  await expect(saved.getByRole("link", { name: "Atomフィードを開く" })).toHaveAttribute(
    "href",
    /q=LUXMAN/,
  );
  const entries = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hifiscout:saved-searches:v1") || "[]"),
  );
  expect(entries).toHaveLength(1);
  expect(entries[0].name).toBe("ラック用");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "ラック用を削除", exact: true }).click();
  await expect(page.locator(".saved-searches > summary")).toContainText("0/20");
});

test("condition groups stage appearance and service criteria and preserve unknown evidence", async ({
  page,
  mount,
}, testInfo) => {
  const seen = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.getByText("状態・付属品・保証で絞り込む", { exact: true }).click();
  await page
    .getByRole("group", { name: "外観", exact: true })
    .getByRole("checkbox", { name: "目立つ傷なし", exact: true })
    .check();
  await page
    .getByRole("group", { name: "整備・修理・改造歴", exact: true })
    .getByRole("checkbox", { name: "整備済み", exact: true })
    .check();
  expect(seen.searches).toHaveLength(1);
  await page.locator("#apply-filters").click();
  await expect
    .poll(() => seen.searches.at(-1)?.searchParams.getAll("offer"))
    .toEqual(["appearance_clean", "maintenance_serviced"]);
  await page.locator(".offers-button[data-offers]").click();
  await page.getByRole("button", { name: "在庫情報を再読み込み" }).click();
  const facts = page.locator(".offer-facts");
  await expect(facts.getByRole("region", { name: "外観", exact: true })).toContainText("記載なし");
  await expect(facts.getByRole("region", { name: "付属品", exact: true })).toContainText(
    "なし（明記）",
  );
  await expect(
    facts.getByRole("region", { name: "整備・修理・改造歴", exact: true }),
  ).toContainText("記載なし");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath("used-condition-mobile.png"), fullPage: true });
});

test("sale unit, voltage and installed options stay beside their own offer price", async ({
  page,
  mount,
}, testInfo) => {
  await mockCatalog(page);
  const pair = offer({
    price_yen: 100000,
    offer_facts: (["sale_pair", "voltage_100v", "option_dac"] as const).map((factId) => ({
      factId,
      state: "present",
      source: "seller",
      sourceField: "condition_text",
      ruleId: "fixture",
      confidence: 1,
      observedAt: "2026-09-07T00:00:00Z",
    })),
  });
  const single = offer({
    listing_product_id: 2,
    price_yen: 50000,
    offer_facts: (["sale_single", "voltage_230v"] as const).map((factId) => ({
      factId,
      state: "present",
      source: "seller",
      sourceField: "condition_text",
      ruleId: "fixture",
      confidence: 1,
      observedAt: "2026-09-07T00:00:00Z",
    })),
  });
  const configured = product({ representative_offer: pair, offer_count: 2 });
  await page.route(
    (url) => url.pathname.startsWith("/api/product-search"),
    (route) =>
      route.fulfill({
        json:
          new URL(route.request().url()).pathname === "/api/product-search"
            ? { ...results, items: [configured] }
            : { product: configured, offers: [pair, single] },
      }),
  );
  await mount("frontend/public-app/Default");
  const cardTerms = page.locator(".product-commerce .offer-terms");
  await expect(cardTerms).toContainText("ペア販売");
  await expect(cardTerms).toContainText("AC 100V");
  await expect(cardTerms).not.toContainText("230V");
  await page.locator(".offers-button[data-offers]").click();
  const offers = page.locator("li.offer");
  await expect(offers.nth(0).locator(".offer-commerce")).toContainText("100,000");
  await expect(offers.nth(0).locator(".offer-terms")).toContainText("DACボード搭載");
  await expect(offers.nth(1).locator(".offer-commerce")).toContainText("50,000");
  await expect(offers.nth(1).locator(".offer-terms")).toContainText("単体（1台・1本）");
  await expect(offers.nth(1).locator(".offer-terms")).toContainText("AC 230V");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  const priceBox = await offers.nth(0).locator(".offer-commerce").boundingBox();
  const termBox = await offers.nth(0).locator(".offer-terms").boundingBox();
  const updatedBox = await offers.nth(0).locator(".offer-updated").boundingBox();
  expect(termBox!.y).toBeGreaterThanOrEqual(priceBox!.y + priceBox!.height);
  expect(termBox!.y + termBox!.height).toBeLessThanOrEqual(updatedBox!.y);
  await page.screenshot({ path: testInfo.outputPath("offer-terms-mobile.png"), fullPage: true });
});

test("shared comparison loads canonical products, retains failed columns, and retries", async ({
  page,
  mount,
}) => {
  await mockCatalog(page);
  let secondAttempts = 0;
  await page.route("**/api/product-search/c-*", async (route) => {
    const key = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (key === "c-3" && ++secondAttempts === 1) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({
      json: {
        product: product({
          key,
          catalog_product_id: Number(key.slice(2)),
          model: `Model ${key}`,
          specifications:
            key === "c-1"
              ? {
                  widthMm: 440,
                  heightMm: null,
                  depthMm: 400,
                  weightKg: 12.5,
                  inputs: [{ connector: "RCA ライン", count: 3 }],
                  outputs: [],
                  main: [{ name: "定格出力", value: "100 W / 8 Ω" }],
                  sourceUrl: "https://example.test/manual",
                  updatedAt: "2026-09-07T00:00:00Z",
                }
              : null,
          lowest_price_yen: null,
          highest_price_yen: null,
          model_relations:
            key === "c-1"
              ? {
                  links: [
                    {
                      key: "c-2",
                      kind: "successor",
                      manufacturer: "Test",
                      model: "Next model",
                      proof: {
                        kind: "source",
                        sourceUrl: "https://example.test/official",
                        verifiedAt: "2026-09-07T00:00:00Z",
                      },
                    },
                  ],
                  families: [],
                }
              : undefined,
        }),
        offers: [],
      },
    });
  });
  await mount("frontend/public-app/Default");
  await page.evaluate(() => {
    history.replaceState(null, "", "/?compare=c-1%2Cc-3");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const comparison = page.getByRole("region", { name: "製品比較 (2/4)", exact: true });
  await expect(comparison.getByRole("status")).toContainText("取得できない製品");
  await expect(comparison.getByRole("columnheader")).toHaveCount(3);
  await expect(comparison.getByRole("link", { name: "Test Next model" })).toHaveAttribute(
    "href",
    "/p/c-2",
  );
  await expect(comparison.getByRole("link", { name: "出典", exact: true })).toHaveAttribute(
    "href",
    "https://example.test/official",
  );
  await comparison.getByRole("button", { name: "比較情報を再読み込み" }).click();
  await expect(
    comparison.getByRole("columnheader", { name: "Model c-3", exact: true }),
  ).toBeVisible();
  await expect(
    comparison.getByRole("row", { name: "掲載中の価格帯 — —", exact: true }),
  ).toBeVisible();
  await expect(comparison.getByRole("link", { name: "この比較の共有URL" })).toHaveAttribute(
    "href",
    "/?compare=c-1%2Cc-3",
  );
  await expect(page).toHaveURL(/compare=c-1%2Cc-3/);
  await expect(
    comparison.getByRole("row", { name: "幅 440 mm 記載なし", exact: true }),
  ).toBeVisible();
  await expect(
    comparison.getByRole("row", { name: "入力端子 RCA ライン（3系統） 記載なし", exact: true }),
  ).toBeVisible();
  await expect(
    comparison.getByRole("row", { name: "仕様: 定格出力 100 W / 8 Ω 記載なし", exact: true }),
  ).toBeVisible();
  await expect(comparison.getByRole("link", { name: "参照資料" })).toHaveAttribute(
    "href",
    "https://example.test/manual",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    comparison.getByRole("region", { name: "製品の比較表（横にスクロールできます）" }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/model-specifications-mobile.png", fullPage: true });
  await comparison.getByRole("button", { name: "c-3を比較から外す" }).click();
  await expect(page.getByRole("status").filter({ hasText: "もう1件" })).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("region", { name: "製品比較 (2/4)", exact: true })).toBeVisible();
});

test("comparison selection stops at four and survives search filter updates", async ({
  page,
  mount,
}) => {
  await mockCatalog(page);
  const items = Array.from({ length: 5 }, (_, index) =>
    product({ key: `c-${index + 1}`, catalog_product_id: index + 1 }),
  );
  await page.route("**/api/product-search?**", (route) =>
    route.fulfill({ json: { ...results, items, totalCount: 5 } }),
  );
  await page.route("**/api/product-search/c-*", (route) => {
    const key = new URL(route.request().url()).pathname.split("/").at(-1);
    return route.fulfill({
      json: { product: items.find((candidate) => candidate.key === key), offers: [] },
    });
  });
  await mount("frontend/public-app/Default");
  for (let id = 1; id <= 4; id++)
    await page
      .locator(`[data-key="c-${id}"]`)
      .getByRole("button", { name: "製品を比較", exact: true })
      .click();
  const fifth = page
    .locator('[data-key="c-5"]')
    .getByRole("button", { name: "製品を比較", exact: true });
  await expect(fifth).toBeDisabled();
  await page.locator("#q").fill("amp");
  await expect(page).toHaveURL(/q=amp/);
  await expect(page).toHaveURL(/compare=c-1%2Cc-2%2Cc-3%2Cc-4/);
  await page.getByRole("button", { name: "c-2を比較から外す" }).click();
  await expect(fifth).toBeEnabled();
});

test("initial metadata failure stays visible and retries the complete initialization", async ({
  page,
  mount,
}) => {
  const seen = await mockCatalog(page, { failMeta: true });
  await mount("frontend/public-app/Default");
  await expect(page.locator("#sync-summary-text")).toContainText("取得できませんでした");
  await expect(page.locator("#products")).toContainText("検索に必要な情報を取得できませんでした");
  expect((await page.locator("#products").boundingBox())!.y).toBeLessThan(650);
  expect(seen.searches).toHaveLength(0);
  await page.locator("#favoritesOnly").check();
  await expect(page.locator("#products")).toContainText("お気に入りはまだありません");
  await page.locator("#favoritesOnly").uncheck();
  await page.getByRole("button", { name: "再読み込み", exact: true }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  expect(seen.meta).toBe(2);
  expect(seen.searches).toHaveLength(1);
  await expect(page.locator('#shop input[type="checkbox"]')).toHaveCount(2);
});

test("searchable multi-selects send OR choices and remove one active choice", async ({
  page,
  mount,
}) => {
  const seen = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.locator("#manufacturer summary").click();
  await page.getByRole("searchbox", { name: "メーカーの候補を検索" }).fill("accu");
  await page
    .locator("#manufacturer")
    .getByRole("checkbox", { name: "Accuphase", exact: true })
    .check();
  await page.getByRole("searchbox", { name: "メーカーの候補を検索" }).fill("lux");
  await page
    .locator("#manufacturer")
    .getByRole("checkbox", { name: "LUXMAN", exact: true })
    .check();
  await page.locator("#manufacturer summary").click();
  await selectShop(page);
  await selectShop(page, "別の販売店");
  expect(seen.searches).toHaveLength(1);
  await page.locator("#apply-filters").click();
  await expect
    .poll(() => seen.searches.at(-1)?.searchParams.getAll("shop"))
    .toEqual(["shop-a", "shop-b"]);
  expect(seen.searches.at(-1)?.searchParams.getAll("manufacturer")).toEqual([
    "Accuphase",
    "LUXMAN",
  ]);
  expect(new URL(page.url()).searchParams.getAll("shop")).toEqual(["shop-a", "shop-b"]);
  await page.locator('#active-filters [data-clear-filter="manufacturer:Accuphase"]').click();
  await expect
    .poll(() => seen.searches.at(-1)?.searchParams.getAll("manufacturer"))
    .toEqual(["LUXMAN"]);
  expect(seen.searches.at(-1)?.searchParams.getAll("shop")).toEqual(["shop-a", "shop-b"]);
});

test("initial loading does not report zero matches and a completed empty search does", async ({
  page,
  mount,
}) => {
  let finish!: () => void;
  const pauseSearch = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await mockCatalog(page, { pauseSearch });
  await mount("frontend/public-app/Default");
  await expect(page.locator("#count")).toHaveText("—");
  await expect(page.locator("#products")).toContainText("読み込んでいます");
  await expect(page.locator("#products")).not.toContainText("一致する商品はありません");
  finish();
  await expect(page.locator(".card")).toHaveCount(1);
  await page.locator("#q").fill("zero");
  await expect(page.locator("#count")).toHaveText("0");
  await expect(page.locator("#products")).toContainText("一致する商品はありません");
});

test("equipment shortcuts issue one combined search and retain budget and query", async ({
  page,
  mount,
}) => {
  const seen = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.locator("#q").fill("Reference");
  await expect.poll(() => seen.searches.at(-1)?.searchParams.get("q")).toBe("Reference");
  await page.locator("#maxPrice").fill("100000");
  await page.locator("#category").selectOption("ANA.TAPE");
  await page.getByText("機能・仕様で詳しく絞り込む", { exact: true }).click();
  await page.getByLabel("DAC搭載", { exact: true }).selectOption("dac");
  await page.locator("#facet-supported_media-cassette").check();
  await page.locator("#apply-filters").click();
  await expect
    .poll(() => seen.searches.at(-1)?.searchParams.getAll("facet"))
    .toEqual(["supported_media:cassette"]);
  const before = seen.searches.length;
  await page.getByRole("button", { name: "ブックシェルフ", exact: true }).click();
  await expect.poll(() => seen.searches.length).toBe(before + 1);
  const params = seen.searches.at(-1)!.searchParams;
  expect(params.get("category")).toBe("SPK.LOUDSPEAKER");
  expect(params.getAll("facet")).toEqual(["form_factor:bookshelf"]);
  expect(params.getAll("feature")).toEqual([]);
  expect(params.get("q")).toBe("Reference");
  expect(params.get("maxPrice")).toBe("100000");
  await expect(page.getByRole("button", { name: /形状: ブックシェルフを解除/ })).toBeVisible();
  await page.locator("#favoritesOnly").check();
  await expect(page.getByRole("button", { name: "MCカートリッジ", exact: true })).toBeDisabled();
});

test("capability controls preserve absent and unknown states through requests and active chips", async ({
  page,
  mount,
}) => {
  const seen = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.getByText("機能・仕様で詳しく絞り込む", { exact: true }).click();
  await page.locator("#category").selectOption("ANA.TAPE");
  await expect(page.getByRole("group", { name: "対応メディア", exact: true })).toBeVisible();
  await expect(page.locator("#facet-supported_media-cassette")).toBeVisible();
  await expect(page.locator("#facet-supported_media-cd")).toHaveCount(0);
  await page.getByLabel("DAC搭載", { exact: true }).selectOption("dac:absent");
  await page.locator("#apply-filters").click();
  await expect
    .poll(() => seen.searches.at(-1)?.searchParams.getAll("feature"))
    .toEqual(["dac:absent"]);
  await expect(page.getByRole("button", { name: /DAC搭載: 非搭載/ })).toBeVisible();
  await page.getByLabel("録音機能", { exact: true }).selectOption("recording:unknown");
  await page.locator("#apply-filters").click();
  await expect
    .poll(() => seen.searches.at(-1)?.searchParams.getAll("feature"))
    .toEqual(["dac:absent", "recording:unknown"]);
  await page.getByLabel("DAC搭載", { exact: true }).selectOption("dac");
  await page.locator("#apply-filters").click();
  await expect
    .poll(() => seen.searches.at(-1)?.searchParams.getAll("feature"))
    .toEqual(["dac", "recording:unknown"]);
  await page.locator("#favoritesOnly").check();
  await expect(page.getByLabel("DAC搭載", { exact: true })).toBeDisabled();
});

test("mobile drafts apply once, cancel safely, validate prices and trap keyboard focus", async ({
  page,
  mount,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const seen = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator(".card")).toHaveCount(1);
  const originalUrl = page.url();
  await page.locator("#filter-toggle").click();
  await expect(page.locator("#filter-close")).toBeFocused();
  await expect(page.locator(".catalog-results")).toHaveJSProperty("inert", true);
  await page.locator("#filter-close").press("Shift+Tab");
  await expect(page.locator("#apply-filters")).toBeFocused();
  await page.locator("#apply-filters").press("Tab");
  await expect(page.locator("#filter-close")).toBeFocused();
  await selectShop(page);
  await page.locator("#minPrice").fill("100,000");
  await page.locator("#sheet-recentOnly").check();
  expect(seen.searches).toHaveLength(1);
  expect(page.url()).toBe(originalUrl);
  await page.keyboard.press("Escape");
  await expect(page.locator("#filter-toggle")).toBeFocused();
  await page.locator("#filter-toggle").click();
  await expect(page.locator("#shop input:checked")).toHaveCount(0);
  await expect(page.locator("#sheet-recentOnly")).not.toBeChecked();
  await page.locator("#minPrice").fill("200000");
  await page.locator("#maxPrice").fill("100000");
  await expect(page.locator("#price-error")).toContainText("最高価格は最低価格以上");
  await expect(page.locator("#apply-filters")).toBeDisabled();
  await page.locator("#maxPrice").fill("１，０００，０００");
  await selectShop(page);
  await page.locator("#apply-filters").click();
  await expect.poll(() => seen.searches.length).toBe(2);
  expect(seen.searches[1].searchParams.get("minPrice")).toBe("200000");
  expect(seen.searches[1].searchParams.get("maxPrice")).toBe("1000000");
  await expect(page.locator("#filter-toggle")).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("#filter-panel")).toHaveJSProperty("inert", false);
  await expect(page.locator("#shop")).toBeVisible();
});

test("single-offer detail and history keep their targets when retrying failures", async ({
  page,
  mount,
}) => {
  const seen = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await page.locator(".product-title-link").click();
  await page.getByRole("button", { name: "在庫情報を再読み込み" }).click();
  await expect(page.locator(".offer")).toHaveCount(1);
  await expect(page.locator(".offer-facts dl > div").filter({ hasText: "元箱" })).toContainText(
    "なし（明記）",
  );
  await expect(page.locator(".offer-facts dl > div").filter({ hasText: "リモコン" })).toContainText(
    "記載なし",
  );
  expect(seen.detail).toBe(2);
  await page.getByRole("button", { name: "価格履歴", exact: true }).click();
  await page.getByRole("button", { name: "価格履歴を再読み込み" }).click();
  await expect(page.locator("#history-dialog")).toContainText("履歴はまだありません");
  expect(seen.history).toBe(2);
});

test("offer conditions reach the search together and each active chip can be cleared", async ({
  page,
  mount,
}) => {
  const seen = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.getByText("状態・付属品・保証で絞り込む", { exact: true }).click();
  await page.getByRole("checkbox", { name: "リモコン", exact: true }).check();
  await page.getByRole("checkbox", { name: "販売店保証", exact: true }).check();
  await page.locator("#apply-filters").click();
  await expect
    .poll(() => seen.searches.at(-1)?.searchParams.getAll("offer"))
    .toEqual(["remote_control", "shop_warranty"]);
  await page.getByRole("button", { name: "リモコンの明記ありを解除", exact: true }).click();
  await expect
    .poll(() => seen.searches.at(-1)?.searchParams.getAll("offer"))
    .toEqual(["shop_warranty"]);
  await page.locator("#favoritesOnly").check();
  await expect(page.getByRole("checkbox", { name: "販売店保証", exact: true })).toBeDisabled();
});

test("favorite planning saves yen targets and private notes with dirty close protection", async ({
  page,
  mount,
}) => {
  await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await page.locator("[data-fav]").first().click();
  await page.getByRole("button", { name: "希望価格・メモ", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "希望価格・検討メモ", exact: true });
  await dialog.getByLabel("希望価格（円）", { exact: true }).fill("12.5万円");
  await dialog.getByLabel("検討メモ", { exact: true }).fill("ラック幅と付属リモコンを確認");
  await dialog.getByRole("button", { name: "希望価格・メモを保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".watch-summary")).toContainText("125,000");
  await expect(page.locator(".watch-summary")).toContainText("付属リモコン");
  await page.getByRole("button", { name: "希望価格・メモ", exact: true }).click();
  await expect(dialog.getByLabel("検討メモ", { exact: true })).toHaveValue(
    "ラック幅と付属リモコンを確認",
  );
  await expect(
    dialog.getByRole("button", { name: "希望価格・メモを保存", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("検討メモ", { exact: true }).fill("変更途中");
  page.once("dialog", (confirmation) => confirmation.dismiss());
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(dialog).toBeVisible();
  const entries = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hifiscout:watch-preferences:v1") || "[]"),
  );
  expect(entries[0].note).toBe("ラック幅と付属リモコンを確認");
});

test("favorite save failures are visible and removal can be undone", async ({ page, mount }) => {
  await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await page.locator(".fav").click();
  await expect(page.locator(".favorite-notice")).toContainText("この端末");
  await page.locator(".fav").click();
  await page.getByRole("button", { name: "元に戻す" }).click();
  await expect(page.locator(".fav")).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
  });
  await page.locator(".fav").click();
  await expect(page.getByRole("alert")).toContainText("保存できませんでした");
  await expect(page.locator(".fav")).toHaveAttribute("aria-pressed", "true");
});

test("favorite revisit compares observations once and preserves the baseline on a failed retry", async ({
  page,
  mount,
}) => {
  await mockCatalog(page);
  let calls = 0;
  await page.route("**/api/product-search/c-1", (route) => {
    calls++;
    if (calls > 1) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({
      json: {
        product: product({ lowest_price_yen: 90000 }),
        offers: [offer({ price_yen: 90000 })],
      },
    });
  });
  await page.evaluate(() =>
    localStorage.setItem(
      "hifiscout:watch-observations:v1",
      JSON.stringify([
        {
          key: "c-1",
          checkedAt: "2026-09-01T00:00:00Z",
          complete: true,
          offers: [
            { id: 1, shopKey: "shop-a", priceYen: 100000, stock: "in_stock" },
            { id: 2, shopKey: "shop-b", priceYen: 110000, stock: "in_stock" },
          ],
        },
      ]),
    ),
  );
  await mount("frontend/public-app/Default");
  await page.locator(".fav").click();
  await page.locator("#favoritesOnly").check();
  const watch = page.getByRole("region", { name: "お気に入りの変化", exact: true });
  await expect(watch).toContainText("100,000");
  await expect(watch).toContainText("90,000");
  await expect(watch).toContainText("掲載を確認できず");
  await expect(watch.getByRole("button", { name: "この10件を再確認", exact: true })).toBeEnabled();
  expect(calls).toBe(1);
  const saved = await page.evaluate(() => localStorage.getItem("hifiscout:watch-observations:v1"));
  await watch.getByRole("button", { name: "この10件を再確認", exact: true }).click();
  await expect(watch).toContainText("前回の記録を保持しています");
  expect(await page.evaluate(() => localStorage.getItem("hifiscout:watch-observations:v1"))).toBe(
    saved,
  );
  expect(calls).toBe(2);
});

test("long names and seven-digit prices fit across filter breakpoints", async ({
  page,
  mount,
}, testInfo) => {
  await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator(".card")).toHaveCount(1);
  for (const width of [390, 640, 760, 900, 1100, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await expect(page.locator(".price-row")).toContainText("1,234,567");
    if (width <= 1100) await expect(page.locator("#filter-toggle")).toBeVisible();
    if (width <= 760) await expect(page.locator(".view-switch")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`catalog-${width}.png`), fullPage: true });
  }
});

test("desktop applies prices once and keeps pending details separate from immediate controls", async ({
  page,
  mount,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const seen = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.locator("#minPrice").fill("5万");
  await page.locator("#maxPrice").fill("12.5万円");
  await selectShop(page);
  await expect(page.locator("#filter-draft-status")).toContainText("未適用");
  expect(seen.searches).toHaveLength(1);
  await page.locator("#recentOnly").check();
  await expect.poll(() => seen.searches.length).toBe(2);
  expect(seen.searches.at(-1)?.searchParams.has("maxPrice")).toBe(false);
  expect(seen.searches.at(-1)?.searchParams.getAll("shop")).toEqual([]);
  await page.locator("#apply-filters").click();
  await expect.poll(() => seen.searches.length).toBe(3);
  expect(seen.searches.at(-1)?.searchParams.get("minPrice")).toBe("50000");
  expect(seen.searches.at(-1)?.searchParams.get("maxPrice")).toBe("125000");
  expect(seen.searches.at(-1)?.searchParams.get("newOnly")).toBe("true");
  expect(seen.searches.at(-1)?.searchParams.getAll("shop")).toEqual(["shop-a"]);
  await expect(page.locator('[data-clear-filter="maxPrice"]')).toContainText("125,000");
  await page.locator("#apply-filters").click();
  expect(seen.searches).toHaveLength(3);
  await page.locator("#minPrice").fill("１，０００");
  await page.locator("#minPrice").press("Enter");
  await expect(page.locator('[data-clear-filter="minPrice"]')).toHaveText(/1,000以上/);
  expect(seen.searches.at(-1)?.searchParams.get("minPrice")).toBe("1000");
});

test("budget presets and partial relaxation keep unrelated search conditions", async ({
  page,
  mount,
}) => {
  const seen = await mockCatalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.locator("#minPrice").fill("20万");
  await page.getByRole("button", { name: "10万円以下", exact: true }).click();
  await expect(page.locator("#minPrice")).toHaveValue("");
  await expect(page.locator("#maxPrice")).toHaveValue("100000");
  await selectShop(page);
  await page.locator("#apply-filters").click();
  await page.locator("#q").fill("zero");
  await expect(page.locator("#count")).toHaveText("0");
  await page.getByRole("button", { name: "価格条件だけ解除", exact: true }).click();
  await expect.poll(() => seen.searches.at(-1)?.searchParams.has("maxPrice")).toBe(false);
  expect(seen.searches.at(-1)?.searchParams.get("q")).toBe("zero");
  expect(seen.searches.at(-1)?.searchParams.getAll("shop")).toEqual(["shop-a"]);
  expect(seen.searches.at(-1)?.searchParams.get("inStock")).toBe("true");
  await page.getByRole("button", { name: "初期条件に戻す（在庫あり）", exact: true }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  expect(new URL(page.url()).searchParams.has("shop")).toBe(false);
  await expect(page.locator("#inStock")).toBeChecked();
});
