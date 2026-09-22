import { test, expect } from "../harness-fixtures.js";
import { product } from "../tests/product-fixtures.js";
import { PUBLIC_CONTENT_SECURITY_POLICY } from "../../src/http/security-headers.js";

for (const width of [390, 1280]) {
  test(`manufacturer reference photos preserve layout and attribution at ${width}px`, async ({
    page,
    mount,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": PUBLIC_CONTENT_SECURITY_POLICY,
        },
      });
    });
    await page.goto("/");
    const local = new URL("/hifiscout-mark.jpg", page.url()).href;
    await mount("frontend/catalog-photo/Preview", {
      product: product({
        photo: {
          imageUrl: local,
          sourceUrl: "https://www.luxman.co.jp/product/l-507z",
          credit: "LUXMAN",
        },
      }),
    });
    const photos = page.getByRole("img", { name: "LUXMAN D-10X のメーカー写真" });
    await expect(photos).toHaveCount(2);
    await expect
      .poll(() => photos.first().evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await expect(photos.first()).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(
      page.getByText("参考写真です。出品の色・付属品・状態は販売店でご確認ください。"),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "メーカー写真：LUXMAN" }).first()).toHaveAttribute(
      "href",
      "https://www.luxman.co.jp/product/l-507z",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("broken manufacturer photo keeps the model and source usable", async ({ page, mount }) => {
  await page.goto("/");
  const imageUrl = new URL("/broken-photo.jpg", page.url()).href;
  await page.route("**/broken-photo.jpg", (route) => route.fulfill({ status: 404, body: "" }));
  await mount("frontend/catalog-photo/Preview", {
    product: product({
      photo: { imageUrl, sourceUrl: "https://www.luxman.co.jp/", credit: "LUXMAN" },
    }),
  });
  await expect(page.getByText("写真を読み込めませんでした").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "D-10X", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "メーカー写真：LUXMAN" }).first()).toBeVisible();
});
