import { test, expect } from "./fixtures.js";

for (const conflict of [false, true])
  test(`bulk correction ${conflict ? "blocks stale targets" : "reviews only selected targets and retries a lost response"}`, async ({
    page,
    context,
    app,
  }) => {
    app.state.bulk.enabled = true;
    app.state.bulk.conflict = conflict;
    app.state.bulk.loseResponse = !conflict;
    await context.setExtraHTTPHeaders(await app.headers());
    await page.goto("/#listings");
    await page.getByRole("checkbox", { name: "商品 #21 を選択" }).check();
    await page.getByRole("button", { name: "選択した1件を一括修正" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("変更する項目").selectOption("model");
    await dialog.getByLabel("変更後の型番").fill("D-999");
    await dialog.getByRole("button", { name: "対象と差分を確認" }).click();
    await expect(dialog.getByRole("table").first()).toContainText("D-999");
    await expect(dialog).not.toContainText("選択しない商品");
    expect(app.state.writes.listing).toBe(0);
    if (conflict) {
      await expect(dialog).toContainText("別の変更が入りました");
      await expect(dialog.getByRole("button", { name: "0件に変更を適用" })).toBeDisabled();
    } else {
      await dialog.getByRole("button", { name: "1件に変更を適用" }).click();
      await expect(dialog).toContainText("更新結果を確認できません。再試行してください。");
      await dialog.getByRole("button", { name: "残りを再開・失敗を再試行" }).click();
      await expect(dialog).toContainText("適用済み 1件");
      expect(app.state.listing.model).toBe("D-999");
      expect(app.state.writes.listing).toBe(1);
      expect(app.state.bulk.calls).toHaveLength(2);
      expect(app.state.bulk.calls[0]).toBe(app.state.bulk.calls[1]);
    }
  });

test("bulk selection is cleared by a new search", async ({ page, context, app }) => {
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#listings");
  await page.getByRole("checkbox", { name: "商品 #21 を選択" }).check();
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "商品 #21 を選択" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "選択した0件を一括修正" })).toBeDisabled();
});
