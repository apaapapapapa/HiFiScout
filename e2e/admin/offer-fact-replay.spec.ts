import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const replay = (page: Page) => page.getByRole("region", { name: "出品条件の再処理・充足率" });

async function startAll(page: Page) {
  page.once("dialog", (dialog) => dialog.accept());
  await replay(page).getByRole("button", { name: "全商品を再処理", exact: true }).click();
}

test("all-product replay confirms submission and shows durable progress after navigation", async ({
  page,
  context,
  app,
}) => {
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#maintenance");
  await expect(replay(page).getByRole("status")).toContainText("再処理できます");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("掲載終了を含む");
    await dialog.dismiss();
  });
  await replay(page).getByRole("button", { name: "全商品を再処理", exact: true }).click();
  expect(app.state.jobCommands).toEqual([]);
  await startAll(page);
  await expect(replay(page).getByRole("status")).toContainText("画面を閉じても処理は続きます");
  expect(app.state.jobCommands.map((command) => command.action)).toEqual(["create", "start"]);
  expect(app.state.replay.stepCalls).toBe(0);
  const job = [...app.state.jobs.values()][0];
  await page.goto(`/?jobId=${job.id}#jobs`);
  await expect(page.getByRole("region", { name: "バックグラウンド処理一覧" })).toContainText(
    "実行待ち",
  );
  job.processed = 550;
  job.status = "completed";
  await page.getByRole("button", { name: "進捗を再読み込み" }).click();
  await expect(page.getByRole("region", { name: "バックグラウンド処理一覧" })).toContainText(
    "処理済み 550件",
  );
  await expect(page.getByRole("cell", { name: /^完了/u })).toBeVisible();
  expect(app.state.replay.stepCalls).toBe(0);
});

test("a lost start response reuses the same background job", async ({ page, context, app }) => {
  let interrupted = false;
  await page.route("**/api/admin/jobs", async (route) => {
    if (route.request().postDataJSON().action !== "start" || interrupted) return route.continue();
    interrupted = true;
    await route.fetch();
    return route.fulfill({ status: 503, json: { error: "interrupted" } });
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#maintenance");
  await expect(replay(page).getByRole("status")).toContainText("再処理できます");
  await startAll(page);
  await expect(replay(page).getByRole("status")).toContainText("受付を確認できませんでした");
  await startAll(page);
  await expect(replay(page).getByRole("status")).toContainText("画面を閉じても処理は続きます");
  expect(app.state.jobs.size).toBe(1);
  const ids = app.state.jobCommands.filter((c) => c.action === "create").map((c) => c.id);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect(app.state.replay.stepCalls).toBe(0);
});

for (const [name, steps] of [
  ["最大25件を再処理", 1],
  ["最大500件を再処理", 20],
] as const) {
  test(`${name} retains its request limit`, async ({ page, context, app }) => {
    await context.setExtraHTTPHeaders(await app.headers());
    await page.goto("/#maintenance");
    await replay(page).getByRole("button", { name, exact: true }).click();
    await expect(replay(page).getByRole("status")).toHaveText(
      "進捗を保存しました。続きから再開できます。",
    );
    expect(app.state.replay.stepCalls).toBe(steps);
    expect(app.state.replay.scannedCount).toBe(25 * steps);
  });
}
