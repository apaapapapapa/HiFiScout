import assert from "node:assert/strict";
import test from "node:test";

import { classifyCategoryEvidence } from "../src/catalog/category-classifier.js";
import {
  CATEGORY_CLASSIFICATION_METADATA_VERSION,
  normalizeCatalogProduct,
} from "../src/catalog/product-normalizer.js";
import {
  FORMUSIC_CATEGORY_MAPPING,
  FORMUSIC_CATEGORY_POLICY,
} from "../src/crawler/shops/formusic.js";
import { FUJIYA_CATEGORY_POLICY } from "../src/crawler/shops/fujiya-avic.js";
import { HIFIDO_CATEGORY_MAPPING, parseHifidoListing } from "../src/crawler/shops/hifido.js";
import { parsedProduct } from "./helpers/fixtures.js";

test("broad seller accessory evidence classifies only as the final fallback", () => {
  const broadOnly = normalizeCatalogProduct(
    parsedProduct({
      manufacturer: "Example",
      title: "Example Model-1",
      model: "Model-1",
      rawCategory: "アクセサリー",
      category: "",
    }),
    { categoryMapping: { アクセサリー: "accessory" } },
  );
  assert.equal(broadOnly.primaryCategoryId, "other_accessory");
  assert.equal(broadOnly.classificationStatus, "classified");
  assert.equal(broadOnly.classificationSource, "seller_category");

  const specificTitle = normalizeCatalogProduct(
    parsedProduct({
      manufacturer: "Example",
      title: "Example USBケーブル 1m",
      model: "USB-1",
      rawCategory: "アクセサリー",
      category: "",
    }),
    { categoryMapping: { アクセサリー: "accessory" } },
  );
  assert.equal(specificTitle.primaryCategoryId, "cable_usb");
  assert.equal(specificTitle.classificationSource, "title");
});

test("persisted supporting evidence for exact safe seller buckets is replayable", () => {
  const accessory = classifyCategoryEvidence([
    {
      categoryIds: ["other_accessory"],
      source: "seller_category",
      strength: "supporting",
      value: "アクセサリー",
    },
  ]);
  assert.equal(accessory.primaryCategoryId, "other_accessory");
  assert.equal(accessory.classificationStatus, "classified");

  const cable = classifyCategoryEvidence([
    {
      categoryIds: ["cable_other"],
      source: "seller_category",
      strength: "supporting",
      value: "ケーブル",
    },
  ]);
  assert.equal(cable.primaryCategoryId, "cable_other");
  assert.equal(cable.classificationStatus, "classified");
});

test("known mixed seller buckets stay unresolved instead of becoming fallback classifications", () => {
  const fujiya = normalizeCatalogProduct(
    parsedProduct({
      manufacturer: "LUXMAN",
      title: "LUXMAN D-10X",
      model: "D-10X",
      rawCategory: "DAP",
      category: "",
    }),
    { categoryPolicy: FUJIYA_CATEGORY_POLICY },
  );
  assert.equal(fujiya.classificationStatus, "unclassified");
  assert.equal(fujiya.primaryCategoryId, "other");

  const forMusic = normalizeCatalogProduct(
    parsedProduct({
      manufacturer: "ESOTERIC",
      title: "ESOTERIC P-03",
      model: "P-03",
      rawCategory: "cd-sacd-players",
      category: "",
    }),
    {
      categoryMapping: FORMUSIC_CATEGORY_MAPPING,
      categoryPolicy: FORMUSIC_CATEGORY_POLICY,
    },
  );
  assert.equal(forMusic.classificationStatus, "unclassified");
  assert.equal(forMusic.primaryCategoryId, "other");
});

test("Hifido recognizes supported seller categories that previously became blank", () => {
  const html = `
    <div class="list-item">
      <a id="type-26-12345-12345-00" href="/26-12345-12345-00.html">ESOTERIC P-03</a>
      <div>メーカー：ESOTERIC 定価：1,000,000円 売価：300,000円 CDトランスポート 在庫あり</div>
    </div>
    <div class="list-item">
      <a id="type-26-12345-12346-00" href="/26-12345-12346-00.html">LUXMAN E-250</a>
      <div>メーカー：LUXMAN 定価：100,000円 売価：50,000円 フォノイコライザー 在庫あり</div>
    </div>
  `;
  const parsed = parseHifidoListing(html);
  assert.equal(parsed.length, 2);
  assert.deepEqual(
    parsed.map((product) => product.rawCategory),
    ["CDトランスポート", "フォノイコライザー"],
  );
  assert.deepEqual(
    parsed.map(
      (product) =>
        normalizeCatalogProduct(product, { categoryMapping: HIFIDO_CATEGORY_MAPPING })
          .primaryCategoryId,
    ),
    ["transport", "phono_eq"],
  );
});

test("category metadata version advances so stale rows are replayable", () => {
  assert.equal(CATEGORY_CLASSIFICATION_METADATA_VERSION, 11);
});
