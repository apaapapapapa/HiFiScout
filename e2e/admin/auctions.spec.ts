import { test, expect } from "./fixtures.js";
for (const width of [1280, 390])
  test(`auction controls retain separate stops and show unknown billing at ${width}px`, async ({
    page,
    context,
    app,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await context.setExtraHTTPHeaders(await app.headers());
    await page.goto("/#auctions");
    const panel = page.getByRole("region", { name: "Yahoo!オークション管理" });
    await expect(panel).toContainText("実際の課金使用量は未計測");
    await expect(panel).not.toContainText("取得の許可");
    await expect(panel).not.toContainText("再表示の許可");
    await expect(panel).toContainText("robotsによる取得拒否（取得経路の見直しが必要）");
    await expect(panel).not.toContainText("robotsの確認");
    await expect(panel).toContainText("アカウント予算の確認");
    await expect(panel).toContainText("取得元仕様の確認");
    await expect(panel).toContainText("予定停止中");
    await expect(panel.getByRole("button", { name: "収集を再開", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "公開を再開", exact: true })).toBeDisabled();
    expect(app.state.auctions.reads).toBe(1);
    await panel.getByRole("button", { name: "収集を停止", exact: true }).click();
    await expect(panel.getByRole("button", { name: "収集を停止", exact: true })).toBeDisabled();
    expect(app.state.auctions.paused).toBe(true);
    expect(app.state.auctions.publicPaused).toBe(false);
    await panel.getByRole("button", { name: "公開を停止", exact: true }).click();
    await expect(panel.getByRole("button", { name: "公開を停止", exact: true })).toBeDisabled();
    await panel.getByLabel("オーディオ機器 > CDデッキ > 一般").check();
    await panel.getByRole("button", { name: "対象カテゴリを保存" }).click();
    await expect.poll(() => app.state.auctions.categories).toEqual(["2084037425", "2084024118"]);
    await page.reload();
    await expect(panel.getByLabel("オーディオ機器 > CDデッキ > 一般")).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
test("lost stop responses reconcile and failed status never displays zero usage", async ({
  page,
  context,
  app,
}) => {
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#auctions");
  await page.route("**/api/admin/auctions/control", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "収集を停止", exact: true }).click();
  await expect(page.getByRole("button", { name: "収集を停止", exact: true })).toBeDisabled();
  expect(app.state.auctions.paused).toBe(true);
  await page.route("**/api/admin/auctions", (route) =>
    route.fulfill({ status: 503, json: { error: "auction_budget_exhausted" } }),
  );
  await page.getByRole("button", { name: "状態を再読み込み" }).click();
  await expect(
    page.getByText("保存済み状態は未確認です。取得件数・使用量を0とは判断できません。"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "公開を停止", exact: true })).toBeEnabled();
});
test("auction administration retains Access, JSON, size and same-origin boundaries", async ({
  request,
  app,
}) => {
  expect((await request.get("/api/admin/auctions")).status()).toBe(403);
  const headers = { ...(await app.headers()), origin: app.url };
  for (const action of [["pause"], null, "sql", 1])
    expect(
      (await request.post("/api/admin/auctions/control", { headers, data: { action } })).status(),
    ).toBe(400);
  expect(
    (
      await request.post("/api/admin/auctions/control", {
        headers: { ...headers, origin: "https://untrusted.invalid" },
        data: { action: "pause" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/admin/auctions/control", {
        headers,
        data: { action: "pause", extra: "x".repeat(2000) },
      })
    ).status(),
  ).toBe(413);
  expect(
    (
      await request.post("/api/admin/auctions/control", { headers, data: { action: "clear_halt" } })
    ).status(),
  ).toBe(400);
  expect(app.state.auctions.actions).toEqual([]);
});
