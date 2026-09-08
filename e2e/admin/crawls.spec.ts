import { test, expect } from "./fixtures.js";

test("shop controls show quiet hours, retained progress and pause/resume results", async ({
  page,
  context,
  app,
}) => {
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#crawls");
  const panel = page.getByRole("region", { name: "ショップ別クロール管理" });
  await expect(panel).toContainText("夜間の予定停止中");
  await expect(panel).toContainText("前回比 -10件");
  await expect(panel).toContainText("取得 10ページ");
  await expect(panel).toContainText("取得先から503応答");
  expect(app.state.crawls.reads).toBe(1);
  expect(app.state.crawls.actions).toEqual([]);
  await panel.getByRole("button", { name: "一時停止", exact: true }).click();
  await expect(panel.getByRole("button", { name: "途中から再実行" })).toBeDisabled();
  await panel.getByRole("button", { name: "再開", exact: true }).click();
  await expect(panel.getByRole("button", { name: "途中から再実行" })).toBeEnabled();
  expect(app.state.crawls.actions).toEqual(["pause", "resume"]);
  expect(app.state.crawls.reads).toBe(3);
});
