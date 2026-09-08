import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import type { AdminModelFact, ModelFactWriteInput } from "../../src/api/contracts.js";

import { AdminConsolePage } from "../pages/admin-console-page.js";
import {
  adminCsvOriginal,
  adminCsvEditHeader,
  adminCsvEditRow,
} from "../../src/api/admin-csv-contracts.js";

const categories = [
  { id: "digital", name: "デジタル", classifiable: true, filterable: true },
  { id: "amp", name: "アンプ", classifiable: true, filterable: true },
];

const catalogProduct = {
  id: 11,
  manufacturerId: "luxman",
  canonicalModel: "D-1000",
  canonicalName: "LUXMAN D-1000",
  lifecycleStatus: "active",
  primaryCategoryId: "digital",
  matchedListingCount: 2,
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const listingProduct = {
  id: 21,
  shopKey: "audiounion",
  sourceId: "AU-21",
  sourceUrl: "https://example.test/products/21",
  isActive: true,
  stockStatus: "in_stock",
  priceYen: 980000,
  title: "LUXMAN D-1000 ブラック",
  rawManufacturer: "LUXMAN",
  manufacturer: "LUXMAN",
  manufacturerId: "luxman",
  canonicalManufacturerId: "luxman",
  rawModel: "D-1000",
  model: "D-1000",
  normalizedModel: "D1000",
  rawCategory: "デジタルプレーヤー",
  category: "デジタル",
  primaryCategoryId: "digital",
  classificationStatus: "classified",
  presentationColor: "ブラック",
  lastSeenAt: "2026-08-26T00:00:00.000Z",
  lastChangedAt: "2026-08-26T00:00:00.000Z",
  lastActivityAt: "2026-08-26T00:00:00.000Z",
  overrides: {
    manufacturerId: null,
    model: null,
    primaryCategoryId: null,
    presentationColor: null,
    updatedAt: null,
  },
};

async function mockAdminApi(page: Page): Promise<void> {
  let catalog = { ...catalogProduct };
  let listing = { ...listingProduct };

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Vite serves browser-safe source modules under /src/api/ in the fixture gallery.
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/admin/offer-facts/replay") return json(null);
    if (url.pathname === "/api/admin/work-counts")
      return json({
        reports: 0,
        candidates: 0,
        duplicateIdentities: [],
        nextDuplicateCursor: null,
      });

    if (url.pathname === "/api/meta")
      return json({
        categoryFacets: categories,
        presentationColors: [
          { id: "black", name: "ブラック", aliases: ["black", "黒"], codes: ["b"], order: 0 },
          { id: "silver", name: "シルバー", aliases: ["silver", "銀"], codes: ["s"], order: 1 },
          { id: "gold", name: "ゴールド", aliases: ["gold", "金"], codes: [], order: 2 },
        ],
        shops: [{ key: "audiounion", name: "Audio Union" }],
      });
    if (url.pathname === "/api/admin/manufacturers") {
      const query = (url.searchParams.get("q") || "").toLowerCase();
      return json({
        items: [
          { id: "accuphase", name: "Accuphase" },
          { id: "luxman", name: "LUXMAN" },
        ].filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query)),
        hasMore: false,
        nextAfterId: null,
      });
    }
    if (url.pathname === "/api/admin/knowledge-catalog/products" && request.method() === "GET") {
      if (url.searchParams.get("limit") === "1") {
        const afterId = Number(url.searchParams.get("afterId"));
        return json({
          items:
            afterId === 10
              ? [catalog]
              : afterId === 11
                ? [
                    {
                      ...catalog,
                      id: 12,
                      canonicalModel: "D-1000 Duplicate",
                      primaryCategoryId: "amp",
                      matchedListingCount: 4,
                    },
                  ]
                : [],
          nextAfterId: null,
        });
      }
      return json({ items: [catalog], nextAfterId: null });
    }
    if (
      /^\/api\/admin\/knowledge-catalog\/products\/\d+$/u.test(url.pathname) &&
      request.method() === "PATCH"
    ) {
      const input = request.postDataJSON() as {
        canonicalName?: string;
        primaryCategoryId?: string;
        lifecycleStatus?: "unknown" | "active" | "discontinued";
      };
      catalog = {
        ...catalog,
        canonicalName: input.canonicalName ?? catalog.canonicalName,
        primaryCategoryId: input.primaryCategoryId ?? catalog.primaryCategoryId,
        lifecycleStatus: input.lifecycleStatus ?? catalog.lifecycleStatus,
      };
      return json({ refreshedListings: 2 });
    }
    if (url.pathname === "/api/admin/knowledge-catalog/candidates") {
      return json({ items: [], nextAfterId: null, hasMore: false });
    }
    if (url.pathname === "/api/admin/knowledge-catalog/duplicates") {
      return json({ items: [], nextAfterKey: null, hasMore: false });
    }
    if (url.pathname === "/api/admin/knowledge-catalog-exports") return json({ job: null });
    if (url.pathname === "/api/admin/product-audit-exports") return json({ job: null });
    if (url.pathname === "/api/admin/listings" && request.method() === "GET") {
      return json({ items: [listing], nextAfterId: null, hasMore: false });
    }
    if (/^\/api\/admin\/listings\/\d+$/u.test(url.pathname) && request.method() === "PATCH") {
      const input = request.postDataJSON() as { presentationColor?: string };
      listing = {
        ...listing,
        presentationColor: input.presentationColor ?? listing.presentationColor,
      };
      return json({ listing, refreshedListings: 1 });
    }
    return json({ error: "unmocked_admin_api" }, 500);
  });
}

