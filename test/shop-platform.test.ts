import test from "node:test";
import assert from "node:assert/strict";
import { availabilityFromSignals, availabilityFromText } from "../src/crawler/availability.js";
import { validateSellerProducts } from "../src/crawler/seller-facts.js";
import type { SellerProduct } from "../src/crawler/types.js";

function sellerProduct(overrides: Partial<SellerProduct> = {}): SellerProduct {
  return {
    sourceId: "123",
    sourceUrl: "https://example.com/used/123",
    title: "LUXMAN D-10X",
    rawManufacturer: "LUXMAN",
    manufacturer: "LUXMAN",
    model: "D-10X",
    rawCategory: "CD/SACD",
    category: "CD/SACDプレーヤー",
    conditionText: "中古",
    priceYen: 780000,
    stockStatus: "in_stock",
    ...overrides,
  };
}

test("availability maps contradictory seller evidence to canonical unknown", () => {
  assert.equal(availabilityFromSignals({ inStock: true }), "in_stock");
  assert.equal(availabilityFromSignals({ soldOut: true }), "sold_out");
  assert.equal(availabilityFromSignals({ inStock: true, soldOut: true }), "unknown");
  assert.equal(availabilityFromText("在庫あり / 売約済み"), "unknown");
  assert.equal(availabilityFromText("商品情報のみ"), "unknown");
});

test("seller facts require raw seller fields before catalog normalization", () => {
  const product = sellerProduct();
  assert.deepEqual(validateSellerProducts([product], { key: "example" }), [product]);

  const missingRaw = { ...product } as Record<string, unknown>;
  delete missingRaw.rawManufacturer;
  assert.throws(
    () => validateSellerProducts([missingRaw as unknown as SellerProduct], { key: "example" }),
    /rawManufacturer must be a string/,
  );
});

test("seller facts reject persistence rows and invalid canonical availability", () => {
  assert.throws(
    () =>
      validateSellerProducts(
        [{ ...sellerProduct(), shop_key: "example" } as unknown as SellerProduct],
        { key: "example" },
      ),
    /shop_key is persistence-only/,
  );
  assert.throws(
    () =>
      validateSellerProducts(
        [{ ...sellerProduct(), stockStatus: "available" } as unknown as SellerProduct],
        { key: "example" },
      ),
    /stockStatus/,
  );
});
