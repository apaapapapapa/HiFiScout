import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";

test("known manufacturer records canonical alias resolution evidence", () => {
  const product = normalizeCatalogProduct({
    title: "LUXMAN L-509Z",
    manufacturer: "ラックスマン",
    rawCategory: "プリメインアンプ",
  });

  assert.equal(product.manufacturerId, "luxman");
  assert.equal(product.metadata.manufacturerNormalization.matchedAlias, true);
});

test("unknown manufacturer fallback is explicitly unresolved for quality metrics", () => {
  const product = normalizeCatalogProduct({
    title: "Example Model X",
    manufacturer: "Example Unknown Audio",
    rawCategory: "その他",
  });

  assert.ok(product.manufacturerId);
  assert.equal(product.metadata.manufacturerNormalization.matchedAlias, false);
});
