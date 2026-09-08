import { test, expect } from "./fixtures.js";

test("listing diagnosis shows retained evidence and an unconfirmed candidate without changing data", async ({
  page,
  context,
  app,
}) => {
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#listings");
  await page.getByRole("button", { name: "判定理由", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "判定理由を確認 · #21" });
  await expect(dialog.getByText("販売店から保存した情報", { exact: true })).toBeVisible();
  await expect(dialog.getByText("category_conflict", { exact: false })).toBeVisible();
  await expect(dialog.getByText("未確定候補:", { exact: false })).toContainText(
    "確定扱いにはしません",
  );
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(app.state.writes).toEqual({ catalog: 0, listing: 0 });
});
