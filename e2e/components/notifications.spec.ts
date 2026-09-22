import { expect, test } from "../harness-fixtures.js";
import type { Page } from "@playwright/test";
import type { NotificationWatch } from "../../src/api/contracts.js";

async function setup(page: Page, permission: "granted" | "denied" = "granted") {
  await page.goto("/");
  await page.evaluate((permission) => {
    localStorage.clear();
    history.replaceState(null, "", "/");
    localStorage.setItem(
      "hifiscout:saved-searches:v1",
      JSON.stringify([
        {
          id: "saved-one",
          name: "LUXMANの候補",
          query: "q=LUXMAN&shop=hifido&maxPrice=150000",
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: { requestPermission: async () => permission },
    });
    Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
    const registration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => ({
          toJSON: () => ({
            endpoint: "https://web.push.apple.com/Qfixture",
            keys: { p256dh: "fixture", auth: "fixture" },
          }),
        }),
      },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async () => registration,
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
      },
    });
  }, permission);
  const state = {
    watches: [] as NotificationWatch[],
    requests: [] as string[],
    failDelete: false,
    query: "",
  };
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const reply = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path.startsWith("/api/notifications/")) {
        state.requests.push(`${method} ${path}`);
        if (path.endsWith("/config")) return reply({ publicKey: "B" + "A".repeat(86) });
        if (path.endsWith("/status"))
          return reply({
            registered: true,
            watches: state.watches,
            lastCheck: null,
            delayed: false,
            failed: 0,
          });
        if (path.endsWith("/watches") && method === "POST") {
          const input = route.request().postDataJSON() as NotificationWatch;
          state.query = input.query;
          state.watches = [{ ...input, createdAt: Date.now() }];
        }
        if (method === "DELETE") {
          if (state.failDelete) return reply({ error: "unavailable" }, 503);
          state.watches = [];
        }
        return reply({ ok: true });
      }
      if (path === "/api/meta")
        return reply({
          status: "healthy",
          shops: [],
          manufacturers: [],
          manufacturerFacets: [],
          categories: [],
          categoryFacets: [],
        });
      return reply({
        items: [],
        hasMore: false,
        nextCursor: null,
        totalCount: 0,
        totalPages: 0,
        suggestions: [],
      });
    },
  );
  return state;
}

test("opt-in sends the saved conditions and desired price, survives reload and cancels before deletion", async ({
  page,
  mount,
}) => {
  const state = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await mount("frontend/public-app/Default");
  await page.getByText("保存した検索 (1/20)", { exact: true }).click();
  await page.getByText("新着・値下げを通知", { exact: true }).click();
  expect(state.requests).toEqual([]);
  await page.getByLabel("希望価格（上限・円）").fill("120000");
  await page.getByRole("button", { name: "通知を有効にする", exact: true }).click();
  await expect(page.getByText("通知中", { exact: true })).toBeVisible();
  expect(new URLSearchParams(state.query).get("q")).toBe("LUXMAN");
  expect(new URLSearchParams(state.query).get("shop")).toBe("hifido");
  expect(new URLSearchParams(state.query).get("maxPrice")).toBe("120000");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("notification-mobile.png"),
    fullPage: true,
  });
  await mount("frontend/public-app/Default");
  const saved = page.locator("details.saved-searches");
  if ((await saved.getAttribute("open")) === null) await saved.locator(":scope > summary").click();
  await expect(page.getByText("通知中", { exact: true })).toBeVisible();
  state.failDelete = true;
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "LUXMANの候補を削除", exact: true }).click();
  await expect(page.getByText(/通知の解除を確認できないため/)).toBeVisible();
  await expect(page.getByRole("button", { name: "LUXMANの候補を削除", exact: true })).toBeVisible();
  state.failDelete = false;
  await page.getByRole("button", { name: "この端末の通知をすべて停止", exact: true }).click();
  await expect(
    page.getByText("この端末の通知をすべて停止しました。", { exact: true }),
  ).toBeVisible();
  expect(state.watches).toEqual([]);
  await page.getByRole("button", { name: "LUXMANの候補を削除", exact: true }).click();
  await expect(page.getByText("保存した検索 (0/20)", { exact: true })).toBeVisible();
});

test("permission denial leaves notification registration untouched and shows recovery guidance", async ({
  page,
  mount,
}) => {
  const state = await setup(page, "denied");
  await mount("frontend/public-app/Default");
  await page.getByText("保存した検索 (1/20)", { exact: true }).click();
  await page.getByText("新着・値下げを通知", { exact: true }).click();
  await page.getByRole("button", { name: "通知を有効にする", exact: true }).click();
  await expect(page.getByText(/通知が許可されていません/)).toBeVisible();
  expect(state.requests).toEqual([]);
});
