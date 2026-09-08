import { test, expect } from "./fixtures.js";
import type {
  AdminQualityOverview,
  AdminQualityReportPage,
  AdminQualityCandidatePage,
} from "../../src/api/admin-listing-contracts.js";
const at = "2020-01-01T00:00:00.000Z";
const overview: AdminQualityOverview = {
  observedAt: at,
  issues: [
    {
      shopKey: "audiounion",
      shopName: "オーディオユニオン",
      kind: "manufacturer",
      count: 12,
      total: 100,
      severity: "critical",
      snapshotAt: at,
    },
  ],
  snapshots: [
    { shopKey: "audiounion", shopName: "オーディオユニオン", snapshotAt: at, total: 100 },
    { shopKey: "hifido", shopName: "ハイファイ堂", snapshotAt: at, total: 10 },
  ],
  missingShops: [{ shopKey: "test-missing", shopName: "未集計ショップ" }],
};
const reports: AdminQualityReportPage = {
  observedAt: at,
  items: [
    {
      targetKey: "listing:21",
      reason: "wrong_model",
      openCount: 2,
      reportCount: 5,
      recurrenceCount: 3,
      updatedAt: at,
      reportId: 901,
      listingId: 21,
      productKey: "listing:21",
      shopKey: "audiounion",
      manufacturer: "LUXMAN",
      model: "D-1000",
      relatedOfferCount: null,
      relatedAt: null,
    },
  ],
  nextBefore: [3, 2, at, "listing:21", "wrong_model"],
};
const candidates: AdminQualityCandidatePage = {
  observedAt: at,
  items: [
    {
      id: 41,
      manufacturerId: "luxman",
      manufacturer: "LUXMAN",
      model: "D-1000",
      listingCount: 7,
      shopCount: 2,
      priorityScore: 50,
      updatedAt: at,
    },
  ],
  nextBefore: [50, at, 41],
};

test("quality loads lazily, shows scope and unknowns, and explicitly advances sparse sample windows", async ({
  page,
  context,
  app,
}) => {
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/admin/quality", (route) => {
    const input = route.request().postDataJSON();
    calls.push(input);
    if (input.action === "overview") return route.fulfill({ json: overview });
    if (input.action === "reports")
      return route.fulfill({
        json: input.before ? { ...reports, items: [], nextBefore: null } : reports,
      });
    if (input.action === "candidates")
      return route.fulfill({
        json: input.before ? { ...candidates, items: [], nextBefore: null } : candidates,
      });
    return route.fulfill({
      json: {
        observedAt: at,
        shopKey: input.shopKey,
        kind: input.kind,
        afterId: input.afterId,
        nextAfterId: input.afterId ? 777 : 200,
        scanned: input.afterId ? 1 : 200,
        hasMore: !input.afterId,
        items: input.afterId
          ? [
              {
                id: 777,
                title: "判定待ちの D-1000",
                manufacturer: "",
                model: "D-1000",
                categoryId: "unclassified",
              },
            ]
          : [],
      },
    });
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#listings");
  await expect(page.getByRole("heading", { name: "登録商品", exact: true })).toBeVisible();
  expect(calls).toHaveLength(0);
  await page
    .getByRole("navigation", { name: "管理メニュー" })
    .getByRole("link", { name: "品質点検", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "優先度付き品質点検", exact: true });
  const reportPanel = panel.getByRole("region", { name: "優先する誤り報告" });
  await expect(reportPanel).toContainText("3件");
  await expect(reportPanel.getByRole("cell", { name: "不明", exact: true })).toBeVisible();
  await expect(reportPanel.getByRole("link", { name: "報告 #901 を確認" })).toHaveAttribute(
    "href",
    "/?reportId=901#reports",
  );
  await expect(panel.getByRole("link", { name: "候補を確認", exact: true })).toHaveAttribute(
    "href",
    "/?q=D-1000&manufacturerId=luxman#candidates",
  );
  await expect(panel).toContainText("24時間以上前の集計");
  await panel.getByText("全ショップの集計日時と対象範囲", { exact: true }).click();
  await expect(panel).toContainText("ハイファイ堂: 10件");
  await expect(panel).toContainText("未集計ショップ: 未集計・品質不明");
  await panel.getByRole("combobox", { name: "課題の並び順" }).selectOption("count");
  expect(calls).toHaveLength(3);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await reportPanel
      .locator("td")
      .filter({ hasText: /^3件$/ })
      .evaluate((cell) => getComputedStyle(cell, "::before").content),
  ).toContain("補正後の再報告");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await panel.getByRole("button", { name: "該当商品を確認", exact: true }).click();
  const sample = panel.getByRole("region", { name: "課題の商品サンプル" });
  await expect(sample).toContainText("続きの範囲を確認できます");
  await sample.getByRole("button", { name: "次の商品範囲を確認" }).click();
  await expect(sample).toContainText("#777 判定待ちの D-1000");
  expect(calls.at(-1)).toEqual({
    action: "samples",
    shopKey: "audiounion",
    kind: "manufacturer",
    afterId: 200,
  });
  await expect(sample.getByRole("button", { name: "次の商品範囲を確認" })).toBeDisabled();
  await reportPanel.getByRole("button", { name: "次の報告グループ" }).click();
  await expect(reportPanel.getByRole("button", { name: "次の報告グループ" })).toBeDisabled();
  expect(calls.at(-1)).toEqual({ action: "reports", before: reports.nextBefore });
  await panel.getByRole("button", { name: "次の優先候補" }).click();
  await expect(panel.getByRole("button", { name: "次の優先候補" })).toBeDisabled();
  expect(calls.at(-1)).toEqual({ action: "candidates", before: candidates.nextBefore });
  const count = calls.length;
  await page.clock.install();
  await page.clock.fastForward(120_000);
  expect(calls).toHaveLength(count);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
});

