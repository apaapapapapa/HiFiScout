import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const path = "/api/admin/offer-facts/replay";
const replay = (page: Page) => page.getByRole("region", { name: "出品条件の再処理・充足率" });

async function startAll(page: Page) {
  page.once("dialog", (dialog) => dialog.accept());
  await replay(page).getByRole("button", { name: "全商品を再処理", exact: true }).click();
}

test("all-product replay requires confirmation and continues past 500 until server completion", async ({
  page,
  context,
  app,
}) => {
  const bodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(path) && request.method() === "POST")
      bodies.push(request.postDataJSON());
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#maintenance");
  await expect(replay(page).getByRole("status")).toContainText("再処理できます");
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("掲載終了を含む");
    await dialog.dismiss();
  });
  await replay(page).getByRole("button", { name: "全商品を再処理", exact: true }).click();
  expect(app.state.replay.stepCalls).toBe(0);

  await startAll(page);
  await expect(replay(page).getByRole("status")).toHaveText("再処理が完了しました。");
  await expect(replay(page)).toContainText("処理済み 550件 / うち掲載中 549件");
  expect(app.state.replay.stepCalls).toBe(22);
  expect(bodies).toEqual(Array.from({ length: 22 }, () => ({})));
  for (const name of ["最大25件を再処理", "最大500件を再処理", "全商品を再処理"])
    await expect(replay(page).getByRole("button", { name, exact: true })).toBeDisabled();
  await page.reload();
  await expect(replay(page).getByRole("status")).toHaveText("再処理は完了しています。");
  await expect(replay(page).getByRole("button", { name: "全商品を再処理" })).toBeDisabled();
  expect(app.state.replay.stepCalls).toBe(22);
});

test("stopping finishes only the in-flight step and all-product replay resumes after reload", async ({
  page,
  context,
  app,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "POST" || app.state.replay.stepCalls > 0)
      return route.continue();
    const response = await route.fetch();
    await held;
    return route.fulfill({ response });
  });
  try {
    await context.setExtraHTTPHeaders(await app.headers());
    await page.goto("/#maintenance");
    await startAll(page);
    await expect.poll(() => app.state.replay.stepCalls).toBe(1);
    for (const name of ["最大25件を再処理", "最大500件を再処理", "全商品を再処理"])
      await expect(replay(page).getByRole("button", { name, exact: true })).toBeDisabled();
    await replay(page).getByRole("button", { name: "この処理の後で停止" }).click();
    await expect(replay(page).getByRole("button", { name: "停止しています…" })).toBeDisabled();
    release();
    await expect(replay(page).getByRole("status")).toContainText("停止しました。");
    expect(app.state.replay.stepCalls).toBe(1);
    await page.reload();
    await expect(replay(page)).toContainText("処理済み 25件");
    expect(app.state.replay.stepCalls).toBe(1);
    await startAll(page);
    await expect(replay(page).getByRole("status")).toHaveText("再処理が完了しました。");
    expect(app.state.replay.stepCalls).toBe(22);
  } finally {
    release();
  }
});

test("an interrupted response stops all-product replay until the operator resumes saved progress", async ({
  page,
  context,
  app,
}) => {
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "POST" || app.state.replay.stepCalls > 0)
      return route.continue();
    // Commit through the real authenticated Worker, then lose its successful response.
    await route.fetch();
    return route.fulfill({ status: 503, json: { error: "interrupted" } });
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#maintenance");
  await startAll(page);
  await expect(replay(page).getByRole("status")).toContainText("中断しました");
  expect(app.state.replay).toEqual({ scannedCount: 25, totalCount: 550, stepCalls: 1 });
  await startAll(page);
  await expect(replay(page).getByRole("status")).toHaveText("再処理が完了しました。");
  expect(app.state.replay.stepCalls).toBe(22);
});

test("all-product replay stops after three consecutive responses without progress", async ({
  page,
  context,
  app,
}) => {
  let calls = 0;
  await page.route(`**${path}`, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    calls++;
    return route.fulfill({
      json: {
        ruleVersion: 1,
        scannedCount: 0,
        activeCount: 0,
        completedAt: null,
        coverage: { byShop: [], byCategory: [] },
      },
    });
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#maintenance");
  await startAll(page);
  await expect(replay(page).getByRole("status")).toContainText("進捗が更新されないため停止");
  await expect(replay(page).getByRole("button", { name: "全商品を再処理" })).toBeEnabled();
  expect(calls).toBe(3);
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
