import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { product, offer } from "../tests/product-fixtures.js";

const first = product({ key: "c-1", model: "First", offer_count: 1, shop_count: 1 });
const second = product({ key: "c-2", model: "Second", offer_count: 1, shop_count: 1 });
const response = (items = [first, second]) => ({
  items,
  totalCount: items.length,
  totalPages: 1,
  hasMore: false,
  nextCursor: null as string | null,
});
type Results = ReturnType<typeof response>;

async function catalog(
  page: Page,
  options: {
    search?: (url: URL) => Results | Promise<Results>;
    detail?: (key: string) => { product: typeof first; offers: ReturnType<typeof offer>[] };
  } = {},
) {
  const seen = { searches: [] as URL[], details: [] as string[] };
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const url = new URL(route.request().url());
      let body: unknown;
      if (url.pathname === "/api/meta")
        body = {
          status: "healthy",
          categories: [],
          categoryFacets: [],
          manufacturers: ["LUXMAN"],
          shops: ["shop-a", "shop-b"].map((key) => ({
            key,
            name: key,
            enabled: true,
            intervalMinutes: 60,
            sync: null,
            health: null,
          })),
        };
      else if (url.pathname === "/api/product-search") {
        seen.searches.push(url);
        body = (await options.search?.(url)) ?? response();
      } else if (url.pathname.startsWith("/api/product-search/")) {
        const key = url.pathname.split("/").at(-1)!;
        seen.details.push(key);
        const item = key === second.key ? second : first;
        body = options.detail?.(key) ?? { product: item, offers: [offer()] };
      } else body = { suggestions: ["LUXMAN D-10X"] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    },
  );
  return seen;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });
});

test("two tabs serialize favorite additions and synchronize removals", async ({
  page,
  context,
  mount,
}) => {
  await catalog(page);
  await mount("frontend/public-app/Default");
  const other = await context.newPage();
  try {
    await catalog(other);
    await other.goto("/");
    await other.evaluate(() =>
      (window as unknown as { mount: (params: { story: string }) => Promise<void> }).mount({
        story: "frontend/public-app/Default",
      }),
    );
    await expect(other.locator("[data-key='c-2'] .fav")).toBeVisible();
    await Promise.all([
      page.locator("[data-key='c-1'] .fav").click(),
      other.locator("[data-key='c-2'] .fav").click(),
    ]);
    for (const tab of [page, other]) {
      await expect(tab.locator("[data-key='c-1'] .fav")).toHaveAttribute("aria-pressed", "true");
      await expect(tab.locator("[data-key='c-2'] .fav")).toHaveAttribute("aria-pressed", "true");
    }
    await page.locator("[data-key='c-1'] .fav").click();
    await expect(other.locator("[data-key='c-1'] .fav")).toHaveAttribute("aria-pressed", "false");
    await other.locator("#sort").selectOption("priceAsc");
    await expect(other.locator("#loading")).not.toHaveText("更新中");
    await expect
      .poll(() =>
        other.evaluate(() =>
          JSON.parse(localStorage.getItem("hifiscout:favorites") || "[]").map(
            (entry: { key: string }) => entry.key,
          ),
        ),
      )
      .toEqual(["c-2"]);
  } finally {
    await other.close();
  }
});

