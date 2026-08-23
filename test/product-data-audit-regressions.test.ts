import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { normalizeCategory } from "../src/catalog/categories.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { FUJIYA_CATEGORY_POLICY } from "../src/crawler/shops/fujiya-avic.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { parsedProduct } from "./helpers/fixtures.js";

test("vacuum-tube amplifiers classify by product type rather than tube technology", () => {
  assert.equal(
    normalizeCategory({ title: "Western Electric 91E 真空管プリメインアンプ" }).primaryCategoryId,
    "integrated_amp",
  );
  assert.equal(
    normalizeCategory({ title: "OCTAVE V70 ClassA vacuum tube integrated amplifier" })
      .primaryCategoryId,
    "integrated_amp",
  );
  assert.equal(normalizeCategory({ title: "12AX7 真空管" }).primaryCategoryId, "vacuum_tube");
});

test("Fujiya broad seller buckets cannot override explicit product-type evidence", () => {
  const cable = normalizeCatalogProduct(
    parsedProduct({
      title: "ALO Audio SXC8 IEM Cable/HD800-3.5mm",
      rawCategory: "ヘッドホン",
    }),
    { categoryPolicy: FUJIYA_CATEGORY_POLICY },
  );
  const receiver = normalizeCatalogProduct(
    parsedProduct({
      title: "DENON AVR-X4700H-K",
      rawCategory: "アンプ・スピーカー・プレーヤー",
    }),
    { categoryPolicy: FUJIYA_CATEGORY_POLICY },
  );

  assert.equal(cable.primaryCategoryId, "cable_other");
  assert.equal(receiver.primaryCategoryId, "av_amp");
});

test("Osaka-ya AV merchandising bucket lets an explicit power-amplifier title win", () => {
  const plugin = getShopPlugin("osakaya");
  assert.ok(plugin);
  const product = normalizeCatalogProduct(
    parsedProduct({
      title: "marantz AMP 10 展示品特価 パワーアンプ",
      rawCategory: "av-amp",
    }),
    { categoryPolicy: plugin.capabilities.catalog?.categoryPolicy },
  );

  assert.equal(product.primaryCategoryId, "power_amp");
});
