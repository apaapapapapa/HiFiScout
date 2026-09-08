import { test, expect } from "./fixtures.js";

test("observing a successful retry invalidates previously loaded catalog and replay views", async ({
  page,
  context,
  app,
}) => {
  const id = crypto.randomUUID();
  app.state.jobs.set(id, {
    id,
    kind: "csv",
    label: "再試行.csv",
    status: "failed",
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
    total: 1,
    uploaded: 1,
    processed: 1,
    failed: 1,
    error: "",
    expiresAt: "2026-09-15T00:00:00Z",
    detailsAvailable: true,
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#jobs");
  await expect(page.getByRole("region", { name: "バックグラウンド処理一覧" })).toContainText(
    "失敗 1件",
  );
  const nav = page.getByRole("navigation", { name: "管理メニュー" });
  await nav.getByRole("link", { name: "製品カタログ", exact: true }).click();
  await expect(page.getByRole("button", { name: "LUXMAN D-1000", exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "出品条件の再処理", exact: true }).click();
  await expect(page.getByRole("region", { name: "出品条件の再処理・充足率" })).toContainText(
    "再処理できます",
  );
  await nav.getByRole("link", { name: "バックグラウンド処理", exact: true }).click();
  app.state.catalog.canonicalName = "再試行後のカタログ";
  app.state.replay.scannedCount = 550;
  app.state.replay.stepCalls = 1;
  const job = app.state.jobs.get(id)!;
  job.failed = 0;
  job.status = "completed";
  await page.getByRole("button", { name: "進捗を再読み込み" }).click();
  await expect(page.getByRole("cell", { name: /^完了/u })).toBeVisible();
  await nav.getByRole("link", { name: "製品カタログ", exact: true }).click();
  await expect(page.getByRole("button", { name: "再試行後のカタログ", exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "出品条件の再処理", exact: true }).click();
  await expect(page.getByRole("region", { name: "出品条件の再処理・充足率" })).toContainText(
    "再処理は完了しています",
  );
});

test("saved jobs expose pause, resume and failed-only retry without automatic polling", async ({
  page,
  context,
  app,
}) => {
  const id = crypto.randomUUID();
  app.state.jobs.set(id, {
    id,
    kind: "csv",
    label: "編集.csv",
    status: "running",
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
    total: 100,
    uploaded: 100,
    processed: 5,
    failed: 0,
    error: "",
    expiresAt: "2026-09-15T00:00:00Z",
    detailsAvailable: true,
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#jobs");
  const panel = page.getByRole("region", { name: "バックグラウンド処理一覧" });
  await expect(panel).toContainText("処理済み 5 / 100件");
  await panel.getByRole("button", { name: "一時停止", exact: true }).click();
  await expect(panel.getByRole("button", { name: "一時停止", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "続きから再開" }).click();
  await expect(panel).toContainText("実行待ち");
  const job = app.state.jobs.get(id)!;
  job.status = "failed";
  job.processed = 100;
  job.failed = 2;
  await panel.getByRole("button", { name: "進捗を再読み込み" }).click();
  await panel.getByRole("button", { name: "結果を見る" }).click();
  await panel.getByRole("checkbox", { name: "失敗した対象のみ表示" }).check();
  await expect
    .poll(() => app.state.jobCommands.some((c) => c.action === "get" && c.failedOnly))
    .toBeTruthy();
  await panel.getByRole("button", { name: "失敗した対象だけ再試行" }).click();
  await expect(panel).toContainText("実行待ち");
  expect(
    app.state.jobCommands
      .filter((c) => ["pause", "resume", "retry"].includes(c.action))
      .map((c) => c.action),
  ).toEqual(["pause", "resume", "retry"]);
  const calls = app.state.jobCommands.length;
  await page.clock.install();
  await page.clock.fastForward(120_000);
  expect(app.state.jobCommands.length).toBe(calls);
});

test("a fully uploaded job can start after navigation and cancellation confirms retained edits", async ({
  page,
  context,
  app,
}) => {
  const id = crypto.randomUUID();
  app.state.jobs.set(id, {
    id,
    kind: "csv",
    label: "送信済み.csv",
    status: "uploading",
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
    total: 1,
    uploaded: 1,
    processed: 0,
    failed: 0,
    error: "",
    expiresAt: "2026-09-15T00:00:00Z",
    detailsAvailable: true,
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#jobs");
  await page.getByRole("button", { name: "送信済みの処理を開始" }).click();
  await expect(page.getByRole("cell", { name: /^実行待ち/u })).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("適用済みの変更は残ります");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "中止", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("適用済みの変更は保持");
  expect(app.state.jobs.get(id)?.status).toBe("cancelled");
});
