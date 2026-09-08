import { test, expect } from "./fixtures.js";

test("a linked saved sample runs only on demand and preserves the manual comparison column", async ({
  page,
  context,
  app,
}) => {
  let calls = 0;
  await page.route("**/api/admin/extraction-preview", (route) => {
    calls++;
    expect(route.request().postDataJSON()).toEqual({ samples: [{ listingId: 21 }] });
    const current = {
      manufacturerId: "luxman",
      manufacturer: "LUXMAN",
      model: "D-1000",
      normalizedModel: "D1000",
      categoryId: "SRC.DISC",
      color: "ブラック",
    };
    return route.fulfill({
      json: {
        observedAt: "2026-09-08T00:00:00Z",
        versions: { manufacturer: 12, model: 22, taxonomy: "3" },
        items: [
          {
            listingId: 21,
            title: "LUXMAN D-1000",
            shopKey: "audiounion",
            saved: { ...current, model: "手動型番" },
            current,
            proposed: current,
            withOverrides: { ...current, model: "手動型番" },
            overrides: ["型番"],
            reasons: {
              manufacturer: "resolved / verified_alias",
              model: "resolved / seller_model",
              category: "seller_category",
            },
          },
        ],
      },
    });
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/?listingId=21#extraction");
  await expect(page.getByRole("textbox", { name: "保存済み商品ID" })).toHaveValue("21");
  expect(calls).toBe(0);
  await page.getByRole("button", { name: "保存せず抽出を確認" }).click();
  const result = page.getByRole("region", { name: "抽出比較結果" });
  await expect(result.getByRole("status")).toContainText("登録内容は変更していません");
  const row = result
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "型番", exact: true }) });
  await expect(row.getByRole("cell")).toHaveText(["手動型番", "D-1000", "D-1000", "手動型番"]);
  await page.getByRole("textbox", { name: "保存済み商品ID" }).fill("22");
  await expect(result).toHaveCount(0);
  expect(calls).toBe(1);
  expect(app.state.writes).toEqual({ catalog: 0, listing: 0 });
});

test("draft alias scope and entered seller values are submitted together", async ({
  page,
  context,
  app,
}) => {
  let input: unknown;
  await page.route("**/api/admin/extraction-preview", (route) => {
    input = route.request().postDataJSON();
    return route.fulfill({
      json: {
        observedAt: "2026-09-08T00:00:00Z",
        versions: { manufacturer: 12, model: 22, taxonomy: "3" },
        items: [],
      },
    });
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#extraction");
  await page.getByRole("textbox", { name: "商品タイトル", exact: true }).fill("デモラボ D-1000");
  await page.getByRole("textbox", { name: "元のメーカー表記" }).fill("デモラボ");
  await page.getByRole("textbox", { name: "元の型番表記" }).fill("デモラボ D-1000");
  await page.getByRole("checkbox", { name: "別名を追加した場合も比較する" }).check();
  await page.getByText("メーカー名から選ぶ", { exact: true }).click();
  await page.getByRole("searchbox", { name: "メーカー候補を検索" }).fill("lux");
  await page.getByRole("listbox", { name: "メーカー候補", exact: true }).selectOption("luxman");
  await page.getByRole("textbox", { name: "仮の別名", exact: true }).fill("デモラボ");
  await page.getByRole("button", { name: "保存せず抽出を確認" }).click();
  await expect(page.getByRole("region", { name: "抽出比較結果" })).toBeVisible();
  expect(input).toEqual({
    samples: [
      {
        title: "デモラボ D-1000",
        rawManufacturer: "デモラボ",
        rawModel: "デモラボ D-1000",
        rawCategory: "",
        shopKey: "",
      },
    ],
    draftAlias: { manufacturerId: "luxman", alias: "デモラボ", shopKey: "" },
  });
  expect(app.state.writes).toEqual({ catalog: 0, listing: 0 });
});