test.beforeEach(async ({ page }) => {
  await mockAdminApi(page);
});

test("admin exports expose every ZIP volume and retain the legacy CSV download", async ({
  page,
  mount,
}) => {
  const job = {
    id: "complete-archive",
    status: "ready",
    format: "complete",
    archivePartCount: 3,
    rowCount: 2500,
    byteCount: 123456,
    chunkCount: 401,
    error: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const formats: string[] = [];
  await page.route("**/api/admin/knowledge-catalog-exports", (route) => {
    if (route.request().method() === "POST") formats.push(route.request().postDataJSON().format);
    return route.fulfill({ json: route.request().method() === "POST" ? job : { job } });
  });
  await page.route("**/api/admin/product-audit-exports?scope=active", (route) =>
    route.fulfill({
      json: { job: { ...job, id: "legacy-csv", format: "csv", archivePartCount: undefined } },
    }),
  );
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.catalog.csvSummary.click();
  for (let part = 1; part <= 3; part += 1) {
    const link = component.getByRole("link", { name: `ZIP ${part} / 3`, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      "href",
      `/api/admin/knowledge-catalog-exports/complete-archive/download?part=${part}`,
    );
  }
  await expect(component.getByRole("link", { name: "CSVをダウンロード" })).toHaveAttribute(
    "href",
    "/api/admin/product-audit-exports/legacy-csv/download",
  );
  const card = component
    .locator(".export-job")
    .filter({ has: page.getByRole("heading", { name: "製品カタログ", exact: true }) });
  await card.getByRole("button", { name: "編集用CSVを生成" }).click();
  await expect.poll(() => formats).toEqual(["csv"]);
  await card.getByRole("button", { name: "全情報ZIPを生成" }).click();
  await expect.poll(() => formats).toEqual(["csv", "complete"]);
});

async function mockBackgroundUpload(page: Page, failure?: "outage" | "expired" | "redirect") {
  const state = {
    commands: [] as {
      action: string;
      id: string;
      offset?: number;
      items?: { operationId: string; change: { original: { id: number | null } } }[];
    }[],
    failed: false,
    job: null as {
      id: string;
      kind: string;
      total: number;
      uploaded: number;
      status: string;
    } | null,
  };
  await page.route("**/api/admin/jobs", async (route) => {
    const command = route.request().postDataJSON();
    state.commands.push(command);
    if (command.action === "create")
      state.job ||= {
        id: command.id,
        kind: command.kind,
        total: command.total,
        uploaded: 0,
        status: "uploading",
      };
    if (command.action === "append") {
      if (failure && !state.failed) {
        state.failed = true;
        return failure === "redirect"
          ? route.fulfill({ status: 302, headers: { location: "/cdn-cgi/access/login" } })
          : route.fulfill({
              status: failure === "expired" ? 403 : 503,
              json: { error: failure === "expired" ? "cloudflare_access_required" : "interrupted" },
            });
      }
      expect(command.offset).toBe(state.job!.uploaded);
      state.job!.uploaded += command.items.length;
    }
    if (command.action === "start") {
      expect(state.job!.uploaded).toBe(state.job!.total);
      state.job!.status = "queued";
    }
    return route.fulfill({ json: { job: state.job } });
  });
  await page.route("**/api/admin/csv-import/*", async (route) => {
    expect(route.request().url()).toMatch(/\/preview$/u);
    const input = route.request().postDataJSON();
    return route.fulfill({
      json: {
        items: input.changes.map(
          (change: { line: number; original: { id: number | null; kind: string } }) => ({
            line: change.line,
            id: change.original.id,
            kind: change.original.kind,
            message: "確認結果",
            status: "ready",
            revision: "revision",
          }),
        ),
      },
    });
  });
  return state;
}

test("CSV upload requires a reviewed diff and retries with the same job and operation IDs", async ({
  page,
  mount,
}) => {
  const original = adminCsvOriginal("listing", 21, {
    manufacturer_id: "luxman",
    model: "C10",
    primary_category_id: "AMP.PRE",
  });
  const csv =
    "listing_id," +
    adminCsvEditHeader("listing") +
    "\n21," +
    adminCsvEditRow(original).replace(/,"C10",/u, ',"C11",');
  const state = await mockBackgroundUpload(page, "outage");
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.catalog.csvSummary.click();
  const panel = component.getByRole("region", { name: "編集したCSVで一括登録・更新" });
  await panel
    .getByLabel("編集済みCSV（100MiB以内）")
    .setInputFiles({ name: "corrections.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(panel.getByRole("button", { name: "0件の更新を実行" })).toBeDisabled();
  await panel.getByRole("button", { name: "差分を確認" }).click();
  await expect(panel.getByRole("table")).toContainText("C10 → C11");
  expect(state.commands).toHaveLength(0);
  await panel.getByRole("button", { name: "1件の更新を実行" }).click();
  await expect(panel.getByRole("status")).toContainText("送信を中断しました");
  await panel.getByRole("button", { name: "送信を再開", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("画面を閉じても処理は続きます");
  const appends = state.commands.filter((command) => command.action === "append");
  expect(appends).toHaveLength(2);
  expect(appends[1]).toEqual(appends[0]);
  expect(new Set(state.commands.map((command) => command.id)).size).toBe(1);
  await expect(panel.getByRole("link", { name: "処理一覧で進捗と結果を確認" })).toHaveAttribute(
    "href",
    `/?jobId=${state.job!.id}#jobs`,
  );
  await expect(panel.getByRole("button", { name: "1件の更新を実行" })).toBeDisabled();
});

test("CSV background submission preserves both catalog creation and correction targets", async ({
  page,
  mount,
}) => {
  const original = adminCsvOriginal("catalog", 21, {
    manufacturer_id: "luxman",
    canonical_model: "C10",
    canonical_name: "LUXMAN C10",
    primary_category_id: "AMP.PRE",
    lifecycle_status: "unknown",
  });
  const csv =
    "catalog_product_id," +
    adminCsvEditHeader("catalog") +
    "\n21," +
    adminCsvEditRow(original).replace(/,"LUXMAN C10",/u, ',"Corrected C10",') +
    "\n,,luxman,C11,LUXMAN C11,AMP.PRE,unknown";
  const state = await mockBackgroundUpload(page);
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.catalog.csvSummary.click();
  const panel = component.getByRole("region", { name: "編集したCSVで一括登録・更新" });
  await panel
    .getByLabel("編集済みCSV（100MiB以内）")
    .setInputFiles({ name: "catalog.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await panel.getByRole("button", { name: "差分を確認" }).click();
  await expect(panel).toContainText("新規追加 1件 / 既存行の修正 1件");
  await expect(panel.getByRole("table")).toContainText("追加可能");
  expect(state.commands).toHaveLength(0);
  await panel.getByRole("button", { name: "2件の登録・更新を実行" }).click();
  await expect(panel.getByRole("status")).toContainText("処理を受け付けました");
  expect(
    state.commands
      .filter((command) => command.action === "append")
      .flatMap((command) => command.items!.map((item) => item.change.original.id)),
  ).toEqual([21, null]);
  expect(state.job!.status).toBe("queued");
});

for (const failure of ["expired", "redirect"] as const)
  test(`CSV upload resumes after an Access ${failure}`, async ({ page, mount }) => {
    const originals = [21, 22].map((id) =>
      adminCsvOriginal("listing", id, {
        manufacturer_id: "luxman",
        model: "C10",
        primary_category_id: "AMP.PRE",
      }),
    );
    const csv =
      "listing_id," +
      adminCsvEditHeader("listing") +
      "\n" +
      originals
        .map(
          (original) =>
            original.id + "," + adminCsvEditRow(original).replace(/,"C10",/u, ',"C11",'),
        )
        .join("\n");
    const state = await mockBackgroundUpload(page, failure);
    const component = await mount("frontend/admin-console/Default");
    const admin = new AdminConsolePage(component, page);
    await admin.catalog.csvSummary.click();
    const panel = component.getByRole("region", { name: "編集したCSVで一括登録・更新" });
    await panel
      .getByLabel("編集済みCSV（100MiB以内）")
      .setInputFiles({ name: "resume.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await panel.getByRole("button", { name: "差分を確認" }).click();
    await panel.getByRole("button", { name: "2件の更新を実行" }).click();
    await expect(panel.getByRole("alert")).toContainText("別タブでログイン");
    await expect(panel.getByRole("link", { name: "別タブでログインを確認" })).toHaveAttribute(
      "target",
      "_blank",
    );
    await panel.getByRole("button", { name: "送信を再開", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("処理を受け付けました");
    const attempts = state.commands.filter((command) => command.action === "append");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(panel.getByRole("alert")).toHaveCount(0);
  });

test("admin catalog screen uses the shared POM for search and edit flows", async ({
  page,
  mount,
}) => {
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);

  await expect(admin.heading).toBeVisible();
  await expect(admin.catalogTab).toHaveAttribute("aria-current", "page");
  await expect(admin.catalog.heading).toBeVisible();
  await expect(admin.catalog.duplicateHeading).not.toBeVisible();
  await expect(admin.catalog.candidateHeading).not.toBeVisible();
  await expect(admin.catalog.csvSummary).toBeVisible();
  await expect(admin.sectionLinks).toHaveCount(11);
  await expect(admin.sectionLinks.filter({ hasText: "ショップ別クロール" })).toBeVisible();

  await admin.catalog.searchFor("D-1000");
  await expect(admin.catalog.resultSummary).toContainText("検索「D-1000」");

  await admin.catalog.openEditor(11);
  await expect(admin.catalog.editDialog).toBeVisible();
  await admin.catalog.editName().fill("LUXMAN D-1000 Reference");
  const changes = admin.catalog.editDialog.getByRole("region", { name: "保存前の変更内容" });
  await expect(changes.getByRole("row", { name: /表示名/ })).toContainText(
    "LUXMAN D-1000 Reference",
  );
  await admin.catalog.saveButton().click();
  await expect(admin.catalog.catalogRow(11)).toContainText("LUXMAN D-1000 Reference");
  await expect(admin.catalog.status).toContainText("保存しました");
});

test("admin listings screen uses the shared POM for tab, search, and color edit flows", async ({
  page,
  mount,
}) => {
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);

  await admin.openListings();
  await expect(admin.listingsTab).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/#listings$/u);
  await expect(admin.listings.heading).toBeVisible();
  await expect(admin.sectionLinks).toHaveCount(11);

  await admin.listings.searchFor("D-1000");
  await expect(admin.listings.status).toContainText("検索条件を反映しました");

  await admin.listings.openEditor(21);
  await expect(admin.listings.editDialog).toBeVisible();
  await admin.listings.presentationColor().fill("ブラック/ゴールド");
  await expect(
    admin.listings.editDialog.getByRole("region", { name: "保存前の変更内容" }),
  ).toContainText("ブラック/ゴールド");
  await admin.listings.saveButton().click();
  await expect(admin.listings.listingRow(21)).toContainText("色: ブラック/ゴールド");
});

test("manufacturer lookup keeps the selected ID until a candidate is chosen and shows the saved diff", async ({
  page,
  mount,
}) => {
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.openListings();
  await admin.listings.openEditor(21);
  const picker = admin.listings.editDialog.getByRole("group", { name: "メーカー", exact: true });
  await picker.getByText("メーカー名から選ぶ", { exact: true }).click();
  await picker.getByRole("searchbox", { name: "メーカー候補を検索" }).fill("acc");
  await expect(picker.getByRole("listbox", { name: "メーカー候補", exact: true })).toContainText(
    "Accuphase",
  );
  await expect(picker.locator(".manufacturer-selection")).toContainText("LUXMAN");
  await expect(admin.listings.saveButton()).toBeDisabled();
  await picker
    .getByRole("listbox", { name: "メーカー候補", exact: true })
    .selectOption("accuphase");
  const diff = admin.listings.editDialog.getByRole("region", { name: "保存前の変更内容" });
  await expect(diff).toContainText("luxman");
  await expect(diff).toContainText("Accuphase (accuphase)");
  const request = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/admin/listings/21" && request.method() === "PATCH",
  );
  await admin.listings.saveButton().click();
  expect((await request).postDataJSON()).toEqual({ manufacturerId: "accuphase" });
});

test("manufacturer lookup retries without clearing selection, and unresolved is explicit in the preview", async ({
  page,
  mount,
}) => {
  let calls = 0;
  await page.route("**/api/admin/manufacturers?**", async (route) => {
    calls++;
    await route.fulfill({
      status: calls === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        calls === 1 ? { error: "temporary" } : { items: [], hasMore: false, nextAfterId: null },
      ),
    });
  });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.openListings();
  await admin.listings.openEditor(21);
  const picker = admin.listings.editDialog.getByRole("group", { name: "メーカー", exact: true });
  await picker.getByText("メーカー名から選ぶ", { exact: true }).click();
  await picker.getByRole("button", { name: "メーカー候補を再読み込み" }).click();
  await expect(picker).toContainText("一致する検証済みメーカーがありません");
  await expect(picker.locator(".manufacturer-selection")).toContainText("LUXMAN");
  await expect(admin.listings.saveButton()).toBeDisabled();
  await picker.getByRole("button", { name: "メーカー未解決にする", exact: true }).click();
  await expect(
    admin.listings.editDialog.getByRole("region", { name: "保存前の変更内容" }),
  ).toContainText("メーカー未解決として固定");
});

test("manufacturer choice and changes remain usable on a narrow admin dialog", async ({
  page,
  mount,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.openListings();
  await admin.listings.openEditor(21);
  await admin.listings.presentationColor().fill("silver");
  const diff = admin.listings.editDialog.getByRole("region", { name: "保存前の変更内容" });
  await expect(diff.getByRole("columnheader", { name: "現在", exact: true })).toBeVisible();
  await expect(diff.getByRole("cell", { name: "シルバー", exact: true })).toBeVisible();
  expect(
    await admin.listings.editDialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await diff.screenshot({
    path: testInfo.outputPath("admin-edit-preview-mobile.png"),
  });
});

test("an older manufacturer response cannot replace the current query", async ({ page, mount }) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const requested = new Promise<void>((resolve) => {
    received = resolve;
  });
  let sent!: () => void;
  const completed = new Promise<void>((resolve) => {
    sent = resolve;
  });
  await page.route("**/api/admin/manufacturers?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") !== "stale") return route.fallback();
    received();
    await hold;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [{ id: "old", name: "Old result" }],
        hasMore: false,
        nextAfterId: null,
      }),
    });
    sent();
  });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.openListings();
  await admin.listings.openEditor(21);
  const picker = admin.listings.editDialog.getByRole("group", { name: "メーカー", exact: true });
  await picker.getByText("メーカー名から選ぶ", { exact: true }).click();
  await picker.getByRole("searchbox", { name: "メーカー候補を検索" }).fill("stale");
  await requested;
  await picker.getByRole("searchbox", { name: "メーカー候補を検索" }).fill("acc");
  await expect(picker.getByRole("listbox", { name: "メーカー候補", exact: true })).toContainText(
    "Accuphase",
  );
  release();
  await completed;
  await expect(
    picker.getByRole("listbox", { name: "メーカー候補", exact: true }),
  ).not.toContainText("Old result");
  await expect(picker.locator(".manufacturer-selection")).toContainText("LUXMAN");
});

test("offer editor saves only changed decisions and can restore seller authority", async ({
  page,
  mount,
}) => {
  const decisions: Record<string, string> = {};
  const received: Record<string, string>[] = [];
  await page.route("**/api/admin/listings/21/offer-facts", async (route) => {
    if (route.request().method() === "PATCH") {
      const changes = route.request().postDataJSON() as Record<string, string>;
      received.push(changes);
      for (const [id, value] of Object.entries(changes)) {
        if (value === "inherit") delete decisions[id];
        else decisions[id] = value;
      }
    }
    await route.fulfill({
      json: {
        listingId: 21,
        title: listingProduct.title,
        conditionText: "リモコンあり",
        sourceUrl: listingProduct.sourceUrl,
        facts: [
          { factId: "remote_control", state: "present", source: "seller" },
          ...Object.entries(decisions).map(([factId, state]) => ({
            factId,
            state,
            source: "manual",
          })),
        ],
      },
    });
  });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.openListings();
  await page.getByRole("button", { name: "出品条件", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "出品の条件を修正" });
  await expect(editor.getByRole("button", { name: "出品条件を保存" })).toBeDisabled();
  await editor.getByLabel("リモコン", { exact: true }).selectOption("absent");
  await editor.getByRole("button", { name: "出品条件を保存" }).click();
  await expect(editor.getByRole("status")).toContainText("保存しました");
  expect(received).toEqual([{ remote_control: "absent" }]);
  await editor.getByLabel("リモコン", { exact: true }).selectOption("inherit");
  await editor.getByRole("button", { name: "出品条件を保存" }).click();
  await expect(editor.getByRole("status")).toContainText("保存しました");
  await expect(editor.getByRole("button", { name: "出品条件を保存" })).toBeDisabled();
  expect(received[1]).toEqual({ remote_control: "inherit" });
  await expect(editor.getByLabel("リモコン", { exact: true })).toHaveValue("inherit");
});

test("offer replay resumes server progress after an interrupted response", async ({
  page,
  mount,
}) => {
  let scanned = 0;
  let writes = 0;
  await page.route("**/api/admin/offer-facts/replay", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({});
      writes++;
      scanned += 25;
      if (writes === 1) return route.fulfill({ status: 503, json: { error: "interrupted" } });
    }
    return route.fulfill({
      json: {
        ruleVersion: 1,
        scannedCount: scanned,
        activeCount: scanned,
        completedAt: scanned >= 50 ? "2026-09-07T00:00:00Z" : null,
        coverage: {
          byShop: [{ key: "fixture", listings: scanned, appearance: scanned, maintenance: 0 }],
          byCategory: [],
        },
      },
    });
  });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.sectionLink("出品条件の再処理").click();
  const replay = page.getByRole("region", { name: "出品条件の再処理・充足率" });
  await replay.getByRole("button", { name: "最大25件を再処理", exact: true }).click();
  await expect(replay.getByRole("status")).toContainText("中断しました");
  await replay.getByRole("button", { name: "最大25件を再処理", exact: true }).click();
  await expect(replay.getByRole("status")).toContainText("完了しました");
  await expect(replay).toContainText("処理済み 50件");
  await expect(replay.getByRole("columnheader", { name: "外観", exact: true })).toBeVisible();
  await expect(replay.locator('td[data-label="外観"]')).toHaveText("50 / 50");
  await expect(replay.locator('td[data-label="整備・修理・改造歴"]')).toHaveText("0 / 50");
  await expect(replay.locator('td[data-label="動作"]')).toHaveText("未集計");
  expect(writes).toBe(2);
  await expect(
    replay.getByRole("button", { name: "最大500件を再処理", exact: true }),
  ).toBeDisabled();
});