test("a hidden favorite can be refreshed without clearing its budget", async ({ page, mount }) => {
  const old = { ...first, lowest_price_yen: 120_000, highest_price_yen: 120_000 };
  const fresh = { ...first, lowest_price_yen: 90_000, highest_price_yen: 90_000 };
  const seen = await catalog(page, {
    search: () => response([old]),
    detail: () => ({ product: fresh, offers: [offer({ price_yen: 90_000 })] }),
  });
  await mount("frontend/public-app/Default");
  await page.locator(".fav").click();
  await expect(page.locator(".fav")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#maxPrice").fill("100000");
  await page.locator("#apply-filters").click();
  await page.locator("#favoritesOnly").check();
  await expect(page.locator("#products .card")).toHaveCount(0);
  expect(seen.details).toHaveLength(0);
  await page
    .getByRole("checkbox", { name: "絞り込みで非表示のお気に入りも再確認する（10件ずつ）" })
    .check();
  await expect(page.locator("#products .card")).toHaveCount(1);
  await expect(page.locator("#products")).toContainText("90,000");
  await expect(page.locator("#maxPrice")).toHaveValue("100000");
  await expect(page.getByRole("region", { name: "お気に入りの変化", exact: true })).toContainText(
    "初回の記録です",
  );
  expect(seen.details).toHaveLength(1);
});

test("detail Back and Forward preserve a later page, focus and scroll", async ({ page, mount }) => {
  const later = Array.from({ length: 18 }, (_, index) =>
    product({ key: `c-${300 + index}`, model: `Page three ${index}` }),
  );
  const seen = await catalog(page, {
    search: (url) => ({
      ...response(url.searchParams.get("offset") === "100" ? later : [first]),
      totalCount: 118,
      totalPages: 3,
    }),
    detail: (key) => ({
      product: later.find((item) => item.key === key) ?? first,
      offers: [offer()],
    }),
  });
  await mount("frontend/public-app/Default");
  await page.getByRole("button", { name: "3ページ目", exact: true }).click();
  const compare = page
    .locator("[data-key='c-308']")
    .getByRole("button", { name: "製品を比較", exact: true });
  await compare.scrollIntoViewIfNeeded();
  const comparisonScroll = await page.evaluate(() => scrollY);
  await compare.click();
  await page.goBack();
  await expect(compare).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(comparisonScroll);
  const title = page.locator("[data-key='c-308'] .product-title-link");
  await title.scrollIntoViewIfNeeded();
  const originScroll = await page.evaluate(() => scrollY);
  await title.click();
  await expect(page.locator("#offers-dialog")).toBeVisible();
  await page.locator("#offers-dialog .dialog-close").click();
  await expect(page.getByRole("button", { name: "3ページ目", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(title).toBeFocused();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(originScroll);
  await page.goForward();
  await expect(page.locator("#offers-dialog")).toBeVisible();
  await expect(page.locator("#offers-dialog")).toContainText("Page three 8");
  await page.goBack();
  await expect(title).toBeFocused();
  const detail = page.locator("[data-key='c-308'] .offers-button[data-offers]");
  await detail.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#offers-dialog")).toBeVisible();
  await page.locator("#offers-dialog .dialog-close").click();
  await expect(detail).toBeFocused();
  expect(seen.searches).toHaveLength(2);
});

test("Back cancels a pending debounced search", async ({ page, mount }) => {
  const seen = await catalog(page);
  await mount("frontend/public-app/Default");
  await expect(page.locator("#products .card")).toHaveCount(2);
  await page.locator("#sort").selectOption("priceAsc");
  await expect.poll(() => seen.searches.length).toBe(2);
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1_000);
  await page.locator("#q").fill("abandoned");
  await page.goBack();
  await page.clock.runFor(600);
  await expect(page.locator("#q")).toHaveValue("");
  await expect(page.locator("#sort")).toHaveValue("updated");
  expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  expect(seen.searches.some((url) => url.searchParams.get("q") === "abandoned")).toBe(false);
});

test("composition does not search or select suggestions until the text is committed", async ({
  page,
  mount,
}) => {
  const seen = await catalog(page);
  await mount("frontend/public-app/Default");
  const input = page.locator("#q");
  await input.fill("LUX");
  await expect(page.getByRole("option", { name: "LUXMAN D-10X", exact: true })).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1_000);
  await input.dispatchEvent("compositionstart");
  const count = seen.searches.length;
  await input.fill("ラックスマン");
  await input.dispatchEvent("keydown", { key: "ArrowDown", isComposing: true });
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await page.clock.runFor(600);
  await expect(input).toHaveValue("ラックスマン");
  expect(seen.searches).toHaveLength(count);
  await input.dispatchEvent("compositionend", { data: "ラックスマン" });
  // Resume before waiting on React's commit and its debounce. A paused clock can finish its
  // one advance before React schedules that timer, leaving an otherwise valid request frozen.
  await page.clock.resume();
  await expect(input).toHaveValue("ラックスマン");
  await expect.poll(() => seen.searches.at(-1)?.searchParams.get("q")).toBe("ラックスマン");
});

test("an expired page refreshes only the requested page and discards stale cursors", async ({
  page,
  mount,
}) => {
  let changed = false;
  const seen = await catalog(page, {
    search: (url) => ({
      ...response(
        url.searchParams.get("cursor") === "second"
          ? [second]
          : [{ ...first, model: changed ? "New price" : "Old price" }],
      ),
      totalCount: 51,
      totalPages: 2,
      hasMore: !url.searchParams.has("cursor"),
      nextCursor: url.searchParams.has("cursor") ? null : "second",
    }),
  });
  await mount("frontend/public-app/Default");
  await expect(page.locator("#products")).toContainText("Old price");
  await page.getByRole("button", { name: "2ページ目", exact: true }).click();
  await expect(page.locator("#products")).toContainText("Second");
  await page.clock.install();
  await page.clock.fastForward(31_000);
  changed = true;
  await page.getByRole("button", { name: "1ページ目", exact: true }).click();
  await expect(page.locator("#products")).toContainText("New price");
  expect(seen.searches).toHaveLength(3);
  expect(seen.searches.at(-1)?.searchParams.has("cursor")).toBe(false);
  expect(seen.searches.at(-1)?.searchParams.get("includeTotal")).toBe("true");
});

test("returning to a cached page fences an unfinished page request", async ({ page, mount }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = await catalog(page, {
    search: async (url) => {
      const later = url.searchParams.get("offset") === "50";
      if (later) await pending;
      return { ...response(later ? [second] : [first]), totalCount: 51, totalPages: 2 };
    },
  });
  await mount("frontend/public-app/Default");
  await expect(page.locator("#products")).toContainText("First");
  await page.locator("[data-view='cards']").click();
  await page.getByRole("button", { name: "2ページ目", exact: true }).click();
  await expect.poll(() => seen.searches.length).toBe(2);
  await page.goBack();
  await expect(page.locator("#loading")).toHaveText("");
  release();
  await expect(page.getByRole("button", { name: "1ページ目", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("#products")).toContainText("First");
  await expect(page.locator("#products")).not.toContainText("Second");
});

test("refreshing a vanished last page returns to the remaining page", async ({ page, mount }) => {
  let changed = false;
  const seen = await catalog(page, {
    search: (url) => {
      const later = url.searchParams.get("offset") === "50";
      return {
        ...response(later ? (changed ? [] : [second]) : [first]),
        totalCount: changed ? 1 : 51,
        totalPages: changed ? 1 : 2,
      };
    },
  });
  await mount("frontend/public-app/Default");
  await page.getByRole("button", { name: "2ページ目", exact: true }).click();
  await expect(page.locator("#products")).toContainText("Second");
  await page.locator("[data-key='c-2'] .product-title-link").click();
  await expect(page.locator("#offers-dialog")).toBeVisible();
  await page.clock.install();
  await page.clock.fastForward(31_000);
  changed = true;
  await page.goBack();
  await expect(page.locator("#products")).toContainText("First");
  expect(seen.searches).toHaveLength(4);
  expect(seen.searches.at(-1)?.searchParams.has("cursor")).toBe(false);
  expect(seen.searches.at(-1)?.searchParams.has("includeTotal")).toBe(false);
});
