import { test, expect } from "./fixtures.js";

for (const conflict of [false, true])
  test(`history restoration ${conflict ? "shows later-edit conflict" : "requires a diff review before applying"}`, async ({
    page,
    context,
    app,
  }) => {
    app.state.historyConflict = conflict;
    app.state.history.push({
      source: "editor",
      operationId: "00000000-0000-4000-8000-000000000001",
      kind: "listing",
      targetId: 21,
      before: { model: "D-999" },
      after: { model: "D-1000" },
      createdAt: "2026-08-26T00:00:00Z",
      status: "saved",
    });
    await context.setExtraHTTPHeaders(await app.headers());
    await page.goto("/#listings");
    await page.getByRole("button", { name: "変更履歴", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "変更履歴 · #21" });
    await dialog.getByRole("button", { name: "この値へ戻す" }).click();
    expect(app.state.writes.listing).toBe(0);
    if (conflict) {
      await expect(dialog.getByRole("status")).toContainText("後続の変更");
      await expect(dialog.getByRole("button", { name: "復元を実行" })).toHaveCount(0);
    } else {
      await expect(dialog.getByRole("heading", { name: "復元する差分" })).toBeVisible();
      await dialog.getByRole("button", { name: "復元を実行" }).click();
      await expect(dialog.getByRole("status")).toContainText("復元しました");
      expect(app.state.listing.model).toBe("D-999");
      expect(app.state.writes.listing).toBe(1);
    }
  });
