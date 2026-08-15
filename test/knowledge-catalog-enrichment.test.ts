import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { enrichProductCategories } from "../src/crawler/category-enricher.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { asQueryableDatabase } from "./helpers/d1.js";
import { detailFetchOptions, parsedProduct } from "./helpers/fixtures.js";

const fujiyaAvicPlugin = getShopPlugin("fujiya-avic");
if (!fujiyaAvicPlugin) throw new Error("fujiya-avic plugin missing");

function catalogDb(rows: unknown[], aliases: unknown[] = []) {
  return asQueryableDatabase({
    prepare(sql: string) {
      return {
        bind() {
          return {
            async all() {
              if (sql.includes("FROM knowledge_catalog_products")) return { results: rows };
              if (sql.includes("FROM knowledge_catalog_aliases")) return { results: aliases };
              throw new Error(`unexpected query: ${sql}`);
            },
          };
        },
      };
    },
  });
}

test("verified exact catalog match classifies before seller detail enrichment", async () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      sourceId: "abc1",
      manufacturer: "Marantz",
      model: "ABC-1",
      title: "Marantz ABC-1",
      rawCategory: "DAP",
      sourceUrl: "https://example.invalid/abc1",
    }),
    fujiyaAvicPlugin.capabilities.catalog,
  );
  assert.equal(product.classificationStatus, "unclassified");

  const db = catalogDb([
    {
      id: 10,
      manufacturer_id: "marantz",
      canonical_model: "ABC-1",
      normalized_model: "ABC-1",
      canonical_name: "ABC-1 Control Amplifier",
      category_id: "pre_amp",
      is_primary: 1,
    },
  ]);
  const result = await enrichProductCategories({
    db,
    adapter: fujiyaAvicPlugin,
    products: [product],
    transport: {
      async fetchHtmlPage() {
        throw new Error("detail request must not run");
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-11T10:00:00Z"),
  });

  assert.equal(result.catalogMatches, 1);
  assert.equal(result.detailRequests, 0);
  assert.equal(result.products[0].primaryCategoryId, "pre_amp");
  assert.equal(result.products[0].classificationSource, "knowledge_catalog");
  assert.equal(result.products[0].metadata.categoryClassification.catalogProductId, 10);
  assert.equal(result.products[0].metadata.categoryClassification.catalogMatchType, "exact");
});

test("derived Marantz model aliases reuse one verified catalog classification across retailer formats", async () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      sourceId: "sacd10-other-shop",
      manufacturer: "Marantz",
      model: "SACD 10",
      title: "Marantz SACD 10",
      rawCategory: "DAP",
      sourceUrl: "https://example.invalid/sacd10",
    }),
    fujiyaAvicPlugin.capabilities.catalog,
  );
  assert.equal(product.classificationStatus, "unclassified");

  const db = catalogDb([
    {
      id: 20,
      manufacturer_id: "marantz",
      canonical_model: "SACD10/FB",
      normalized_model: "SACD10/FB",
      canonical_name: "Marantz SACD 10",
      category_id: "cd_sacd_player",
      is_primary: 1,
    },
  ]);
  const result = await enrichProductCategories({
    db,
    adapter: fujiyaAvicPlugin,
    products: [product],
    transport: {
      async fetchHtmlPage() {
        throw new Error("detail request must not run");
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-12T04:00:00Z"),
  });

  assert.equal(result.catalogMatches, 1);
  assert.equal(result.detailRequests, 0);
  assert.equal(result.products[0].primaryCategoryId, "cd_sacd_player");
  assert.equal(result.products[0].metadata.categoryClassification.catalogProductId, 20);
  assert.equal(
    result.products[0].metadata.categoryClassification.catalogMatchType,
    "derived_alias",
  );
});

test("unresolved model identity never borrows verified catalog category evidence", async () => {
  const normalized = normalizeCatalogProduct(
    parsedProduct({
      sourceId: "candidate-model",
      manufacturer: "Marantz",
      model: "ABC-1",
      title: "Marantz ABC-1",
      rawCategory: "DAP",
      sourceUrl: "https://example.invalid/candidate-model",
    }),
    fujiyaAvicPlugin.capabilities.catalog,
  );
  const product = { ...normalized, modelResolutionStatus: "candidate" as const };
  assert.equal(product.classificationStatus, "unclassified");

  const db = catalogDb([
    {
      id: 10,
      manufacturer_id: "marantz",
      canonical_model: "ABC-1",
      normalized_model: "ABC-1",
      canonical_name: "ABC-1 Control Amplifier",
      category_id: "pre_amp",
      is_primary: 1,
    },
  ]);
  const result = await enrichProductCategories({
    db,
    adapter: {
      ...fujiyaAvicPlugin,
      capabilities: { ...fujiyaAvicPlugin.capabilities, detailCategoryEvidence: undefined },
    },
    products: [product],
    transport: {
      async fetchHtmlPage() {
        throw new Error("detail request must not run");
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-15T01:00:00Z"),
  });

  assert.equal(result.catalogMatches, 0);
  assert.equal(result.products[0].classificationStatus, "unclassified");
  assert.equal(result.products[0].classificationSource, "none");
});

test("verified rows without an explicit primary category are not used for classification", async () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      sourceId: "abc1",
      manufacturer: "Marantz",
      model: "ABC-1",
      title: "Marantz ABC-1",
      rawCategory: "DAP",
    }),
    fujiyaAvicPlugin.capabilities.catalog,
  );
  const db = catalogDb([
    {
      id: 10,
      manufacturer_id: "marantz",
      canonical_model: "ABC-1",
      normalized_model: "ABC-1",
      canonical_name: "ABC-1",
      category_id: "pre_amp",
      is_primary: 0,
    },
  ]);

  const result = await enrichProductCategories({
    db,
    adapter: {
      ...fujiyaAvicPlugin,
      capabilities: { ...fujiyaAvicPlugin.capabilities, detailCategoryEvidence: undefined },
    },
    products: [product],
    transport: {
      async fetchHtmlPage() {
        throw new Error("detail request must not run");
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-11T10:00:00Z"),
  });

  assert.equal(result.catalogMatches, 0);
  assert.equal(result.products[0].classificationStatus, "unclassified");
});

test("ambiguous model aliases are not used as verified evidence", async () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      sourceId: "alias1",
      manufacturer: "Marantz",
      model: "SHARED",
      title: "Marantz SHARED",
      rawCategory: "DAP",
    }),
    fujiyaAvicPlugin.capabilities.catalog,
  );

  const db = catalogDb(
    [
      {
        id: 10,
        manufacturer_id: "marantz",
        canonical_model: "ABC-1",
        normalized_model: "ABC-1",
        canonical_name: "ABC-1",
        category_id: "pre_amp",
        is_primary: 1,
      },
      {
        id: 11,
        manufacturer_id: "marantz",
        canonical_model: "ABC-2",
        normalized_model: "ABC-2",
        canonical_name: "ABC-2",
        category_id: "dac",
        is_primary: 1,
      },
    ],
    [
      { product_id: 10, normalized_alias: "SHARED" },
      { product_id: 11, normalized_alias: "SHARED" },
    ],
  );

  const result = await enrichProductCategories({
    db,
    adapter: {
      ...fujiyaAvicPlugin,
      capabilities: { ...fujiyaAvicPlugin.capabilities, detailCategoryEvidence: undefined },
    },
    products: [product],
    transport: {
      async fetchHtmlPage() {
        throw new Error("detail request must not run");
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-08-11T10:00:00Z"),
  });

  assert.equal(result.catalogMatches, 0);
  assert.equal(result.products[0].classificationStatus, "unclassified");
});
