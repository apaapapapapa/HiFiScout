import { test, expect } from "./fixtures.js";

test("operations loads lazily, shows unknowns and deferred deployment, and filters saved failures", async ({
  page,
  context,
  app,
}) => {
  let reads = 0;
  await page.route("**/api/admin/operations", (route) => {
    reads++;
    return route.fulfill({
      json: {
        observedAt: "2026-09-08T00:00:00Z",
        version: { id: "serving-version", tag: null, timestamp: null },
        unavailable: ["D1集計"],
        sql: null,
        runtime: {
          generatedAt: "2026-09-08T00:00:00Z",
          windowStart: "2026-09-07T00:00:00Z",
          windowEnd: "2026-09-08T00:00:00Z",
          deployment: {
            targetSha: "b".repeat(40),
            state: "deferred",
            updatedAt: "2026-09-08T00:00:00Z",
            runUrl: null,
          },
          workerStats: [
            {
              worker: "hifiscout",
              available: true,
              limitHit: false,
              statuses: [{ status: "exceededCpu", requests: 3, errors: 3 }],
            },
            { worker: "hifiscout-admin", available: false, limitHit: false, statuses: [] },
          ],
        },
      },
    });
  });
  const id = crypto.randomUUID();
  app.state.jobs.set(id, {
    id,
    kind: "csv",
    label: "失敗したCSV",
    status: "failed",
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
    total: 1,
    uploaded: 1,
    processed: 1,
    failed: 1,
    error: "変更の競合",
    expiresAt: "2026-09-15T00:00:00Z",
    detailsAvailable: true,
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#listings");
  await expect(page.getByRole("heading", { name: "登録商品", exact: true })).toBeVisible();
  expect(reads).toBe(0);
  await page
    .getByRole("navigation", { name: "管理メニュー" })
    .getByRole("link", { name: "負荷・稼働状況" })
    .click();
  const panel = page.getByRole("region", { name: "負荷・稼働状況", exact: true });
  await expect(panel).toContainText("serving-version");
  await expect(panel).toContainText("D1使用量制限により反映保留");
  await expect(panel).toContainText("読み取り 未集計");
  await expect(panel).toContainText("exceededCpu: 3件");
  const failures = panel.getByRole("region", { name: "ショップ・処理別の失敗" });
  await expect(failures).toContainText("取得先から503応答");
  await failures.getByRole("combobox", { name: "処理", exact: true }).selectOption("csv");
  await expect(failures).toContainText("変更の競合");
  await expect(failures).not.toContainText("取得先から503応答");
  expect(reads).toBe(1);
  await page.clock.install();
  await page.clock.fastForward(120_000);
  expect(reads).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBeTruthy();
});