test("quality refresh retains previous timestamped data when one source fails", async ({
  page,
  context,
  app,
}) => {
  let fail = false;
  await page.route("**/api/admin/quality", (route) => {
    const input = route.request().postDataJSON();
    if (input.action === "overview" && fail)
      return route.fulfill({ status: 503, json: { error: "集計に接続できません" } });
    return route.fulfill({
      json:
        input.action === "overview" ? overview : input.action === "reports" ? reports : candidates,
    });
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#quality");
  const refresh = page.getByRole("button", { name: "点検情報を再読み込み" });
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole("region", { name: "ショップ別の品質課題" })).toContainText(
    "12件 / 100件",
  );
  fail = true;
  await refresh.click();
  await expect(page.getByRole("alert")).toContainText("ショップ集計を取得できません");
  await expect(page.getByRole("region", { name: "ショップ別の品質課題" })).toContainText(
    "12件 / 100件",
  );
  await expect(page.getByRole("link", { name: "報告 #901 を確認" })).toBeVisible();
});

test("a priority report link loads the exact report without querying the broad queue and can clear its scope", async ({
  page,
  context,
  app,
}) => {
  const reads: Record<string, unknown>[] = [];
  let queueReads = 0;
  await page.route("**/api/admin/correction-reports?*", (route) => {
    queueReads++;
    return route.fulfill({ json: { items: [], hasMore: false, nextBeforeId: null } });
  });
  await page.route("**/api/admin/quality", (route) => {
    reads.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        items: [
          {
            id: 901,
            productKey: "listing:21",
            listingProductId: 21,
            reason: "wrong_model",
            explanation: "型番を確認してください",
            snapshot: {
              manufacturer: "LUXMAN",
              model: "D-1000",
              shopKey: "audiounion",
              category: "AMP",
            },
            status: "open",
            resolutionNote: "",
            createdAt: at,
            updatedAt: at,
            resolvedAt: null,
          },
        ],
        hasMore: false,
        nextBeforeId: null,
      },
    });
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/?reportId=901#reports");
  await expect(page.getByRole("row", { name: /#901/ })).toContainText("型番を確認してください");
  expect(reads).toEqual([{ action: "report", id: 901 }]);
  expect(queueReads).toBe(0);
  await page.getByRole("button", { name: "報告IDの絞り込みを解除" }).click();
  await expect(page.getByRole("status")).toContainText("該当する報告はありません");
  expect(queueReads).toBe(1);
  expect(new URL(page.url()).searchParams.has("reportId")).toBe(false);
});