test("model relations verify an explicitly selected product and retain optimistic versions", async ({
  page,
  mount,
}) => {
  const received: ModelFactWriteInput[] = [];
  let facts: AdminModelFact[] = [];
  await page.route("**/api/admin/knowledge-catalog/products?**", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    return route.fulfill({
      json: {
        items:
          query === "next-model"
            ? [{ ...catalogProduct, id: 12, canonicalName: "後継モデル" }]
            : [catalogProduct],
        nextAfterId: null,
      },
    });
  });
  await page.route("**/api/admin/knowledge-catalog/products/*/model-facts", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as ModelFactWriteInput;
      received.push(body);
      facts = [
        {
          id: "00000000-0000-4000-8000-000000000001",
          version: received.length,
          productId: 11,
          productName: catalogProduct.canonicalName,
          relatedProductName: "後継モデル",
          input: body.fact,
          reviewState: "verified",
          sourceUrl: "",
          verifiedAt: "2026-09-07T00:00:00Z",
          reviewDueAt: "2027-03-06T00:00:00Z",
        },
      ];
    }
    return route.fulfill({
      json: {
        product: { id: 11, name: catalogProduct.canonicalName, manufacturerId: "luxman" },
        facts,
        sources: [],
        audits: [],
      },
    });
  });
  await mount("frontend/admin-console/Default");
  await page
    .getByRole("button", { name: `${catalogProduct.canonicalName} の機種の関係`, exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "機種の関係・シリーズ", exact: true });
  await editor.getByLabel("関係先の機種を検索").fill("next-model");
  await editor.getByRole("button", { name: "機種を検索", exact: true }).click();
  await editor.getByRole("button", { name: "luxman / 後継モデル (#12)", exact: true }).click();
  await editor
    .getByLabel("確認内容・資料の説明")
    .fill("公式資料で後継機種として紹介されていることを確認しました。");
  await editor.getByLabel("確認状態", { exact: true }).selectOption("verified");
  await editor.getByRole("button", { name: "関係を保存", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("保存しました");
  expect(received[0].fact.relatedProductId).toBe(12);
  expect(received[0].id).toBeNull();
  expect(received[0].expectedVersion).toBeNull();
  await editor.getByRole("button", { name: "この関係を編集", exact: true }).click();
  await expect(editor.getByRole("button", { name: "関係を保存", exact: true })).toBeDisabled();
  await editor.getByRole("button", { name: "根拠を再確認して更新", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("保存しました");
  expect(received[1].expectedVersion).toBe(1);
  expect(received[1].reverify).toBe(true);
});

test("every catalog close control confirms before discarding dirty fields", async ({
  page,
  mount,
}) => {
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.catalog.openEditor(11);
  await admin.catalog.editName().fill("Unsaved name");
  page.once("dialog", (dialog) => dialog.dismiss());
  await admin.catalog.editDialog.getByRole("button", { name: "編集画面を閉じる" }).click();
  await expect(admin.catalog.editName()).toHaveValue("Unsaved name");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("Escape");
  await expect(admin.catalog.editDialog).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await admin.catalog.editDialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(admin.catalog.editDialog).toBeHidden();
  await expect(admin.catalog.catalogRow(11)).toContainText("LUXMAN D-1000");
});

test("shop filters use names and manual merge requires a full identity preview", async ({
  page,
  mount,
}) => {
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.openListings();
  await expect(page.locator("#listings-shop-key")).toHaveJSProperty("tagName", "SELECT");
  await page.locator("#listings-shop-key").selectOption({ label: "Audio Union" });
  await expect(page.locator("#listings-shop-key")).toHaveValue("audiounion");
  await admin.catalogTab.click();
  await admin.catalog.openEditor(11);
  const dialog = admin.catalog.editDialog;
  await dialog.getByText("詳細操作：別のカタログをこの製品へ統合", { exact: true }).click();
  await dialog.getByLabel("統合元 Catalog ID").fill("12");
  await expect(
    dialog.getByRole("button", { name: "このCatalogへ統合", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "統合内容を確認" }).click();
  await expect(dialog.locator(".merge-preview")).toContainText("残す製品（統合先）");
  await expect(dialog.locator(".merge-preview")).toContainText("D-1000 Duplicate");
  await expect(dialog.locator(".merge-preview")).toContainText("アンプ · 関連商品 4件");
  const confirmation = page.waitForEvent("dialog");
  const click = dialog.getByRole("button", { name: "このCatalogへ統合", exact: true }).click();
  const confirm = await confirmation;
  expect(confirm.message()).toContain("残す製品:");
  expect(confirm.message()).toContain("D-1000 (#11)");
  expect(confirm.message()).toContain("D-1000 Duplicate (#12)");
  expect(confirm.message()).toContain("デジタル · 関連商品 2件");
  await confirm.dismiss();
  await click;
  await expect(dialog).toBeVisible();
});

test("model specifications save explicit units and preserve unrecorded inputs", async ({
  page,
  mount,
}) => {
  await mockAdminApi(page);
  let saved: Record<string, unknown> | null = null;
  await page.route("**/api/admin/knowledge-catalog/products/11/specifications", async (route) => {
    if (route.request().method() === "PATCH")
      saved = { ...route.request().postDataJSON(), updatedAt: "2026-09-07T00:00:00Z" };
    await route.fulfill({ json: { productId: 11, specifications: saved } });
  });
  await mount("frontend/admin-console/Default");
  await page.getByRole("button", { name: "LUXMAN D-1000 の仕様を編集", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "LUXMAN D-1000 の比較用仕様" });
  await dialog.getByLabel("幅 (mm)", { exact: true }).fill("440");
  await dialog.getByLabel("重量 (kg)", { exact: true }).fill("12.5");
  await dialog.getByLabel("出典URL", { exact: true }).fill("https://example.test/manual");
  await expect(dialog.getByRole("region", { name: "保存前の変更内容" })).toContainText("440");
  await dialog.getByRole("button", { name: "仕様を保存", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("比較用の仕様を保存しました。");
  expect(saved).toMatchObject({
    widthMm: 440,
    heightMm: null,
    weightKg: 12.5,
    inputs: null,
    outputs: null,
  });
  await expect(dialog.getByRole("button", { name: "仕様を保存", exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: "test-results/admin-model-specifications-mobile.png",
    fullPage: true,
  });
});

test("task navigation loads only the requested workspace and retains search state", async ({
  page,
  mount,
}) => {
  const paths: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/admin/")) paths.push(path);
  });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await expect(admin.catalog.catalogRow(11)).toBeVisible();
  expect(paths.filter((path) => path !== "/api/admin/work-counts")).toEqual([
    "/api/admin/knowledge-catalog/products",
  ]);
  await admin.catalog.searchFor("D-1000");
  await expect(admin.catalog.resultSummary).toContainText("D-1000");
  await admin.sectionLink("重複の整理").click();
  await expect(admin.catalog.duplicateHeading).toBeVisible();
  await expect(admin.catalog.heading).not.toBeVisible();
  await expect.poll(() => paths.filter((path) => path.endsWith("/duplicates")).length).toBe(1);
  await admin.openCatalog();
  await expect(admin.catalog.query).toHaveValue("D-1000");
  expect(paths.filter((path) => path.endsWith("/products"))).toHaveLength(2);
  await page.goBack();
  await expect(admin.heading).toHaveText("重複の整理");
  await page.goForward();
  await expect(admin.catalog.query).toHaveValue("D-1000");
  expect(paths.some((path) => path.includes("exports") || path.endsWith("/candidates"))).toBe(
    false,
  );
});

test("task selector and sidebar show capped work counts without loading their lists", async ({
  page,
  mount,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/admin/work-counts", (route) =>
    route.fulfill({
      json: {
        reports: 99,
        candidates: 0,
        duplicateIdentities: Array.from({ length: 100 }, (_, i) => [
          `luxman M${i}`,
          `luxman M${i}`,
        ]).flat(),
        nextDuplicateCursor: null,
      },
    }),
  );
  const component = await mount("frontend/admin-console/Default");
  const select = component.getByRole("combobox", { name: "作業を選ぶ" });
  await expect(select.locator('option[value="reports"]')).toHaveText("誤り報告　99");
  await expect(select.locator('option[value="duplicates"]')).toHaveText("重複の整理　99+");
  await expect(select.locator('option[value="candidates"]')).toHaveText("未検証候補　0");
  await expect(select.locator('option[value="catalog"]')).toHaveText("製品カタログ");
  await select.selectOption("duplicates");
  await expect(component.locator(".admin-workspace-heading h1")).toHaveText("重複の整理");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(
    component.getByRole("link", { name: "重複の整理", exact: true }).locator(".admin-work-count"),
  ).toHaveText("99+");
});

test("count failures keep the task selector usable and never claim zero work", async ({
  page,
  mount,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/admin/work-counts", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  const component = await mount("frontend/admin-console/Default");
  const select = component.getByRole("combobox", { name: "作業を選ぶ" });
  for (const view of ["reports", "duplicates", "candidates"])
    await expect(select.locator(`option[value="${view}"]`)).toContainText("—");
  await select.selectOption("candidates");
  await expect(component.locator(".admin-workspace-heading h1")).toHaveText("未検証候補");
});

test("metadata failure offers a retry without leaving the workspace", async ({ page, mount }) => {
  let fail = true;
  await page.route("**/api/meta", (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } })
      : route.fallback(),
  );
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await expect(component.getByRole("alert")).toContainText("temporarily_unavailable");
  fail = false;
  await component.getByRole("button", { name: "もう一度読み込む" }).click();
  await expect(admin.catalog.catalogRow(11)).toBeVisible();
  await expect(component.getByRole("alert")).toHaveCount(0);
});

test("mobile task selection and listing editing fit the viewport", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await component.getByRole("combobox", { name: "作業を選ぶ" }).selectOption("listings");
  await expect(admin.listings.listingRow(21)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await admin.listings.openEditor(21);
  await expect(admin.listings.editDialog).toBeVisible();
  expect((await admin.listings.editDialog.boundingBox())?.width).toBeLessThanOrEqual(390);
  await admin.listings.presentationColor().fill("シルバー");
  await admin.listings.saveButton().click();
  await expect(admin.listings.listingRow(21)).toContainText("シルバー");
});

test("correction reports submit filters explicitly and retain the typed audit note", async ({
  page,
  mount,
}) => {
  let reads = 0;
  let appliedNote = "";
  const report = {
    id: 31,
    productKey: "c-11",
    listingProductId: null,
    reason: "wrong_model",
    explanation: "型番を確認してください。",
    snapshot: {
      manufacturer: "LUXMAN",
      model: "D-1000",
      category: "デジタル",
      shopKey: "audiounion",
    },
    status: "open",
    resolutionNote: "",
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    resolvedAt: null,
  };
  await page.route("**/api/admin/correction-reports**", (route) => {
    if (route.request().method() === "PATCH") {
      appliedNote = route.request().postDataJSON().note;
      report.status = "rejected";
      report.resolutionNote = appliedNote;
      return route.fulfill({ json: report });
    }
    reads += 1;
    return route.fulfill({ json: { items: [report], nextBeforeId: null, hasMore: false } });
  });
  await page.route("**/api/admin/work-counts", (route) =>
    route.fulfill({
      json: {
        reports: report.status === "rejected" ? 0 : 1,
        candidates: 0,
        duplicateIdentities: [],
        nextDuplicateCursor: null,
      },
    }),
  );
  const component = await mount("frontend/admin-console/Default");
  const admin = new AdminConsolePage(component, page);
  await admin.sectionLink("誤り報告").click();
  const reports = component.getByRole("region", { name: "情報の誤り報告" });
  const note = reports.getByRole("textbox", { name: "監査メモ" });
  const reportCount = admin.sectionLink("誤り報告").locator(".admin-work-count");
  await expect(reportCount).toHaveText("1");
  await expect(note).toBeVisible();
  expect(reads).toBe(1);
  await reports.getByRole("textbox", { name: "店舗ID" }).fill("audiounion");
  expect(reads).toBe(1);
  await reports.getByRole("button", { name: "絞り込む" }).click();
  await expect.poll(() => reads).toBe(2);
  await note.fill("販売店の型番と一致することを確認しました。");
  await expect(note).toHaveValue("販売店の型番と一致することを確認しました。");
  await reports.getByRole("button", { name: "却下", exact: true }).click();
  await expect.poll(() => appliedNote).toBe("販売店の型番と一致することを確認しました。");
  await expect(note).toHaveCount(0);
  await expect(reportCount).toHaveText("0");
});
