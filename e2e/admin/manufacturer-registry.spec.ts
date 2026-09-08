import { test, expect } from "./fixtures.js";
import type {
  AdminManufacturerEdit,
  AdminManufacturerPreview,
  AdminManufacturerRegistryDetail,
} from "../../src/api/admin-manufacturer-contracts.js";
import type { AdminExtractionResult } from "../../src/api/admin-listing-contracts.js";
const detail: AdminManufacturerRegistryDetail = {
  exists: true,
  profile: {
    manufacturerId: "luxman",
    canonicalName: "LUXMAN",
    nameJa: "ラックスマン",
    nameEn: "Luxman",
  },
  aliases: [
    {
      alias: "デモラボ",
      normalizedAlias: "デモラボ",
      shopKey: "audiounion",
      status: "rejected",
      source: "admin_alias_control",
    },
  ],
  history: [],
  observedAt: "2026-09-08T00:00:00Z",
};
const preview = (
  edit: AdminManufacturerEdit,
  afterId = 0,
): AdminManufacturerPreview<AdminExtractionResult> => ({
  before: detail,
  edit,
  aliasBefore: detail.aliases[0],
  revision: "a".repeat(64),
  scope: {
    shopKey: edit.alias?.shopKey ?? "",
    afterId,
    nextAfterId: afterId + 200,
    maxId: 500,
    scanned: 200,
    matched: 0,
    hasMore: afterId === 0,
  },
  collisions: [],
  samples: {
    observedAt: detail.observedAt,
    versions: { manufacturer: 12, model: 12, taxonomy: "3" },
    items: [],
  },
});

test("manufacturer edits require an explicit scoped preview, with bounded pagination and invalidation", async ({
  page,
  context,
  app,
}) => {
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/admin/manufacturer-registry", (route) => {
    const input = route.request().postDataJSON();
    calls.push(input);
    return route.fulfill({
      json: input.action === "get" ? detail : preview(input.edit, input.afterId),
    });
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/?manufacturerId=luxman#manufacturers");
  expect(calls).toHaveLength(0);
  await page.getByRole("button", { name: "メーカーを開く", exact: true }).click();
  await page.getByRole("button", { name: "この別名を編集", exact: true }).click();
  await page.getByRole("checkbox", { name: "この別名を有効にする" }).check();
  await page.getByRole("button", { name: "変更の影響を確認", exact: true }).click();
  const confirmation = page.getByRole("region", { name: "メーカー変更の確認" });
  await expect(confirmation).toContainText("全商品の影響件数ではありません");
  await expect(confirmation).toContainText("デモラボ / 無効");
  expect(calls[1].edit).toEqual({
    ...detail.profile,
    alias: { alias: "デモラボ", shopKey: "audiounion", enabled: true },
  });
  await page.getByRole("button", { name: "次の範囲を確認" }).click();
  await expect(page.getByRole("button", { name: "次の範囲を確認" })).toBeDisabled();
  expect(calls[2]).toMatchObject({ action: "preview", afterId: 200, maxId: 500 });
  await page.getByRole("textbox", { name: "正式名称", exact: true }).fill("Luxman Audio");
  await expect(confirmation).toHaveCount(0);
  expect(calls.filter((row) => row.action === "apply")).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "変更の影響を確認", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("lost apply responses lock the reviewed edit and resend the same operation before recovering job acceptance", async ({
  page,
  context,
  app,
}) => {
  const applies: Record<string, unknown>[] = [];
  let replayId = "";
  await page.route("**/api/admin/manufacturer-registry", (route) => {
    const input = route.request().postDataJSON();
    if (input.action === "get") return route.fulfill({ json: detail });
    if (input.action === "preview") return route.fulfill({ json: preview(input.edit) });
    if (input.action === "apply") {
      applies.push(input);
      if (applies.length === 1)
        return route.fulfill({ status: 503, json: { error: "通信に失敗しました。" } });
      return route.fulfill({
        json: {
          applied: true,
          operationId: input.operationId,
          replay: "pending",
          message: "辞書は保存済みです。再判定の受付を再試行してください。",
        },
      });
    }
    replayId = input.operationId;
    return route.fulfill({
      json: {
        applied: true,
        operationId: input.operationId,
        replay: "queued",
        message: "再判定を受け付けました。",
      },
    });
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/?manufacturerId=luxman#manufacturers");
  await page.getByRole("button", { name: "メーカーを開く", exact: true }).click();
  await page.getByRole("textbox", { name: "正式名称", exact: true }).fill("Luxman Audio");
  await page.getByRole("button", { name: "変更の影響を確認", exact: true }).click();
  await page.getByRole("button", { name: "この内容で保存して再判定" }).click();
  await expect(page.getByRole("button", { name: "同じ操作を再送" })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "正式名称", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "同じ操作を再送" }).click();
  await expect(page.getByRole("status")).toContainText("辞書は保存済み");
  expect(applies).toHaveLength(2);
  expect(applies[1]).toEqual(applies[0]);
  await page.getByRole("button", { name: "再判定の受付を再試行", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("再判定を受け付けました");
  expect(replayId).toBe(applies[0].operationId);
  await expect(page.getByRole("link", { name: "再判定の処理を開く" })).toHaveAttribute(
    "href",
    `/?jobId=${replayId}#jobs`,
  );
});
