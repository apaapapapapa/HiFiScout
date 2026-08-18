import { expect, test, type Page, type Route } from "@playwright/test";

interface CategoryFacet {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  classifiable: boolean;
  filterable: boolean;
  group: string | null;
  activeProductCount: number;
}

const categoryFacets: CategoryFacet[] = [
  {
    id: "amplifier",
    name: "アンプ",
    parentId: null,
    order: 1,
    classifiable: false,
    filterable: true,
    group: null,
    activeProductCount: 2,
  },
  {
    id: "integrated_amp",
    name: "　プリメインアンプ",
    parentId: "amplifier",
    order: 1,
    classifiable: true,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
  {
    id: "pre_amp",
    name: "　プリアンプ",
    parentId: "amplifier",
    order: 2,
    classifiable: true,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
  {
    id: "speaker",
    name: "スピーカー",
    parentId: null,
    order: 4,
    classifiable: false,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
  {
    id: "speaker_bookshelf",
    name: "　ブックシェルフ",
    parentId: "speaker",
    order: 1,
    classifiable: true,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
  {
    id: "accessories",
    name: "アクセサリー",
    parentId: null,
    order: 6,
    classifiable: false,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
  {
    id: "cable",
    name: "　ケーブル",
    parentId: "accessories",
    order: 1,
    classifiable: false,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
  {
    id: "cable_xlr",
    name: "　　XLRケーブル",
    parentId: "cable",
    order: 1,
    classifiable: true,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
];

async function mockCatalog(page: Page): Promise<URL[]> {
  await page.route("**/api/meta", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "healthy",
        shops: [],
        manufacturers: [],
        categories: [],
        categoryFacets,
      }),
    }),
  );
  const requests: URL[] = [];
  await page.route("**/api/product-search?**", (route: Route) => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], hasMore: false, nextCursor: null }),
    });
  });
  return requests;
}

function lastRequest(requests: URL[]): URL {
  const request = requests.at(-1);
  if (!request) throw new Error("Expected at least one product request");
  return request;
}

test("live metadata exposes the complete canonical taxonomy including zero-count parents", async ({
  request,
}) => {
  const response = await request.get("/api/meta");
  expect(response.ok()).toBeTruthy();
  const meta: { categoryFacets?: CategoryFacet[] } = await response.json();
  const facets = meta.categoryFacets ?? [];

  expect(facets.map((category) => category.id)).toEqual([
    "amplifier",
    "integrated_amp",
    "pre_amp",
    "power_amp",
    "headphone_amp",
    "av_amp",
    "digital",
    "dac",
    "network_player",
    "cd_sacd_player",
    "dap",
    "network_switch",
    "optical_isolator",
    "router",
    "music_server",
    "master_clock",
    "analog",
    "turntable",
    "tonearm",
    "cartridge",
    "phono_eq",
    "speaker",
    "speaker_bookshelf",
    "speaker_floorstanding",
    "center_speaker",
    "subwoofer",
    "active_speaker",
    "headphone_group",
    "headphone",
    "earphone",
    "accessories",
    "cable",
    "cable_xlr",
    "cable_rca",
    "cable_phono",
    "cable_usb",
    "cable_lan",
    "cable_digital",
    "cable_power",
    "cable_other",
    "rack",
    "power_accessory",
    "vacuum_tube",
    "other_accessory",
    "dj_dtm",
    "other",
  ]);
  expect(facets.find((category) => category.id === "amplifier")).toMatchObject({
    name: "アンプ",
    group: null,
    classifiable: false,
    filterable: true,
  });
  expect(facets.find((category) => category.id === "speaker")).toMatchObject({
    name: "スピーカー",
    group: null,
    classifiable: false,
    filterable: true,
  });
  expect(facets.find((category) => category.id === "pre_amp")).toMatchObject({
    name: "　プリアンプ",
    parentId: "amplifier",
  });
  expect(facets.find((category) => category.id === "cable_xlr")).toMatchObject({
    name: "　　XLRケーブル",
    parentId: "cable",
  });
  expect(
    facets.every(
      (category) =>
        Number.isInteger(category.activeProductCount) && category.activeProductCount >= 0,
    ),
  ).toBeTruthy();
});

test("category selection and browser URL state stay wired for parents and leaves", async ({
  page,
}) => {
  const requests = await mockCatalog(page);
  await page.goto("/");

  await page.locator("#category").selectOption("amplifier");
  await expect(page).toHaveURL(/category=amplifier/);
  expect(lastRequest(requests).searchParams.get("category")).toBe("amplifier");

  await page.locator("#category").selectOption("pre_amp");
  await expect(page).toHaveURL(/category=pre_amp/);
  expect(lastRequest(requests).searchParams.get("category")).toBe("pre_amp");

  await page.goto("/?category=speaker_bookshelf");
  await expect(page.locator("#category")).toHaveValue("speaker_bookshelf");
  expect(lastRequest(requests).searchParams.get("category")).toBe("speaker_bookshelf");

  await page.goto("/?category=cable_xlr");
  await expect(page.locator("#category")).toHaveValue("cable_xlr");
  expect(lastRequest(requests).searchParams.get("category")).toBe("cable_xlr");
});
