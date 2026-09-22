import { test, expect } from "./fixtures.js";
import type { AdminCrawlOverview } from "../../src/api/admin-listing-contracts.js";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
])
  test(`collection flags persist per shop across reloads and quiet hours at ${viewport.width}px`, async ({
    page,
    context,
    app,
  }) => {
    await page.setViewportSize(viewport);
    await context.setExtraHTTPHeaders(await app.headers());
    await page.goto("/#crawls");
    const panel = page.getByRole("region", { name: "ショップ別クロール管理" });
    const row = panel
      .getByRole("row")
      .filter({ has: page.getByRole("switch", { name: "ハイファイ堂の収集" }) });
    const toggle = panel.getByRole("switch", { name: "ハイファイ堂の収集" });
    const other = panel.getByRole("switch", { name: "eイヤホンの収集" });
    await expect(panel).toContainText("夜間の予定停止中");
    await expect(row).toContainText("前回比 -10件");
    await expect(row).toContainText("取得 10ページ");
    await expect(row).toContainText("取得先から503応答");
    await expect(toggle).toBeChecked();
    await expect(other).toBeChecked();
    expect(app.state.crawls.reads).toBe(1);
    expect(app.state.crawls.actions).toEqual([]);
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(row.getByRole("button", { name: "途中から再実行" })).toBeDisabled();
    await expect(other).toBeChecked();
    await page.reload();
    await expect(toggle).not.toBeChecked();
    await expect(other).toBeChecked();
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await expect(row.getByRole("button", { name: "途中から再実行" })).toBeEnabled();
    expect(app.state.crawls.actions).toEqual([
      { shopKey: "hifido", action: "pause" },
      { shopKey: "hifido", action: "resume" },
    ]);
    expect(app.state.crawls.reads).toBe(4);
  });

test("a lost mutation response reconciles the saved collection flag", async ({
  page,
  context,
  app,
}) => {
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#crawls");
  const toggle = page.getByRole("switch", { name: "ハイファイ堂の収集" });
  await page.route("**/api/admin/crawls/control", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(page.getByRole("alert")).toContainText("Failed to fetch");
  expect(app.state.crawls.pausedShops.has("hifido")).toBe(true);
  expect(app.state.crawls.actions).toEqual([{ shopKey: "hifido", action: "pause" }]);
});

test("failed refresh makes collection flags unknown until a successful read", async ({
  page,
  context,
  app,
}) => {
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#crawls");
  const toggle = page.getByRole("switch", { name: "ハイファイ堂の収集" });
  await expect(toggle).toBeChecked();
  await page.route("**/api/admin/crawls", (route) => route.abort("failed"));
  await toggle.click();
  await expect(page.getByRole("alert").filter({ hasText: "最新の収集設定" })).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(0);
  for (const button of await page.getByRole("button", { name: "途中から再実行" }).all())
    await expect(button).toBeDisabled();
  await page.unroute("**/api/admin/crawls");
  await page.getByRole("button", { name: "状態を再読み込み" }).click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
});

test("unavailable shop status is unknown and deployment-disabled shops cannot be enabled", async ({
  page,
  context,
  app,
}) => {
  await context.setExtraHTTPHeaders(await app.headers());
  await page.route("**/api/admin/crawls", async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as AdminCrawlOverview;
    data.items[0].control = null;
    data.items[0].error = "実行状態を取得できません。再読み込みしてください。";
    data.items[1].enabled = false;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/#crawls");
  const panel = page.getByRole("region", { name: "ショップ別クロール管理" });
  await expect(panel).toContainText("状態不明");
  await expect(panel.getByRole("switch", { name: "ハイファイ堂の収集" })).toHaveCount(0);
  const disabled = panel.getByRole("switch", { name: "eイヤホンの収集" });
  await expect(disabled).not.toBeChecked();
  await expect(disabled).toBeDisabled();
  expect(app.state.crawls.actions).toEqual([]);
});
