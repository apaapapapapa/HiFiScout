import type { Page, Route } from "@playwright/test";
import { CATEGORIES, TAXONOMY_VERSION } from "../../src/catalog/categories.js";
import { expect, test } from "../fixtures/catalog-test.js";

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
    id: "AMP",
    name: "アンプ",
    parentId: null,
    order: 3,
    classifiable: false,
    filterable: true,
    group: null,
    activeProductCount: 2,
  },
  {
    id: "AMP.INTEGRATED",
    name: "　プリメインアンプ",
    parentId: "AMP",
    order: 1,
    classifiable: true,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
  {
    id: "AMP.PRE",
    name: "　プリアンプ",
    parentId: "AMP",
    order: 2,
    classifiable: true,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
  {
    id: "SPK",
    name: "スピーカー",
    parentId: null,
    order: 2,
    classifiable: false,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
  {
    id: "SPK.LOUDSPEAKER",
    name: "　スピーカー",
    parentId: "SPK",
    order: 1,
    classifiable: true,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
  {
    id: "CAB",
    name: "ケーブル",
    parentId: null,
    order: 8,
    classifiable: false,
    filterable: true,
    group: null,
    activeProductCount: 1,
  },
  {
    id: "CAB.ANALOG",
    name: "　Analog Interconnect",
    parentId: "CAB",
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
  const meta: { taxonomyVersion?: string; categoryFacets?: CategoryFacet[] } =
    await response.json();
  const facets = meta.categoryFacets ?? [];
  const expectedFacets = CATEGORIES.filter((category) => category.filterable).map((category) => ({
    id: category.id,
    name: `${category.parentId ? "　" : ""}${category.name}`,
    parentId: category.parentId,
    order: category.order,
    classifiable: category.classifiable,
    filterable: category.filterable,
    group: null,
  }));

  expect(meta.taxonomyVersion).toBe(TAXONOMY_VERSION);
  expect(
    facets.map(({ activeProductCount: _activeProductCount, ...category }) => category),
  ).toEqual(expectedFacets);
  expect(facets.find((category) => category.id === "AMP")).toMatchObject({
    name: "アンプ",
    group: null,
    classifiable: false,
    filterable: true,
  });
  expect(facets.find((category) => category.id === "AMP.PRE")).toMatchObject({
    name: "　プリアンプ",
    parentId: "AMP",
  });
  expect(facets.find((category) => category.id === "SRC.DISC")).toMatchObject({
    name: "　Disc Player / Disc Transport",
    parentId: "SRC",
  });
  expect(facets.find((category) => category.id === "ANA.HEADSHELL")).toMatchObject({
    name: "　ヘッドシェル",
    parentId: "ANA",
  });
  expect(facets.find((category) => category.id === "CAB.ANALOG")).toMatchObject({
    name: "　Analog Interconnect",
    parentId: "CAB",
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
  catalogPage,
}) => {
  const requests = await mockCatalog(page);
  await catalogPage.goto();

  await catalogPage.selectCategory("AMP");
  await expect(page).toHaveURL(/category=AMP/);
  expect(lastRequest(requests).searchParams.get("category")).toBe("AMP");

  await catalogPage.selectCategory("AMP.PRE");
  await expect(page).toHaveURL(/category=AMP\.PRE/);
  expect(lastRequest(requests).searchParams.get("category")).toBe("AMP.PRE");

  await catalogPage.goto("/?category=SPK.LOUDSPEAKER");
  await expect(catalogPage.category).toHaveValue("SPK.LOUDSPEAKER");
  expect(lastRequest(requests).searchParams.get("category")).toBe("SPK.LOUDSPEAKER");

  await catalogPage.goto("/?category=CAB.ANALOG");
  await expect(catalogPage.category).toHaveValue("CAB.ANALOG");
  expect(lastRequest(requests).searchParams.get("category")).toBe("CAB.ANALOG");
});
