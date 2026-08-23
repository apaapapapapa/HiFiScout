import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { inferExplicitCategoryIds } from "../src/catalog/category-rules.js";
import {
  CATEGORY_CLASSIFICATION_METADATA_VERSION,
  normalizeCatalogProduct,
} from "../src/catalog/product-normalizer.js";
import { enrichProductCategories } from "../src/crawler/category-enricher.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { NormalizedCatalogProduct } from "../src/catalog/types.js";
import type { CategoryEnrichmentProductRow } from "../src/db/types.js";
import { detailFetchOptions, emptyCatalogDb, parsedProduct } from "./helpers/fixtures.js";

// These regressions exercise the two post-merge review findings from #270 and #271 end to end.
test("DAP accessory guard covers accessory words before the brand as well as after it", () => {
  for (const title of [
    "ケース Astell&Kern SP2000",
    "保護フィルム FiiO M23",
    "Case for HiBy R6 III",
    "Cover Cayin N7",
    "ストラップ Shanling M6 Ultra",
    "Astell&Kern SP2000用 レザーケース",
    "FiiO M23 保護フィルム",
  ]) {
    assert.notEqual(inferExplicitCategoryIds(title)[0], "dap", title);
  }

  for (const title of ["Astell&Kern SP2000", "FiiO M23", "HiBy R6 III", "Cayin N7"]) {
    assert.equal(inferExplicitCategoryIds(title)[0], "dap", title);
  }
});

const plugin = getShopPlugin("fujiya-avic");
if (!plugin) throw new Error("fujiya-avic plugin missing");
const fujiyaAvicPlugin = plugin;

function duplicateProducts(): NormalizedCatalogProduct[] {
  return ["cached-1", "cached-2"].map((sourceId) =>
    normalizeCatalogProduct(
      parsedProduct({
        sourceId,
        manufacturer: "Example",
        model: "EX-1",
        title: "Example EX-1",
        sourceUrl: `https://www.fujiya-avic.co.jp/shop/g/g${sourceId}/`,
      }),
      fujiyaAvicPlugin.capabilities.catalog,
    ),
  );
}

test("cached detail enrichment replays evidence instead of copying only the final classification", async () => {
  const products = duplicateProducts();
  const existingRows: CategoryEnrichmentProductRow[] = [
    {
      source_id: "cached-1",
      manufacturer_id: products[0].manufacturerId,
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
          evidence: [
            {
              categoryIds: ["btw_earphone"],
              source: "detail_metadata",
              strength: "strong",
              value: "Example EX-1 完全ワイヤレスイヤホンの中古商品です。",
            },
          ],
        },
      }),
    },
  ];

  const result = await enrichProductCategories({
    db: emptyCatalogDb(),
    adapter: fujiyaAvicPlugin,
    products,
    existingRows,
    transport: {
      async fetchHtmlPage() {
        throw new Error("cached evidence must avoid a detail fetch");
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-22T10:00:00Z"),
  });

  assert.equal(result.detailRequests, 0);
  assert.equal(result.cacheHits, 2);
  for (const product of result.products) {
    assert.equal(product.primaryCategoryId, "btw_earphone");
    assert.equal(product.classificationStatus, "classified");
    assert.ok(
      product.categoryEvidence.some((item) => item.source === "detail_metadata"),
      `${product.sourceId} lost the cached detail evidence`,
    );
    const metadata = product.metadata.categoryClassification;
    assert.equal(metadata.detailCheckedAt, "2026-08-21T10:00:00.000Z");
  }
});
