import test from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORY_CLASSIFICATION_METADATA_VERSION,
  normalizeCatalogProduct,
} from "../src/catalog/product-normalizer.js";
import { enrichProductCategories } from "../src/crawler/category-enricher.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { NormalizedCatalogProduct } from "../src/catalog/types.js";
import type { CategoryEnrichmentProductRow } from "../src/db/types.js";
import { detailFetchOptions, emptyCatalogDb, parsedProduct } from "./helpers/fixtures.js";

const plugin = getShopPlugin("fujiya-avic");
if (!plugin) throw new Error("fujiya-avic plugin missing");
const fujiyaAvicPlugin = plugin;

const DETAIL_HTML =
  '<html><head><meta name="description" content="Example EX-1 完全ワイヤレスイヤホンの中古商品です。"></head><body><h1>EX-1</h1></body></html>';

/**
 * The same product listed several times by one shop, which is how the observed splits arose:
 * Fujiya re-lists identical stock under separate source ids.
 */
function sameProductListedTimes(count: number): NormalizedCatalogProduct[] {
  return Array.from({ length: count }, (_, index) =>
    normalizeCatalogProduct(
      parsedProduct({
        sourceId: `dup-${index + 1}`,
        manufacturer: "Example",
        model: "EX-1",
        title: "Example EX-1",
        sourceUrl: `https://www.fujiya-avic.co.jp/shop/g/gex1-${index + 1}/`,
      }),
      fujiyaAvicPlugin.capabilities.catalog,
    ),
  );
}

/** The production adapter with a smaller detail budget, so a crawl exhausts it as it really does. */
function adapterWithDetailBudget(maxRequestsPerCrawl: number) {
  return {
    key: fujiyaAvicPlugin.key,
    capabilities: {
      ...fujiyaAvicPlugin.capabilities,
      catalog: {
        ...fujiyaAvicPlugin.capabilities.catalog,
        categoryPolicy: {
          ...fujiyaAvicPlugin.capabilities.catalog?.categoryPolicy,
          enrichment: { maxRequestsPerCrawl, cacheHours: 168 },
        },
      },
    },
  };
}

test("a detail budget smaller than the duplicate group still classifies every copy the same way", async () => {
  const products = sameProductListedTimes(3);
  for (const product of products) assert.equal(product.classificationStatus, "unclassified");

  const result = await enrichProductCategories({
    db: emptyCatalogDb(),
    adapter: adapterWithDetailBudget(1),
    products,
    existingRows: [],
    transport: {
      async fetchHtmlPage() {
        return DETAIL_HTML;
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-22T10:00:00Z"),
  });

  // The defect this pins: the budget used to be spent per listing in crawl order, so copies past
  // the cut-off stayed `other`/unclassified while their identical siblings became a real leaf.
  assert.deepEqual(
    result.products.map((product) => product.primaryCategoryId),
    ["btw_earphone", "btw_earphone", "btw_earphone"],
  );
  assert.deepEqual(
    result.products.map((product) => product.classificationStatus),
    ["classified", "classified", "classified"],
  );
  assert.equal(result.detailRequests, 1, "one identity costs one detail request, not one per copy");
  assert.equal(result.unresolvedCount, 0);
});

test("a copy already classified from a detail page classifies its siblings without another fetch", async () => {
  const products = sameProductListedTimes(3);
  const existingRows: CategoryEnrichmentProductRow[] = [
    {
      source_id: "dup-2",
      manufacturer_id: products[1].manufacturerId,
      model: "EX-1",
      title: "Example EX-1",
      category: "完全ワイヤレスイヤホン",
      primary_category_id: "btw_earphone",
      category_ids: '["btw_earphone"]',
      classification_status: "classified",
      search_aliases: "完全ワイヤレスイヤホン",
      metadata_json: JSON.stringify({
        categoryClassification: {
          version: CATEGORY_CLASSIFICATION_METADATA_VERSION,
          state: "classified",
          detailCheckedAt: "2026-08-21T10:00:00.000Z",
        },
      }),
    },
  ];

  const result = await enrichProductCategories({
    db: emptyCatalogDb(),
    adapter: adapterWithDetailBudget(20),
    products,
    existingRows,
    transport: {
      async fetchHtmlPage() {
        throw new Error("detail fetch must not run");
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-22T10:00:00Z"),
  });

  assert.deepEqual(
    result.products.map((product) => product.primaryCategoryId),
    ["btw_earphone", "btw_earphone", "btw_earphone"],
  );
  assert.equal(result.detailRequests, 0);
  assert.equal(result.cacheHits, 3);
});

test("a group whose detail check found nothing stays cached for the whole group", async () => {
  const products = sameProductListedTimes(3);
  let fetches = 0;

  const result = await enrichProductCategories({
    db: emptyCatalogDb(),
    adapter: adapterWithDetailBudget(20),
    products,
    existingRows: [],
    transport: {
      async fetchHtmlPage() {
        fetches += 1;
        return "<html><body><h1>EX-1</h1><p>中古商品です。</p></body></html>";
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-22T10:00:00Z"),
  });

  assert.equal(fetches, 1, "an unresolved identity must not be re-fetched once per copy");
  assert.deepEqual(
    result.products.map((product) => product.classificationStatus),
    ["unclassified", "unclassified", "unclassified"],
  );
  assert.deepEqual(
    result.products.map(
      (product) => product.metadata.categoryClassification.detailCheckedAt as string,
    ),
    ["2026-08-22T10:00:00.000Z", "2026-08-22T10:00:00.000Z", "2026-08-22T10:00:00.000Z"],
  );
});

test("the same listings classify the same way whatever order the crawl visits them in", async () => {
  const distinct = normalizeCatalogProduct(
    parsedProduct({
      sourceId: "other-1",
      manufacturer: "Example",
      model: "ZX-9",
      title: "Example ZX-9",
      sourceUrl: "https://www.fujiya-avic.co.jp/shop/g/gzx9/",
    }),
    fujiyaAvicPlugin.capabilities.catalog,
  );

  async function classify(products: NormalizedCatalogProduct[]) {
    const result = await enrichProductCategories({
      db: emptyCatalogDb(),
      adapter: adapterWithDetailBudget(1),
      products,
      existingRows: [],
      transport: {
        async fetchHtmlPage(url: string) {
          return url.includes("zx9")
            ? '<html><head><meta name="description" content="Example ZX-9 プリメインアンプの中古商品です。"></head><body><h1>ZX-9</h1></body></html>'
            : DETAIL_HTML;
        },
      },
      fetchOptions: detailFetchOptions(),
      now: new Date("2026-08-22T10:00:00Z"),
    });
    return new Map(
      result.products.map((product) => [product.sourceId, product.primaryCategoryId] as const),
    );
  }

  // One detail request for two identities: whichever identity the budget reaches must be the only
  // difference between the runs, and never a difference *within* an identity.
  const forward = await classify([...sameProductListedTimes(3), distinct]);
  const reversed = await classify([distinct, ...sameProductListedTimes(3)]);

  assert.equal(new Set([...forward.values()].slice(0, 3)).size, 1);
  assert.equal(new Set([...reversed.values()].slice(1)).size, 1);
});
